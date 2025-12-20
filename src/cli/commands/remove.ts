import path from "node:path";
import { promises as fsp } from "node:fs";
import { loadSkyConfig, logError, logInfo, parseCommandArgs } from "../utils";
import { removeFromGcp } from "../providers/gcp";

export async function handleRemoveCommand(argv: string[]): Promise<void> {
  const { options, positionals } = parseCommandArgs(argv);
  if (options.help) {
    printRemoveHelp();
    return;
  }

  const projectRoot = process.cwd();
  const providerArg =
    (options.provider as string | undefined) ??
    (positionals[0] as string | undefined);

  let provider = providerArg;
  if (!provider) {
    try {
      const config = await loadSkyConfig(projectRoot);
      provider = config.defaultProvider ?? "local";
    } catch (error) {
      logError(
        "Provider not specified and sky.config.* could not be loaded. Pass --provider.",
      );
      logError(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
  }

  const normalizedProvider = provider.toLowerCase();

  switch (normalizedProvider) {
    case "gcp":
      await removeGcpService(options, projectRoot);
      break;
    default:
      logError(`Provider "${provider}" is not supported for removal yet.`);
      process.exitCode = 1;
  }
}

async function removeGcpService(
  options: Record<string, unknown>,
  projectRoot: string,
): Promise<void> {
  const pkgPath = path.join(projectRoot, "package.json");
  let appPkgJson: Record<string, unknown> = {};
  try {
    const rawPkg = await fsp.readFile(pkgPath, "utf-8");
    appPkgJson = JSON.parse(rawPkg) as Record<string, unknown>;
  } catch {
    logInfo("package.json not found, continuing without defaults.");
  }

  const serviceName =
    (options.name as string | undefined) ??
    process.env.npm_config_name ??
    (typeof appPkgJson.name === "string" ? appPkgJson.name : undefined);
  if (!serviceName) {
    throw new Error(
      "No service name provided. Pass --name or ensure package.json contains a name.",
    );
  }
  await removeFromGcp({
    name: serviceName,
    project:
      (options.project as string | undefined) ??
      process.env.GCP_PROJECT ??
      process.env.npm_config_project,
    region:
      (options.region as string | undefined) ??
      process.env.GCP_REGION ??
      process.env.npm_config_region,
  });
}

function printRemoveHelp(): void {
  console.log(`Usage: sky remove [provider] [--provider=gcp]

Deletes remote artifacts for a provider (Cloud Run for GCP).

Options:
  --provider <name>  Provider to remove (e.g., gcp)
  --name <name>      Service name (defaults to package.json name)
  --project <id>     GCP project ID or env GCP_PROJECT
  --region <region>  GCP region or env GCP_REGION
`);
}
