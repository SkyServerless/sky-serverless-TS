import { CLI_VERSION, ROOT_DEP_VERSIONS } from "..";
import { CacheOption, CliOptionValue, DbOption, ProviderOption } from "../model";
import { createGitignore, ensureDirectory, isDirectoryEmpty, logError, logInfo, parseCommandArgs, runNpmInstall, toBoolean, toKebabCase, writeFile } from "../utils";
import path from "node:path";

export async function handleNewCommand(argv: string[]): Promise<void> {
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
        "sky-serverless": `^${CLI_VERSION}`,
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

function createAppSource(db: DbOption, cache: CacheOption): string {
  const imports = new Set<string>();
  imports.add(`import { App, httpOk } from "sky-serverless";`);
  const pluginLines: string[] = [];

  if (db === "mysql") {
    imports.add(
      `import { mysqlPlugin, MysqlClient } from "sky-serverless";`,
    );
    pluginLines.push(
      `    mysqlPlugin({ connectionString: process.env.SKY_MYSQL_URI }),`,
    );
  }

  if (cache === "redis") {
    imports.add(`import { redisPlugin, cachePlugin } from "sky-serverless";`);
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
    return `import { createHttpHandler, createNodeHttpAdapter, startNodeHttpServer } from "sky-serverless";
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
    return `import { createHttpHandler, OpenShiftProviderAdapter } from "sky-serverless";
import { createApp } from "../app";

const adapter = new OpenShiftProviderAdapter();
const app = createApp();
export const handler = createHttpHandler(adapter, app);
export default handler;
`;
  }

  return `import { createHttpHandler, GcpFunctionsProviderAdapter } from "sky-serverless";
import { createApp } from "../app";

const adapter = new GcpFunctionsProviderAdapter();
const app = createApp();
export const handler = createHttpHandler(adapter, app);
export default handler;
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
