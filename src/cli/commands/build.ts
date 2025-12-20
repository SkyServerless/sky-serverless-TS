import { logInfo, parseCommandArgs } from "../utils";
import { buildProject } from "../build-project";

export async function handleBuildCommand(argv: string[]): Promise<void> {
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
  logInfo(`Build complete (${result.provider}). Output: ${result.entrypointJs}`);
}

function printBuildHelp(): void {
  console.log(`Usage: sky build [--provider=openshift] [--outDir=dist]

Options:
  --provider <name>  Provider entry to compile (local, openshift, gcp)
  --entry <path>     Override provider entry file
  --outDir <path>    Output directory (default dist)
`);
}
export { buildProject };

