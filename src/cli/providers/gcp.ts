import { spawn } from "child_process";
import { logInfo, logError } from "../utils";

export interface GcpDeployOptions {
  project?: string;
  region?: string;
  source?: string;
  name: string;
  minInstances?: number;
  maxInstances?: number;
  concurrency?: number;
  timeout?: `${number}s` | `${number}m` | `${number}h`;
  cpu?: number;
  memory?: `${number}Mi`| `${number}Gi`;
}

export interface GcpRemoveOptions {
  project?: string;
  region?: string;
  name: string;
}

export async function deployToGcp(options: GcpDeployOptions): Promise<void> {
  logInfo("Deploying to Google Cloud Run...");
  const min = options.minInstances ?? 0;
  const max = options.maxInstances;

  if (min < 0) throw new Error("minInstances deve ser >= 0");
  if (max !== undefined && max <= 0) throw new Error("maxInstances deve ser > 0");
  if (max !== undefined && min > max) throw new Error("minInstances não pode ser maior que maxInstances");

  const conc = options.concurrency ?? 80;
  if (conc < 1 || conc > 1000) throw new Error("concurrency deve estar entre 1 e 1000");

  const cpu = options.cpu ?? 1;
  if (cpu <= 0) throw new Error("cpu deve ser > 0");

  const args = [
    "run",
    "deploy",
    options.name,
    `--source=${options.source || "."}`,
    `--port=8080`,
    "--allow-unauthenticated",
    `--min-instances=${options.minInstances ?? 0}`,
    `--concurrency=${options.concurrency ?? 80}`,
    `--timeout=${options.timeout ?? "300s"}`,
    `--cpu=${options.cpu ?? 1}`,
    `--memory=${options.memory ?? "512Mi"}`
  ];

  if (options.maxInstances !== undefined) {
    args.push(`--max-instances=${options.maxInstances}`);
  }

  if (options.project) {
    args.push(`--project=${options.project}`);
  }

  if (options.region) {
    args.push(`--region=${options.region}`);
  }

  return new Promise((resolve, reject) => {
    const gcloud = spawnCommand("gcloud", args);

    gcloud.on("close", (code) => {
      if (code === 0) {
        logInfo("Deployment to Google Cloud Run finished successfully.");
        resolve();
      } else {
        logError(`gcloud deployment failed with code ${code}`);
        reject(new Error(`gcloud deployment failed with code ${code}`));
      }
    });

    gcloud.on("error", (err) => {
      logError("Failed to start gcloud process.");
      reject(err);
    });
  });
}

export async function removeFromGcp(options: GcpRemoveOptions): Promise<void> {
  logInfo("Removing Google Cloud Run service...");

  const args = [
    "run",
    "services",
    "delete",
    options.name,
    "--quiet",
  ];

  if (options.project) {
    args.push(`--project=${options.project}`);
  }

  if (options.region) {
    args.push(`--region=${options.region}`);
  }

  return new Promise((resolve, reject) => {
    const gcloud = spawnCommand("gcloud", args);

    gcloud.on("close", (code) => {
      if (code === 0) {
        logInfo("Cloud Run service deleted.");
        resolve();
      } else {
        logError(`gcloud removal failed with code ${code}`);
        reject(new Error(`gcloud removal failed with code ${code}`));
      }
    });

    gcloud.on("error", (err) => {
      logError("Failed to start gcloud process.");
      reject(err);
    });
  });
}

function spawnCommand(command: string, args: string[]) {
  if (process.platform !== "win32") {
    return spawn(command, args, { stdio: "inherit" });
  }

  const cmdArgs = ["/d", "/s", "/c", buildCmdLine(`${command}.cmd`, args)];
  return spawn("cmd.exe", cmdArgs, { stdio: "inherit" });
}

function buildCmdLine(command: string, args: string[]): string {
  return [command, ...args.map(escapeCmdArg)].join(" ");
}

function escapeCmdArg(arg: string): string {
  if (!arg.length) {
    return '""';
  }
  const needsQuotes = /[\s"]/g.test(arg);
  const escaped = arg.replace(/(["^&|<>%!()])/g, "^$1");
  return needsQuotes ? `"${escaped}"` : escaped;
}
