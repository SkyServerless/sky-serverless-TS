import { CliOptionValue, ParsedArgs, SkyProjectConfig } from "./model";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { CLI_VERSION, ROOT_DEP_VERSIONS } from ".";

export function parseCommandArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, CliOptionValue> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    if (token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "-v") {
      options.version = true;
      continue;
    }
    if (token.startsWith("--")) {
      const [key, value] = token.slice(2).split("=", 2);
      if (value !== undefined) {
        options[key] = value;
        continue;
      }
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        options[key] = next;
        i += 1;
      } else {
        options[key] = true;
      }
      continue;
    }
    positionals.push(token);
  }

  return { positionals, options };
}

export function logError(message: string): void {
  console.error(`[sky] ${message}`);
}

export function toKebabCase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function writeFile(fullPath: string, contents: string): Promise<void> {
  await ensureDirectory(path.dirname(fullPath));
  await fsp.writeFile(fullPath, contents);
}

export async function ensureDirectory(targetDir: string): Promise<void> {
  await fsp.mkdir(targetDir, { recursive: true });
}

export function toBoolean(value: CliOptionValue): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

export async function isDirectoryEmpty(targetDir: string): Promise<boolean> {
  try {
    const files = await fsp.readdir(targetDir);
    return files.length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

export function logInfo(message: string): void {
  console.log(`[sky] ${message}`);
}

export async function runNpmInstall(cwd: string): Promise<void> {
  logInfo("Installing npm dependencies...");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["install"], {
      cwd,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npm install exited with code ${code}`));
      }
    });
  });
}

export async function loadSkyConfig(projectRoot: string): Promise<SkyProjectConfig> {
  const candidates = ["sky.config.ts", "sky.config.js", "sky.config.json"];
  for (const candidate of candidates) {
    const fullPath = path.join(projectRoot, candidate);
    if (!(await pathExists(fullPath))) {
      continue;
    }
    if (candidate.endsWith(".json")) {
      const raw = await fsp.readFile(fullPath, "utf8");
      return JSON.parse(raw) as SkyProjectConfig;
    }
    const moduleUrl = pathToFileURL(fullPath).href + `?v=${Date.now()}`;
    const imported = await import(moduleUrl);
    const config = (imported.default ?? imported) as SkyProjectConfig;
    if (!config || typeof config !== "object") {
      throw new Error(`sky.config file must export an object.`);
    }
    return config;
  }
  throw new Error(
    "sky.config.json (or .ts) not found. Run this command inside a Sky project or create the config file.",
  );
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

export function resolveEntryPath(projectRoot: string, entry: string): string {
  if (path.isAbsolute(entry)) {
    return entry;
  }
  return path.resolve(projectRoot, entry);
}

export function createGitignore(): string {
  return `node_modules
dist
.env
.env.*
*.log
`;
}
