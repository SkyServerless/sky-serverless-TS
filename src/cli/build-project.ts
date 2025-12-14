import path from "node:path";
import { BuildResult } from "./model";
import { ensureDirectory, loadSkyConfig, pathExists, resolveEntryPath } from "./utils";
import { promises as fsp } from "node:fs";
import { spawn } from "node:child_process";

export async function buildProject(options: {
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

function normalizeRelativePath(entry: string): string {
  const normalized = entry.startsWith("./") ? entry.slice(2) : entry;
  return normalized.replace(/\\/g, "/");
}

function replaceExtension(filePath: string, extension: string): string {
  return filePath.replace(/\.(ts|tsx|js|jsx)$/, extension);
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

function findDefaultTsconfig(projectRoot: string): string {
  return path.join(projectRoot, "tsconfig.json");
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