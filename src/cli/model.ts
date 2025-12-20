
export type CliOptionValue = string | boolean | undefined;

export interface ParsedArgs {
  positionals: string[];
  options: Record<string, CliOptionValue>;
}

export type DbOption = "none" | "mysql";
export type CacheOption = "none" | "redis";
export type ProviderOption = "local" | "openshift" | "gcp";

export interface SkyProjectConfig {
  name?: string;
  appEntry?: string;
  defaultProvider?: ProviderOption | string;
  providers?: Record<string, { entry: string }>;
  dev?: {
    port?: number;
    watch?: boolean;
    watchPaths?: string[];
    tsconfig?: string;
  };
  build?: {
    outDir?: string;
    tsconfig?: string;
  };
  deploy?: {
    artifactDir?: string;
  };
}

export interface BuildResult {
  provider: string;
  outDir: string;
  entrypointJs: string;
  manifestDir: string;
}