import packageJson from "../../package.json";
import { handleNewCommand } from "./commands/new";
import {  logError } from "./utils";
import { handleDevCommand } from "./commands/dev";
import { handleBuildCommand } from "./commands/build";
import { handleDeployCommand } from "./commands/deploy";
import { handlePluginCommand } from "./commands/plugin";
import { handleRemoveCommand } from "./commands/remove";

export const CLI_VERSION = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
export const ROOT_DEP_VERSIONS = extractDependencyVersions();

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    printGlobalHelp();
    return;
  }

  if (args[0] === "--version" || args[0] === "-v") {
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
    case "remove":
      await handleRemoveCommand(rest);
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
  remove [--provider]    Delete a deployed service

Options:
  -h, --help             Show this help
  -v, --version          Show CLI version
`);
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
