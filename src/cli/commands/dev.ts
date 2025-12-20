import path from "node:path";
import { loadSkyConfig, logError, logInfo, parseCommandArgs, resolveEntryPath, toBoolean } from "../utils";
import http from "node:http";
import net from "node:net";
import { startNodeHttpServer } from "../../../src/providers/node-http-adapter";
import fs from "node:fs";
import { App } from "../../core/app";
import chokidar from "chokidar";

export async function handleDevCommand(argv: string[]): Promise<void> {
  const { options } = parseCommandArgs(argv);
  if (options.help) {
    printDevHelp();
    return;
  }
  const projectRoot = process.cwd();
  const config = await loadSkyConfig(projectRoot);
  await registerTsNode(projectRoot, config.dev?.tsconfig ?? config.build?.tsconfig);
  const entryPath = resolveEntryPath(
    projectRoot,
    (options.entry as string | undefined) ?? config.appEntry ?? "./src/app.ts",
  );
  const watchEnabled = toBoolean(options.watch);
  const port = options.port
    ? Number(options.port)
    : config.dev?.port ?? Number(process.env.SKY_DEV_PORT ?? 3000);
  if (!Number.isFinite(port)) {
    throw new Error("Invalid port provided to sky dev.");
  }

  logInfo(`Starting dev server using ${path.relative(projectRoot, entryPath)}`);
  let server: http.Server | null = null;
  let serverSockets = new Set<net.Socket>();
  let shuttingDown = false;
  let restarting = false;
  let restartQueued = false;

  const startServer = async () => {
    try {
      const app = await loadApp(entryPath, projectRoot);
      server = startNodeHttpServer(app, {
        port,
        logger: (message) => logInfo(message),
      });
      serverSockets = new Set();
      server.on("connection", (socket) => {
        serverSockets.add(socket);
        socket.on("close", () => {
          serverSockets.delete(socket);
        });
      });
      logInfo("Dev server ready.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logError(`Failed to start dev server: ${reason}`);
    }
  };

  const stopServer = async () => {
    if (!server) {
      return;
    }
    logInfo("Stopping dev server...");
    for (const socket of serverSockets) {
      socket.destroy();
    }
    serverSockets.clear();
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    server = null;
    logInfo("Dev server stopped.");
  };

  const restartServer = async () => {
    if (restarting || shuttingDown) {
      restartQueued = true;
      return;
    }
    restarting = true;
    do {
      restartQueued = false;
      logInfo("Detected change. Restarting dev server...");
      await stopServer();
      await startServer();
    } while (restartQueued && !shuttingDown);
    restarting = false;
  };

  await startServer();

  const cleanups: Array<() => Promise<void> | void> = [];
  if (watchEnabled || config.dev?.watch) {
    const watchTargets = config.dev?.watchPaths?.length
      ? config.dev.watchPaths
      : ["src"];
    const watchPaths = watchTargets.map((target) => path.resolve(projectRoot, target));
    const watcher = createWatcher(watchPaths, async () => {
      await restartServer();
    });
    cleanups.push(async () => watcher.close());
    logInfo(`Watching ${watchPaths.map((p) => path.relative(projectRoot, p)).join(", ")}`);
  }

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await stopServer();
    for (const cleanup of cleanups) {
      await cleanup();
    }
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}



function printDevHelp(): void {
  console.log(`Usage: sky dev [--entry=src/app.ts] [--watch] [--port=3000]

Options:
  --entry <path>   Override app entry file
  --port <number>  Custom dev server port
  --watch          Restart server on file changes
`);
}

async function registerTsNode(projectRoot: string, tsconfigPath?: string): Promise<void> {
  const resolved = resolveProjectModule("ts-node", projectRoot);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const tsNode = require(resolved);
  if (typeof tsNode.register !== "function") {
    throw new Error(
      "ts-node is required to run TypeScript entry points. Install it with `npm install -D ts-node`.",
    );
  }
  tsNode.register({
    transpileOnly: true,
    project: tsconfigPath ? path.resolve(projectRoot, tsconfigPath) : undefined,
    cwd: projectRoot,
  });
}

function resolveProjectModule(moduleName: string, projectRoot: string): string {
  try {
    return require.resolve(moduleName, { paths: [projectRoot, __dirname] });
  } catch {
    throw new Error(
      `${moduleName} is required in this project. Install it with "npm install -D ${moduleName}".`,
    );
  }
}


function createWatcher(pathsToWatch: string[], onChange: () => void) {
  const watchTargets = pathsToWatch.filter((watchPath) => fs.existsSync(watchPath));
  const handler = debounce(onChange, 200);
  const watcher = chokidar.watch(watchTargets, {
    ignoreInitial: true,
    ignored: [/[\\/]node_modules[\\/]/, /[\\/]\.git[\\/]/],
  });
  watcher.on("add", handler);
  watcher.on("change", handler);
  watcher.on("unlink", handler);
  watcher.on("addDir", handler);
  watcher.on("unlinkDir", handler);

  return {
    close() {
      return watcher.close();
    },
  };
}

function debounce(fn: () => void, delayMs: number) {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, delayMs);
  };
}


async function loadApp(entryPath: string, projectRoot: string): Promise<App> {
  const absoluteEntry = path.resolve(entryPath);
  purgeRequireCache(absoluteEntry, projectRoot);
  let imported: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    imported = require(absoluteEntry);
  } catch (error) {
    if (isMissingSkyModuleError(error)) {
      const hint =
        'Install dependencies inside the generated project (e.g. "npm install" or "npm link sky-serverless && npm install").';
      throw new Error(`${(error as Error).message}\n${hint}`);
    }
    throw error;
  }
  const factory =
    (typeof (imported as Record<string, unknown>).createApp === "function" &&
      (imported as Record<string, () => App>).createApp) ||
    (typeof (imported as Record<string, unknown>).default === "function" &&
      ((imported as Record<string, () => App>).default as () => App)) ||
    (typeof (imported as Record<string, { createApp?: () => App }>).default?.createApp ===
      "function" &&
      (imported as Record<string, { createApp?: () => App }>).default.createApp) ||
    (typeof (imported as Record<string, { app?: App }>).app === "object" &&
      (() => (imported as Record<string, { app?: App }>).app)) ||
    (typeof (imported as Record<string, { default?: App }>).default === "object" &&
      (() => (imported as Record<string, { default?: App }>).default));

  if (!factory) {
    throw new Error(
      `Entry file ${entryPath} must export a createApp() function or default App instance.`,
    );
  }

  const app = (await factory()) as App;
  if (!app || typeof app.handle !== "function") {
    throw new Error("createApp() must return an App instance.");
  }
  return app;
}

function purgeRequireCache(modulePath: string, projectRoot?: string): void {
  try {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
  } catch {
    // Ignore cache purge errors
  }
  if (!projectRoot) {
    return;
  }

  const normalizedRoot = path.resolve(projectRoot);
  const rootKey =
    process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
  const rootPrefix = rootKey.endsWith(path.sep) ? rootKey : `${rootKey}${path.sep}`;
  const nodeModulesSegment = `${path.sep}node_modules${path.sep}`;

  for (const cacheKey of Object.keys(require.cache)) {
    const normalizedKey = path.normalize(cacheKey);
    const comparableKey =
      process.platform === "win32" ? normalizedKey.toLowerCase() : normalizedKey;
    if (!comparableKey.startsWith(rootPrefix)) {
      continue;
    }
    if (comparableKey.includes(nodeModulesSegment)) {
      continue;
    }
    delete require.cache[cacheKey];
  }
}

function isMissingSkyModuleError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const message = (error as Error).message ?? "";
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "MODULE_NOT_FOUND" &&
    typeof message === "string" &&
    message.includes("sky-serverless")
  );
}
