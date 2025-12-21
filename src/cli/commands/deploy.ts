import { buildProject } from "../build-project";
import {
  ensureDirectory,
  loadSkyConfig,
  logError,
  logInfo,
  parseCommandArgs,
  pathExists,
} from "../utils";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { deployToGcp } from "../providers/gcp";
import type { CliOptionValue } from "../model";

function getOptString(
  options: Record<string, CliOptionValue>,
  key: string,
): string | undefined {
  const v = options[key];
  if (typeof v === "boolean") {
    throw new Error(`Opção --${key} precisa de um valor`);
  }
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return undefined; // ou lançar erro se você preferir
  return v;
}

function getOptNumber(
  options: Record<string, CliOptionValue>,
  key: string,
): number | undefined {
  const raw = getOptString(options, key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Option --${key} is invalid: ${raw}`);
  return n;
}

function getOptDuration(
  options: Record<string, CliOptionValue>,
  key: string,
): `${number}s` | `${number}m` | `${number}h` | undefined {
  const raw = getOptString(options, key);
  if (raw === undefined) return undefined;

  // aceita 300s, 5m, 1h
  if (!/^\d+(s|m|h)$/.test(raw)) {
    throw new Error(`Option --${key} is invalid (use ex: 300s, 5m, 1h): ${raw}`);
  }

  // garante o tipo template literal
  return raw as `${number}s` | `${number}m` | `${number}h`;
}

function getOptMemory(
  options: Record<string, CliOptionValue>,
  key: string,
): `${number}Mi` | `${number}Gi` | undefined {
  const raw = getOptString(options, key);
  if (raw === undefined) return undefined;

  // aceita 512Mi, 1024Mi, 1Gi, 2Gi, etc
  if (!/^\d+(Mi|Gi)$/.test(raw)) {
    throw new Error(`Option --${key} is invalid (use ex: 512Mi, 1Gi): ${raw}`);
  }

  return raw as `${number}Mi` | `${number}Gi`;
}

export async function handleDeployCommand(argv: string[]): Promise<void> {
  const { options } = parseCommandArgs(argv);
  if (options.help) {
    printDeployHelp();
    return;
  }

  // 1. Locate the sky-serverless framework
  const frameworkRoot = await findFrameworkRoot();

  try {
    // 2. For all providers, build locally first
    const result = await buildProject({
      provider: options.provider as string | undefined,
      outDir: options.outDir as string | undefined,
      entryOverride: options.entry as string | undefined,
    });

    const artifactDir =
      (await resolveDeployDir(result.outDir, result.provider)) ??
      result.manifestDir;
    await ensureDirectory(artifactDir);

    // 3. Copy build artifacts
    logInfo(`Copying build output from ${result.outDir} to ${artifactDir}...`);
    await fsp.cp(path.join(result.outDir, "."), artifactDir, { recursive: true });

    // 4. Copy the framework into the artifact for offline install
    const frameworkTargetPath = path.join(artifactDir, "sky-serverless");
    logInfo(`Copying framework from ${frameworkRoot} to ${frameworkTargetPath}...`);
    await fsp.cp(path.join(frameworkRoot, "."), frameworkTargetPath, { recursive: true });

    const entrypointRelative = path.relative(result.outDir, result.entrypointJs);
    const entrypointRelativePosix = entrypointRelative.split(path.sep).join("/");

    // 5. Create and prune package.json for production
    const pkgJsonPath = path.join(process.cwd(), "package.json");
    if (await pathExists(pkgJsonPath)) {
      const originalPkg = JSON.parse(await fsp.readFile(pkgJsonPath, "utf-8"));
      const deployPkg: Record<string, unknown> = {
        name: originalPkg.name,
        version: originalPkg.version,
        private: originalPkg.private ?? true,
        scripts: {
          start: `node ${entrypointRelativePosix}`,
        },
        dependencies: originalPkg.dependencies,
        main: entrypointRelativePosix,
      };
      // Point to the local framework copy
      if (deployPkg.dependencies && typeof deployPkg.dependencies === "object") {
        (deployPkg.dependencies as Record<string, string>)["sky-serverless"] = "file:sky-serverless";
      }
      await fsp.writeFile(
        path.join(artifactDir, "package.json"),
        JSON.stringify(deployPkg, null, 2),
      );
    }

    // 6. Generate Dockerfile and .dockerignore for GCP deployment
    if (result.provider === "gcp") {
      logInfo(`Generating Dockerfile in ${artifactDir}...`);
      const dockerfileContent = createDockerfile(entrypointRelativePosix);
      await fsp.writeFile(path.join(artifactDir, "Dockerfile"), dockerfileContent);

      const dockerignoreContent = `
Dockerfile
node_modules
      `.trim();
      await fsp.writeFile(path.join(artifactDir, ".dockerignore"), dockerignoreContent);
    }

    // 7. Write manifest
    const manifest = {
      provider: result.provider,
      builtAt: new Date().toISOString(),
      artifact: path.relative(process.cwd(), artifactDir),
    };
    const manifestPath = path.join(artifactDir, "manifest.json");
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    logInfo(
      `Deploy artifact generated for ${result.provider} at ${path.relative(
        process.cwd(),
        artifactDir,
      )}`,
    );

    // 8. If GCP, deploy now
    if (result.provider === "gcp") {
      const appRoot = process.cwd();
      const appPkgJson = JSON.parse(
        await fsp.readFile(path.join(appRoot, "package.json"), "utf-8"),
      );

      await deployToGcp({
        name: (options.name as string) ?? appPkgJson.name,
        project:
          (options.project as string | undefined) ??
          process.env.GCP_PROJECT ??
          process.env.npm_config_project,
        region:
          (options.region as string | undefined) ??
          process.env.GCP_REGION ??
          process.env.npm_config_region,
        source: artifactDir,
        minInstances: getOptNumber(options, "minInstances"),
        maxInstances: getOptNumber(options, "maxInstances"),
        concurrency: getOptNumber(options, "concurrency"),
        timeout: getOptDuration(options, "timeout"),
        cpu: getOptNumber(options, "cpu"),
        memory: getOptMemory(options, "memory"),
      });

    }
  } catch (err) {
    const error = err as Error;
    logError(`Deployment failed: ${error.message}`);
    if (error.stack) {
      logError(error.stack);
    }
  }
}

function createDockerfile(entrypoint: string): string {
  return `
# Use an official Node.js runtime as a parent image
FROM node:24-slim

# Set the working directory to /app
WORKDIR /app

# Copy the package.json and the framework
COPY package.json .
COPY sky-serverless ./sky-serverless

# Install any needed packages
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Make port 8080 available to the world outside this container
EXPOSE 8080

# Define the command to run your app
CMD ["node", "${entrypoint}"]
`.trim();
}

async function findFrameworkRoot(): Promise<string> {
  const candidates: string[] = [];

  try {
    const pkgPath = require.resolve("sky-serverless/package.json", {
      paths: [process.cwd()],
    });
    const resolvedRoot = path.dirname(pkgPath);
    candidates.push(resolvedRoot);
    candidates.push(path.resolve(resolvedRoot, "..", ".."));
  } catch {
    // Ignore resolve failures; we have other fallbacks below.
  }

  for (const candidate of candidates) {
    if (await isFrameworkRoot(candidate)) {
      return candidate;
    }
  }

  // Walk up from the CLI location to find the real package root.
  let current = __dirname;
  for (let i = 0; i < 8; i += 1) {
    if (await isFrameworkRoot(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new Error(
    "Sky framework dist not found. Rebuild sky-serverless before deploy.",
  );
}

async function isFrameworkRoot(root: string): Promise<boolean> {
  const pkgPath = path.join(root, "package.json");
  if (!(await pathExists(pkgPath))) {
    return false;
  }
  try {
    const pkg = JSON.parse(await fsp.readFile(pkgPath, "utf-8")) as {
      name?: string;
    };
    if (pkg.name !== "sky-serverless") {
      return false;
    }
  } catch {
    return false;
  }
  return pathExists(path.join(root, "dist", "index.js"));
}

function printDeployHelp(): void {
  console.log(`Usage: sky deploy [--provider=gcp] [...]

Options:
  --provider <name>    Provider to use for deployment (e.g., gcp, openshift)
  --entry <path>       Override provider entry file
  --outDir <path>      Output directory (default dist)
  
GCP Options:
  --name <name>        Function name (defaults to project name in package.json)
  --project <id>       GCP project ID (or env var GCP_PROJECT)
  --region <region>    GCP region (or env var GCP_REGION)
  --minInstances <n>   Minimum number of instances
  --maxInstances <n>   Maximum number of instances
  --concurrency <n>    Max concurrent requests per instance
  --timeout <duration> Request timeout (ex: 300s, 5m, 1h)
  --cpu <n>            CPU allocation (ex: 1, 2)
  --memory <size>      Memory allocation (ex: 512Mi, 1Gi)

`);
}

async function resolveDeployDir(
  outDir: string,
  provider?: string,
): Promise<string | null> {
  const configPath = path.join(process.cwd(), "sky.config.json");
  if (!(await pathExists(configPath))) {
    const root = "deploy";
    const targetProvider = provider ?? "local";
    return path.resolve(root, targetProvider);
  }
  const config = await loadSkyConfig(process.cwd());
  const root = config.deploy?.artifactDir ?? "deploy";
  const targetProvider = provider ?? config.defaultProvider ?? "local";
  return path.resolve(root, targetProvider);
}
