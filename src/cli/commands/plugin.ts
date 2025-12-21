import path from "node:path";
import { createGitignore, ensureDirectory, isDirectoryEmpty, logError, logInfo, parseCommandArgs, runNpmInstall, toBoolean, toKebabCase, writeFile } from "../utils";
import { CLI_VERSION, ROOT_DEP_VERSIONS } from "..";

export async function handlePluginCommand(argv: string[]): Promise<void> {
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
    printPluginHelp();
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

export async function scaffoldPlugin(options: { rawName: string; directory: string }): Promise<void> {
  const packageName = normalizePluginPackageName(options.rawName);
  const files: Array<{ relativePath: string; contents: string }> = [
    { relativePath: "package.json", contents: createPluginPackageJson(packageName) },
    { relativePath: "tsconfig.json", contents: createPluginTsconfig() },
    { relativePath: "README.md", contents: createPluginReadme(packageName) },
    { relativePath: ".gitignore", contents: createGitignore() },
    { relativePath: "src/route-meta.ts", contents: createPluginRouteMetaSource(packageName) },
    { relativePath: "src/index.ts", contents: createPluginSource(packageName) },
  ];

  for (const file of files) {
    await writeFile(path.join(options.directory, file.relativePath), file.contents);
  }
}

function normalizePluginPackageName(rawName: string): string {
  if (rawName.startsWith("@")) {
    return rawName;
  }
  return `@sky/${toKebabCase(rawName)}`;
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
        "sky-serverless": `^${CLI_VERSION}`,
      },
      devDependencies: {
        "sky-serverless": `^${CLI_VERSION}`,
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
import { App } from "sky-serverless";
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
  return `import "./route-meta";
import type { SkyPlugin } from "sky-serverless";

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

function createPluginRouteMetaSource(packageName: string): string {
  const functionName = toPascalCase(packageName.replace(/^@[^/]+\//, ""));
  return `import type { RouteMetaExtensions } from "sky-serverless";

export interface ${functionName}RouteMeta {
  // Example:
  // auth?: { required?: boolean };
}

declare module "sky-serverless" {
  interface RouteMetaExtensions extends ${functionName}RouteMeta {}
}
`;
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]/)
    .filter(Boolean)
    .map((token) => token[0]!.toUpperCase() + token.slice(1))
    .join("");
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
