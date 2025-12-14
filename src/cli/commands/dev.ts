import path from "node:path";
import { loadSkyConfig, logError, logInfo, parseCommandArgs, resolveEntryPath, toBoolean } from "../utils";
import http from "node:http";
import { startNodeHttpServer } from "../../../src/providers/node-http-adapter";
import fs from "node:fs";
import { App } from "../../core/app";

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
  let shuttingDown = false;

  const startServer = async () => {
    try {
      const app = await loadApp(entryPath);
      server = startNodeHttpServer(app, {
        port,
        logger: (message) => logInfo(message),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logError(`Failed to start dev server: ${reason}`);
    }
  };

  const stopServer = async () => {
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    server = null;
  };

  await startServer();

  const cleanups: Array<() => Promise<void> | void> = [];
  if (watchEnabled || config.dev?.watch) {
    const watchTargets = config.dev?.watchPaths?.length
      ? config.dev.watchPaths
      : ["src"];
    const watchPaths = watchTargets.map((target) => path.resolve(projectRoot, target));
    const watcher = createWatcher(watchPaths, async () => {
      if (shuttingDown) {
        return;
      }
      logInfo("Detected change. Restarting dev server...");
      await stopServer();
      await startServer();
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
  const watchers = pathsToWatch
    .filter((watchPath) => fs.existsSync(watchPath))
    .map((watchPath) => {
      const handler = debounce(onChange, 200);
      try {
        return fs.watch(watchPath, { recursive: true }, handler);
      } catch {
        return fs.watch(watchPath, {}, handler);
      }
    });

  return {
    close() {
      for (const watcher of watchers) {
        watcher.close();
      }
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


async function loadApp(entryPath: string): Promise<App> {
  const absoluteEntry = path.resolve(entryPath);
  purgeRequireCache(absoluteEntry);
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

function purgeRequireCache(modulePath: string): void {
  try {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
  } catch {
    // Ignore cache purge errors
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
