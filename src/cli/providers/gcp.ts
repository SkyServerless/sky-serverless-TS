import { spawn } from "child_process";
import { logInfo, logError } from "../utils";

export interface GcpDeployOptions {
  project?: string;
  region?: string;
  source?: string;
  name: string;
}

export interface GcpRemoveOptions {
  project?: string;
  region?: string;
  name: string;
}

export async function deployToGcp(options: GcpDeployOptions): Promise<void> {
  logInfo("Deploying to Google Cloud Run...");

  const args = [
    "run",
    "deploy",
    options.name,
    `--source=${options.source || "."}`,
    `--port=8080`,
    "--allow-unauthenticated",
  ];

  if (options.project) {
    args.push(`--project=${options.project}`);
  }

  if (options.region) {
    args.push(`--region=${options.region}`);
  }

  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const gcloudCmd = isWin ? "gcloud.cmd" : "gcloud";
    const gcloud = spawn(gcloudCmd, args, { stdio: "inherit", shell: isWin });

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
    const isWin = process.platform === "win32";
    const gcloudCmd = isWin ? "gcloud.cmd" : "gcloud";
    const gcloud = spawn(gcloudCmd, args, { stdio: "inherit", shell: isWin });

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
