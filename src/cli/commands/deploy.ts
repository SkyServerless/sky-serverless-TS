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
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { deployToGcp } from "../providers/gcp";

const exec = promisify(execCb);

export async function handleDeployCommand(argv: string[]): Promise<void> {
  const { options } = parseCommandArgs(argv);
  if (options.help) {
    printDeployHelp();
    return;
  }

  // 1. Find and pack the sky-serverless framework
  const frameworkMainPath = require.resolve("sky-serverless", {
    paths: [process.cwd(), __dirname],
  });
  const frameworkRoot = path.dirname(path.dirname(frameworkMainPath));
  const frameworkPkgJsonPath = path.join(frameworkRoot, "package.json");
  const frameworkPkgJson = JSON.parse(
    await fsp.readFile(frameworkPkgJsonPath, "utf-8"),
  );
  const tgzName = `${frameworkPkgJson.name.replace(/^@/, "").replace("/", "-")}-${frameworkPkgJson.version}.tgz`;
  const tgzSourcePath = path.join(frameworkRoot, tgzName);

  try {
    logInfo(`Packing framework from ${frameworkRoot}...`);
    await exec("npm pack", { cwd: frameworkRoot });

    if (!(await pathExists(tgzSourcePath))) {
      throw new Error(
        `Packed framework file was not found at ${tgzSourcePath}`,
      );
    }

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
    await fsp.copyFile(tgzSourcePath, path.join(artifactDir, tgzName));

    const entrypointRelative = path.relative(result.outDir, result.entrypointJs);
    const entrypointRelativePosix = entrypointRelative.split(path.sep).join("/");

    // 4. Create and prune package.json for production
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
      // Point to the packed local framework
      if (deployPkg.dependencies && typeof deployPkg.dependencies === "object") {
        (deployPkg.dependencies as Record<string, string>)["sky-serverless"] = `file:${tgzName}`;
      }
      await fsp.writeFile(
        path.join(artifactDir, "package.json"),
        JSON.stringify(deployPkg, null, 2),
      );
    }

    // 5. Generate Dockerfile and .dockerignore for GCP deployment
    if (result.provider === "gcp") {
      logInfo(`Generating Dockerfile in ${artifactDir}...`);
      const dockerfileContent = createDockerfile(tgzName, entrypointRelativePosix);
      await fsp.writeFile(path.join(artifactDir, "Dockerfile"), dockerfileContent);

      const dockerignoreContent = `
Dockerfile
node_modules
      `.trim();
      await fsp.writeFile(path.join(artifactDir, ".dockerignore"), dockerignoreContent);
    }

    // 6. Write manifest
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

    // 7. If GCP, deploy now
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
      });
    }
  } catch (err) {
    const error = err as Error;
    logError(`Deployment failed: ${error.message}`);
    if (error.stack) {
      logError(error.stack);
    }
  } finally {
    // 8. Clean up the packed file
    if (await pathExists(tgzSourcePath)) {
      logInfo(`Cleaning up ${tgzName}...`);
      await fsp.unlink(tgzSourcePath);
    }
  }
}

function createDockerfile(tgzName: string, entrypoint: string): string {
  return `
# Use an official Node.js runtime as a parent image
FROM node:24-slim

# Set the working directory to /app
WORKDIR /app

# Copy the package.json and the packed framework
COPY package.json .
COPY ${tgzName} .

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
