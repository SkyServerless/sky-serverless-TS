import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { pathToFileURL } from "node:url";
import packageJson from "../../package.json";
import { App } from "../core/app";
import { startNodeHttpServer } from "../providers/node-http-adapter";

type CliOptionValue = string | boolean | undefined;

interface ParsedArgs {
  positionals: string[];
  options: Record<string, CliOptionValue>;
}

type DbOption = "none" | "mysql";
type CacheOption = "none" | "redis";
type ProviderOption = "local" | "openshift" | "gcp";

interface SkyProjectConfig {
  name?: string;
  appEntry?: string;
  defaultProvider?: ProviderOption | string;
  providers?: Record<string, { entry: string }>;
  dev?: {
    port?: number;
    watch?: boolean;
    watchPaths?: string[];
    tsconfig?: string;
  };
  build?: {
    outDir?: string;
    tsconfig?: string;
  };
  deploy?: {
    artifactDir?: string;
  };
}

interface BuildResult {
  provider: string;
  outDir: string;
  serverFile: string;
  manifestDir: string;
}

const CLI_VERSION = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
const ROOT_DEP_VERSIONS = extractDependencyVersions();

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    printGlobalHelp();
    return;
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(CLI_VERSION);
    return;
  }

  const [command, ...rest] = args;
  switch (command) {
    case "new":
      await handleNewCommand(rest);
      break;
    case "plugin":
      await handlePluginCommand(rest);
      break;
    case "dev":
      await handleDevCommand(rest);
      break;
    case "build":
      await handleBuildCommand(rest);
      break;
    case "deploy":
      await handleDeployCommand(rest);
      break;
    default:
      logError(`Unknown command "${command}".`);
      printGlobalHelp();
      process.exitCode = 1;
  }
}

void run().catch((error) => {
  logError(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function handleNewCommand(argv: string[]): Promise<void> {
  const { positionals, options } = parseCommandArgs(argv);
  if (options.help) {
    printNewHelp();
    return;
  }

  const rawName = positionals[0];
  if (!rawName) {
    logError("Project name is required. Example: sky new my-api");
    process.exitCode = 1;
    return;
  }

  const name = toKebabCase(rawName);
  const db = parseDbOption(options.db ?? "none");
  const cache = parseCacheOption(options.cache ?? "none");
  const provider = parseProviderOption(options.provider ?? "local");
  const targetDir = path.resolve(process.cwd(), options.path ? String(options.path) : name);
  const force = toBoolean(options.force);
  const shouldInstall = toBoolean(options.install);

  await ensureDirectory(targetDir);
  if (!force && !(await isDirectoryEmpty(targetDir))) {
    logError(
      `Directory "${path.relative(process.cwd(), targetDir)}" is not empty. Use --force to continue.`,
    );
    process.exitCode = 1;
    return;
  }

  await scaffoldProject({
    name,
    targetDir,
    db,
    cache,
    provider,
  });

  logInfo(`Project "${name}" created at ${targetDir}`);
  if (shouldInstall) {
    await runNpmInstall(targetDir);
  } else {
    logInfo(`Install dependencies with "cd ${name} && npm install"`);
  }
}

async function handlePluginCommand(argv: string[]): Promise<void> {
  const [subCommand, ...rest] = argv;
  if (!subCommand || subCommand === "--help" || subCommand === "-h") {
    printPluginHelp();
    return;
  }

  if (subCommand !== "new") {
    logError(`Unknown plugin command "${subCommand}".`);
    printPluginHelp();
    process.exitCode = 1;
    return;
  }

  const { positionals, options } = parseCommandArgs(rest);
  if (options.help) {
    printPluginNewHelp();
    return;
  }

  const rawName = positionals[0];
  if (!rawName) {
    logError("Plugin name is required. Example: sky plugin new auth-cookie");
    process.exitCode = 1;
    return;
  }

  const directory = path.resolve(process.cwd(), toKebabCase(rawName));
  const force = toBoolean(options.force);
  const shouldInstall = toBoolean(options.install);
  await ensureDirectory(directory);
  if (!force && !(await isDirectoryEmpty(directory))) {
    logError(
      `Directory "${path.relative(process.cwd(), directory)}" is not empty. Use --force to continue.`,
    );
    process.exitCode = 1;
    return;
  }

  await scaffoldPlugin({
    rawName,
    directory,
  });

  logInfo(`Plugin scaffold created at ${directory}`);
  if (shouldInstall) {
    await runNpmInstall(directory);
  } else {
    logInfo(`Install dependencies with "cd ${path.basename(directory)} && npm install"`);
  }
}

async function handleDevCommand(argv: string[]): Promise<void> {
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

async function handleBuildCommand(argv: string[]): Promise<void> {
  const { options } = parseCommandArgs(argv);
  if (options.help) {
    printBuildHelp();
    return;
  }
  const result = await buildProject({
    provider: options.provider as string | undefined,
    outDir: options.outDir as string | undefined,
    entryOverride: options.entry as string | undefined,
  });
  logInfo(`Build complete (${result.provider}). Output: ${result.serverFile}`);
}

async function handleDeployCommand(argv: string[]): Promise<void> {
  const { options } = parseCommandArgs(argv);
  if (options.help) {
    printDeployHelp();
    return;
  }

  const result = await buildProject({
    provider: options.provider as string | undefined,
    outDir: options.outDir as string | undefined,
    entryOverride: options.entry as string | undefined,
  });

  const artifactDir =
    (await resolveDeployDir(result.outDir, options.provider as string | undefined)) ??
    result.manifestDir;
  await ensureDirectory(artifactDir);
  const deployServer = path.join(artifactDir, "server.js");
  await fsp.copyFile(result.serverFile, deployServer);
  const manifest = {
    provider: result.provider,
    builtAt: new Date().toISOString(),
    artifact: path.relative(process.cwd(), deployServer),
  };
  const manifestPath = path.join(artifactDir, "manifest.json");
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  logInfo(
    `Deploy artifact generated for ${result.provider} at ${path.relative(process.cwd(), artifactDir)}`,
  );
}

function parseCommandArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, CliOptionValue> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    if (token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "-v") {
      options.version = true;
      continue;
    }
    if (token.startsWith("--")) {
      const [key, value] = token.slice(2).split("=", 2);
      if (value !== undefined) {
        options[key] = value;
        continue;
      }
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        options[key] = next;
        i += 1;
      } else {
        options[key] = true;
      }
      continue;
    }
    positionals.push(token);
  }

  return { positionals, options };
}

function printGlobalHelp(): void {
  console.log(`Sky CLI v${CLI_VERSION}

Usage:
  sky <command> [options]

Commands:
  new <name>             Scaffold a Sky project
  plugin new <name>      Scaffold a Sky plugin
  dev [--watch]          Run local dev server
  build [--provider]     Build provider artifact
  deploy [--provider]    Build and package deploy artifact

Options:
  -h, --help             Show this help
  -v, --version          Show CLI version
`);
}

function printNewHelp(): void {
  console.log(`Usage: sky new <name> [--db=mysql] [--cache=redis] [--provider=openshift]

Options:
  --db <name>            Database plugin (mysql)
  --cache <name>         Cache backend (redis)
  --provider <name>      Provider adapter (local, openshift, gcp)
  --force                Allow writing into non-empty directory
  --install              Run npm install after scaffolding
  --path <dir>           Override target directory
`);
}

function printPluginHelp(): void {
  console.log(`Usage:
  sky plugin new <name> [options]

Options:
  --force        Allow writing into non-empty directory
  --install      Run npm install after scaffolding
`);
}

function printPluginNewHelp(): void {
  console.log(`Usage: sky plugin new <name> [--force] [--install]`);
}

function printDevHelp(): void {
  console.log(`Usage: sky dev [--entry=src/app.ts] [--watch] [--port=3000]

Options:
  --entry <path>   Override app entry file
  --port <number>  Custom dev server port
  --watch          Restart server on file changes
`);
}

function printBuildHelp(): void {
  console.log(`Usage: sky build [--provider=openshift] [--outDir=dist]

Options:
  --provider <name>  Provider entry to compile (local, openshift, gcp)
  --entry <path>     Override provider entry file
  --outDir <path>    Output directory (default dist)
`);
}

function printDeployHelp(): void {
  console.log(`Usage: sky deploy [--provider=openshift] [--outDir=dist]

Options:
  --provider <name>  Provider entry to compile
  --entry <path>     Override provider entry file
  --outDir <path>    Output directory (default dist)
`);
}

function parseDbOption(value: CliOptionValue): DbOption {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (!normalized || normalized === "none") {
    return "none";
  }
  if (normalized === "mysql") {
    return "mysql";
  }
  throw new Error(`Unsupported database "${value}". Use mysql or none.`);
}

function parseCacheOption(value: CliOptionValue): CacheOption {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (!normalized || normalized === "none") {
    return "none";
  }
  if (normalized === "redis") {
    return "redis";
  }
  throw new Error(`Unsupported cache "${value}". Use redis or none.`);
}

function parseProviderOption(value: CliOptionValue): ProviderOption {
  const normalized = typeof value === "string" ? value.toLowerCase() : "local";
  if (normalized === "local" || normalized === "openshift" || normalized === "gcp") {
    return normalized;
  }
  throw new Error(`Unsupported provider "${value}". Use local, openshift, or gcp.`);
}

async function scaffoldProject(options: {
  name: string;
  targetDir: string;
  db: DbOption;
  cache: CacheOption;
  provider: ProviderOption;
}): Promise<void> {
  const projectFiles: Array<{ relativePath: string; contents: string }> = [];
  projectFiles.push({
    relativePath: "package.json",
    contents: createProjectPackageJson(options.name, options.provider),
  });
  projectFiles.push({
    relativePath: "tsconfig.json",
    contents: createProjectTsconfig(),
  });
  projectFiles.push({
    relativePath: "sky.config.json",
    contents: createSkyConfig(options.name, options.provider),
  });
  projectFiles.push({
    relativePath: ".gitignore",
    contents: createGitignore(),
  });
  projectFiles.push({
    relativePath: "README.md",
    contents: createProjectReadme(options.name),
  });
  projectFiles.push({
    relativePath: "src/app.ts",
    contents: createAppSource(options.db, options.cache),
  });

  projectFiles.push({
    relativePath: "src/providers/local.ts",
    contents: createProviderEntrySource("local"),
  });
  if (options.provider === "openshift") {
    projectFiles.push({
      relativePath: "src/providers/openshift.ts",
      contents: createProviderEntrySource("openshift"),
    });
  }
  if (options.provider === "gcp") {
    projectFiles.push({
      relativePath: "src/providers/gcp.ts",
      contents: createProviderEntrySource("gcp"),
    });
  }

  for (const file of projectFiles) {
    const fullPath = path.join(options.targetDir, file.relativePath);
    await writeFile(fullPath, file.contents);
  }
}

async function scaffoldPlugin(options: { rawName: string; directory: string }): Promise<void> {
  const packageName = normalizePluginPackageName(options.rawName);
  const files: Array<{ relativePath: string; contents: string }> = [
    { relativePath: "package.json", contents: createPluginPackageJson(packageName) },
    { relativePath: "tsconfig.json", contents: createPluginTsconfig() },
    { relativePath: "README.md", contents: createPluginReadme(packageName) },
    { relativePath: ".gitignore", contents: createGitignore() },
    { relativePath: "src/index.ts", contents: createPluginSource(packageName) },
  ];

  for (const file of files) {
    await writeFile(path.join(options.directory, file.relativePath), file.contents);
  }
}

async function loadSkyConfig(projectRoot: string): Promise<SkyProjectConfig> {
  const candidates = ["sky.config.ts", "sky.config.js", "sky.config.json"];
  for (const candidate of candidates) {
    const fullPath = path.join(projectRoot, candidate);
    if (!(await pathExists(fullPath))) {
      continue;
    }
    if (candidate.endsWith(".json")) {
      const raw = await fsp.readFile(fullPath, "utf8");
      return JSON.parse(raw) as SkyProjectConfig;
    }
    const moduleUrl = pathToFileURL(fullPath).href + `?v=${Date.now()}`;
    const imported = await import(moduleUrl);
    const config = (imported.default ?? imported) as SkyProjectConfig;
    if (!config || typeof config !== "object") {
      throw new Error(`sky.config file must export an object.`);
    }
    return config;
  }
  throw new Error(
    "sky.config.json (or .ts) not found. Run this command inside a Sky project or create the config file.",
  );
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
        'Install dependencies inside the generated project (e.g. "npm install" or "npm link sky-serverless-ts && npm install").';
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

async function buildProject(options: {
  provider?: string;
  outDir?: string;
  entryOverride?: string;
}): Promise<BuildResult> {
  const projectRoot = process.cwd();
  const config = await loadSkyConfig(projectRoot);
  const provider =
    (options.provider as string | undefined) ??
    config.defaultProvider ??
    Object.keys(config.providers ?? { local: null })[0] ??
    "local";
  const providerEntry =
    options.entryOverride ??
    config.providers?.[provider]?.entry ??
    config.providers?.[config.defaultProvider ?? "local"]?.entry ??
    "./src/providers/local.ts";
  const outDir = path.resolve(projectRoot, options.outDir ?? config.build?.outDir ?? "dist");
  const tsconfig = config.build?.tsconfig;

  const relativeEntry = normalizeRelativePath(providerEntry);
  const resolvedEntry = resolveEntryPath(projectRoot, relativeEntry);
  if (!(await pathExists(resolvedEntry))) {
    throw new Error(`Provider entry ${providerEntry} does not exist.`);
  }
  await compileTypescript({
    projectRoot,
    outDir,
    tsconfigPath: tsconfig ? path.resolve(projectRoot, tsconfig) : undefined,
  });

  const compiledEntry = replaceExtension(path.join(outDir, relativeEntry), ".js");
  if (!(await pathExists(compiledEntry))) {
    throw new Error(`Compiled entry ${compiledEntry} was not generated.`);
  }
  const serverFile = path.join(outDir, "server.js");
  await ensureDirectory(path.dirname(serverFile));
  await fsp.copyFile(compiledEntry, serverFile);

  return {
    provider,
    outDir,
    serverFile,
    manifestDir: path.join(outDir, "deploy", provider),
  };
}

async function compileTypescript(options: {
  projectRoot: string;
  tsconfigPath?: string;
  outDir: string;
}): Promise<void> {
  if (!(await pathExists(options.outDir))) {
    await ensureDirectory(options.outDir);
  }
  const tsconfigPath =
    options.tsconfigPath ??
    findDefaultTsconfig(options.projectRoot);
  if (!(await pathExists(tsconfigPath))) {
    throw new Error(
      `tsconfig not found at ${tsconfigPath}. Provide build.tsconfig in sky.config.json.`,
    );
  }
  const tscBin = await resolveProjectBin("typescript", "tsc", options.projectRoot);
  const args = ["-p", tsconfigPath, "--outDir", options.outDir];
  await runNodeScript(tscBin, args, options.projectRoot);
}

async function resolveDeployDir(outDir: string, provider?: string): Promise<string | null> {
  const configPath = path.join(process.cwd(), "sky.config.json");
  if (!(await pathExists(configPath))) {
    return null;
  }
  const config = await loadSkyConfig(process.cwd());
  const root = config.deploy?.artifactDir ?? path.join(outDir, "deploy");
  const targetProvider = provider ?? config.defaultProvider ?? "local";
  return path.resolve(root, targetProvider);
}

function createProjectPackageJson(name: string, provider: ProviderOption): string {
  const sanitizedName = toKebabCase(name);
  const defaultProvider = provider;
  return JSON.stringify(
    {
      name: sanitizedName,
      version: "0.1.0",
      private: true,
      type: "commonjs",
      scripts: {
        dev: "sky dev --watch",
        build: "sky build",
        deploy: `sky deploy --provider=${defaultProvider}`,
      },
      dependencies: {
        "sky-serverless-ts": `^${CLI_VERSION}`,
      },
      devDependencies: {
        typescript: ROOT_DEP_VERSIONS.typescript ?? "^5.4.5",
        "ts-node": ROOT_DEP_VERSIONS["ts-node"] ?? "^10.9.2",
      },
    },
    null,
    2,
  );
}

function createProjectTsconfig(): string {
  return `{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src"]
}
`;
}

function createSkyConfig(projectName: string, provider: ProviderOption): string {
  const providers: Record<string, { entry: string }> = {
    local: { entry: "./src/providers/local.ts" },
  };
  if (provider === "openshift") {
    providers.openshift = { entry: "./src/providers/openshift.ts" };
  }
  if (provider === "gcp") {
    providers.gcp = { entry: "./src/providers/gcp.ts" };
  }
  return JSON.stringify(
    {
      name: projectName,
      appEntry: "./src/app.ts",
      defaultProvider: provider,
      providers,
      dev: {
        port: 3000,
        watchPaths: ["src"],
      },
      build: {
        outDir: "dist",
        tsconfig: "tsconfig.json",
      },
      deploy: {
        artifactDir: "dist/deploy",
      },
    },
    null,
    2,
  );
}

function createGitignore(): string {
  return `node_modules
dist
.env
.env.*
*.log
`;
}

function createProjectReadme(name: string): string {
  return `# ${name}

Generated with the Sky CLI.

## Available scripts

- \`npm run dev\`: start the local dev server (watch mode).
- \`npm run build\`: compile the provider entry to \`dist/server.js\`.
- \`npm run deploy\`: builds and prepares a deploy artifact for the configured provider.
`;
}

function createAppSource(db: DbOption, cache: CacheOption): string {
  const imports = new Set<string>();
  imports.add(`import { App, httpOk } from "sky-serverless-ts";`);
  const pluginLines: string[] = [];

  if (db === "mysql") {
    imports.add(
      `import { mysqlPlugin, MysqlClient } from "sky-serverless-ts";`,
    );
    pluginLines.push(
      `    mysqlPlugin({ connectionString: process.env.SKY_MYSQL_URI }),`,
    );
  }

  if (cache === "redis") {
    imports.add(`import { redisPlugin, cachePlugin } from "sky-serverless-ts";`);
    pluginLines.push(`    redisPlugin({ connectionString: process.env.SKY_REDIS_URI }),`);
    pluginLines.push(`    cachePlugin({ keyPrefix: "sky-cache" }),`);
  }

  const pluginBlock = pluginLines.length
    ? `plugins: [
${pluginLines.join("\n")}
  ],`
    : "";

  const dbRoute =
    db === "mysql"
      ? `
  app.get("/db/ping", async (_req, ctx) => {
    const mysql = ctx.services.mysql as MysqlClient;
    const rows = await mysql.query<{ result: number }>("select 1 + 1 as result");
    return httpOk({ result: rows[0]?.result ?? 0 });
  });
`
      : "";

  const cacheRoute =
    cache === "redis"
      ? `
  app.get("/cache/ping", async (_req, ctx) => {
    const cacheHelper = ctx.services.cache;
    await cacheHelper?.set("ping", Date.now(), 5);
    return httpOk({ cachedAt: await cacheHelper?.get<number>("ping") });
  });
`
      : "";

  return `${Array.from(imports).join("\n")}

export function createApp(): App {
  const app = new App({
${pluginBlock}
  });

  app.get("/hello", () => {
    return httpOk({ message: "Hello from Sky" });
  });

  app.get("/health", () => httpOk({ status: "ok" }));
${dbRoute}${cacheRoute}
  return app;
}
`;
}

function createProviderEntrySource(provider: ProviderOption): string {
  if (provider === "local") {
    return `import { createHttpHandler, createNodeHttpAdapter, startNodeHttpServer } from "sky-serverless-ts";
import { createApp } from "../app";

const app = createApp();
const adapter = createNodeHttpAdapter({ providerName: "local-dev" });
export const handler = createHttpHandler(adapter, app);

export function start() {
  const port = Number(process.env.PORT ?? process.env.SKY_DEV_PORT ?? 3000);
  return startNodeHttpServer(app, { port });
}

if (require.main === module) {
  start();
}
`;
  }

  if (provider === "openshift") {
    return `import { createHttpHandler, OpenShiftProviderAdapter } from "sky-serverless-ts";
import { createApp } from "../app";

const adapter = new OpenShiftProviderAdapter();
const app = createApp();
export const handler = createHttpHandler(adapter, app);
export default handler;
`;
  }

  return `import { createHttpHandler, GcpFunctionsProviderAdapter } from "sky-serverless-ts";
import { createApp } from "../app";

const adapter = new GcpFunctionsProviderAdapter();
const app = createApp();
export const handler = createHttpHandler(adapter, app);
export default handler;
`;
}

function createPluginPackageJson(packageName: string): string {
  return JSON.stringify(
    {
      name: packageName,
      version: "0.1.0",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      scripts: {
        build: "tsc -p tsconfig.json",
        dev: "tsc -w -p tsconfig.json",
      },
      peerDependencies: {
        "sky-serverless-ts": `^${CLI_VERSION}`,
      },
      devDependencies: {
        "sky-serverless-ts": `^${CLI_VERSION}`,
        typescript: ROOT_DEP_VERSIONS.typescript ?? "^5.4.5",
      },
    },
    null,
    2,
  );
}

function createPluginTsconfig(): string {
  return `{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "declaration": true,
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
`;
}

function createPluginReadme(packageName: string): string {
  return `# ${packageName}

Generated with the Sky CLI.

## Usage

\`\`\`ts
import { App } from "sky-serverless-ts";
import { createPlugin } from "${packageName}";

const app = new App({
  plugins: [
    createPlugin({
      greeting: "Hello from ${packageName}",
    }),
  ],
});
\`\`\`
`;
}

function createPluginSource(packageName: string): string {
  const functionName = toPascalCase(packageName.replace(/^@[^/]+\//, ""));
  return `import type { SkyPlugin } from "sky-serverless-ts";

export interface ${functionName}PluginOptions {
  greeting?: string;
}

export function create${functionName}Plugin(
  options: ${functionName}PluginOptions = {},
): SkyPlugin {
  const greeting = options.greeting ?? "Hello from ${packageName}";
  return {
    name: "${packageName}",
    version: "0.1.0",
    async setup() {
      console.log("[${packageName}] setup complete");
    },
    async onRequest(_request, context) {
      context.meta ??= {};
      context.meta["${packageName}"] = greeting;
    },
  };
}
`;
}

async function ensureDirectory(targetDir: string): Promise<void> {
  await fsp.mkdir(targetDir, { recursive: true });
}

async function isDirectoryEmpty(targetDir: string): Promise<boolean> {
  try {
    const files = await fsp.readdir(targetDir);
    return files.length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

async function writeFile(fullPath: string, contents: string): Promise<void> {
  await ensureDirectory(path.dirname(fullPath));
  await fsp.writeFile(fullPath, contents);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

function resolveEntryPath(projectRoot: string, entry: string): string {
  if (path.isAbsolute(entry)) {
    return entry;
  }
  return path.resolve(projectRoot, entry);
}

function normalizeRelativePath(entry: string): string {
  const normalized = entry.startsWith("./") ? entry.slice(2) : entry;
  return normalized.replace(/\\/g, "/");
}

function replaceExtension(filePath: string, extension: string): string {
  return filePath.replace(/\.(ts|tsx|js|jsx)$/, extension);
}

async function runNpmInstall(cwd: string): Promise<void> {
  logInfo("Installing npm dependencies...");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["install"], {
      cwd,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npm install exited with code ${code}`));
      }
    });
  });
}

function toKebabCase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]/)
    .filter(Boolean)
    .map((token) => token[0]!.toUpperCase() + token.slice(1))
    .join("");
}

function normalizePluginPackageName(rawName: string): string {
  if (rawName.startsWith("@")) {
    return rawName;
  }
  return `@sky/${toKebabCase(rawName)}`;
}

function toBoolean(value: CliOptionValue): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

function logInfo(message: string): void {
  console.log(`[sky] ${message}`);
}

function logError(message: string): void {
  console.error(`[sky] ${message}`);
}

function extractDependencyVersions(): Record<string, string> {
  const result: Record<string, string> = {};
  const dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  } as Record<string, string>;
  for (const [name, version] of Object.entries(dependencies)) {
    result[name] = version;
  }
  return result;
}

function findDefaultTsconfig(projectRoot: string): string {
  return path.join(projectRoot, "tsconfig.json");
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
    message.includes("sky-serverless-ts")
  );
}

async function resolveProjectBin(
  packageName: string,
  binName: string,
  projectRoot: string,
): Promise<string> {
  try {
    const pkgPath = require.resolve(`${packageName}/package.json`, {
      paths: [projectRoot, __dirname],
    });
    const pkgJson = JSON.parse(await fsp.readFile(pkgPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    let relativeBin: string | undefined;
    if (typeof pkgJson.bin === "string") {
      relativeBin = pkgJson.bin;
    } else if (pkgJson.bin && typeof pkgJson.bin === "object") {
      relativeBin = pkgJson.bin[binName];
    }
    if (!relativeBin) {
      throw new Error(
        `Package ${packageName} does not expose a "${binName}" executable. Please reinstall it.`,
      );
    }
    return path.join(path.dirname(pkgPath), relativeBin);
  } catch (error) {
    throw new Error(
      `${packageName} is required in this project. Install it with "npm install -D ${packageName}".`,
    );
  }
}

async function runNodeScript(
  scriptPath: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${path.basename(scriptPath)} exited with code ${code}`));
      }
    });
  });
}
