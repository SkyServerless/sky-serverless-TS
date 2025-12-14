import { buildProject } from "../build-project";
import { ensureDirectory, loadSkyConfig, logInfo, parseCommandArgs, pathExists } from "../utils";
import path from "node:path";
import { promises as fsp } from "node:fs";

export async function handleDeployCommand(argv: string[]): Promise<void> {
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

function printDeployHelp(): void {
  console.log(`Usage: sky deploy [--provider=openshift] [--outDir=dist]

Options:
  --provider <name>  Provider entry to compile
  --entry <path>     Override provider entry file
  --outDir <path>    Output directory (default dist)
`);
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
