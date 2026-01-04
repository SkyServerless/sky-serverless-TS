import { SkyPlugin } from "../../core/plugin";

const MSSQL_MODULE_ID = ["ms", "sql"].join("");

export interface MssqlPool {
  request(): MssqlRequest;
  close(): Promise<void>;
}

export interface MssqlRequest {
  input(name: string, typeOrValue: unknown, value?: unknown): MssqlRequest;
  query<T = unknown>(query: string): Promise<MssqlQueryResult<T>>;
}

export interface MssqlQueryResult<T> {
  recordset: T[];
}

export interface MssqlParameter {
  value: unknown;
  type?: unknown;
}

export type MssqlQueryParameters = Record<
  string,
  MssqlParameter | unknown
>;

export interface MssqlConnectionConfig {
  user?: string;
  password?: string;
  database?: string;
  server?: string;
  port?: number;
  options?: {
    encrypt?: boolean;
    trustServerCertificate?: boolean;
  };
  pool?: {
    max?: number;
    min?: number;
    idleTimeoutMillis?: number;
  };
}

export interface MssqlResolvedConfig extends MssqlConnectionConfig {
  connectionString?: string;
}

export interface MssqlClient {
  query<T = unknown>(
    sql: string,
    params?: MssqlQueryParameters,
  ): Promise<T[]>;
  getPool(): Promise<MssqlPool>;
  close(): Promise<void>;
}

export interface MssqlPluginOptions {
  connectionString?: string;
  uri?: string;
  config?: MssqlConnectionConfig;
  envKey?: string;
  serviceKey?: string;
  poolFactory?: (
    config: MssqlResolvedConfig,
  ) => MssqlPool | Promise<MssqlPool>;
}

export function mssqlPlugin(options: MssqlPluginOptions = {}): SkyPlugin {
  const serviceKey = options.serviceKey ?? "mssql";
  const envKey = options.envKey ?? "SKY_MSSQL_CONN_STR";
  const resolvedConfig = resolveMssqlConfig(options, envKey);
  const poolFactory = options.poolFactory ?? createDefaultMssqlPool;

  let poolPromise: Promise<MssqlPool> | null = null;

  async function obtainPool(): Promise<MssqlPool> {
    if (!poolPromise) {
      if (!resolvedConfig) {
        throw new Error(
          `Missing MSSQL configuration. Provide connectionString/config or set ${envKey}.`,
        );
      }
      poolPromise = Promise.resolve(poolFactory({ ...resolvedConfig }));
    }
    return poolPromise;
  }

  async function resetPool(): Promise<void> {
    if (!poolPromise) {
      return;
    }
    const pool = await poolPromise;
    await pool.close();
    poolPromise = null;
  }

  const client: MssqlClient = {
    async query<T = unknown>(
      sql: string,
      params?: MssqlQueryParameters,
    ) {
      const pool = await obtainPool();
      const request = pool.request();
      applyParameters(request, params);
      const result = await request.query<T>(sql);
      return result.recordset;
    },
    async getPool() {
      return obtainPool();
    },
    async close() {
      await resetPool();
    },
  };

  return {
    name: "@sky/mssql",
    version: "0.1.0",
    async onRequest(_request, context) {
      if (!context.services[serviceKey]) {
        context.services[serviceKey] = client;
      }
    },
  };
}

function applyParameters(
  request: MssqlRequest,
  params?: MssqlQueryParameters,
): void {
  if (!params) {
    return;
  }

  for (const [name, param] of Object.entries(params)) {
    if (isMssqlParameter(param)) {
      if (param.type !== undefined) {
        request.input(name, param.type, param.value);
      } else {
        request.input(name, param.value);
      }
    } else {
      request.input(name, param);
    }
  }
}

function isMssqlParameter(
  value: unknown,
): value is MssqlParameter {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value
  );
}

function resolveMssqlConfig(
  options: MssqlPluginOptions,
  envKey: string,
): MssqlResolvedConfig | null {
  const connectionString =
    options.connectionString ??
    options.uri ??
    process.env[envKey] ??
    undefined;

  if (connectionString) {
    return {
      ...parseMssqlConnectionString(connectionString),
      ...(options.config ?? {}),
      connectionString,
    };
  }

  if (options.config) {
    return { ...options.config };
  }

  return null;
}

/* c8 ignore start */
function parseMssqlConnectionString(uri: string): MssqlConnectionConfig {
  const trimmed = uri.trim();
  if (!trimmed) {
    return {};
  }

  if (looksLikeOdbcConnectionString(trimmed)) {
    return parseOdbcConnectionString(trimmed);
  }

  const normalized = trimmed.includes("://") ? trimmed : `mssql://${trimmed}`;
  const config: MssqlConnectionConfig = {};

  try {
    const url = new URL(normalized);

    if (url.hostname) {
      config.server = url.hostname;
    }
    if (url.port) {
      config.port = Number(url.port);
    }
    if (url.username) {
      config.user = decodeURIComponent(url.username);
    }
    if (url.password) {
      config.password = decodeURIComponent(url.password);
    }
    const database = url.pathname.replace(/^\//, "");
    if (database) {
      config.database = decodeURIComponent(database);
    }

    const encrypt = url.searchParams.get("encrypt");
    if (encrypt) {
      config.options ??= {};
      config.options.encrypt = encrypt === "true";
    }

    const trust = url.searchParams.get("trustServerCertificate");
    if (trust) {
      config.options ??= {};
      config.options.trustServerCertificate = trust === "true";
    }
  } catch {
    return {};
  }

  return config;
}

function looksLikeOdbcConnectionString(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes("server=") || lower.includes("data source=");
}

function parseOdbcConnectionString(
  value: string,
): MssqlConnectionConfig {
  const config: MssqlConnectionConfig = {};
  const parts = value
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    const index = part.indexOf("=");
    if (index <= 0) {
      continue;
    }

    const key = part.slice(0, index).trim().toLowerCase();
    const rawValue = part.slice(index + 1).trim();
    if (!rawValue) {
      continue;
    }

    switch (key) {
      case "server":
      case "data source":
      case "addr":
      case "address":
      case "network address": {
        const { server, port } = parseServerValue(rawValue);
        if (server) {
          config.server = server;
        }
        if (port !== undefined) {
          config.port = port;
        }
        break;
      }
      case "database":
      case "initial catalog":
        config.database = rawValue;
        break;
      case "user id":
      case "uid":
      case "user":
      case "username":
        config.user = rawValue;
        break;
      case "password":
      case "pwd":
        config.password = rawValue;
        break;
      case "port": {
        const parsed = Number(rawValue);
        if (Number.isFinite(parsed)) {
          config.port = parsed;
        }
        break;
      }
      case "encrypt": {
        const parsed = parseBoolean(rawValue);
        if (parsed !== undefined) {
          config.options ??= {};
          config.options.encrypt = parsed;
        }
        break;
      }
      case "trustservercertificate": {
        const parsed = parseBoolean(rawValue);
        if (parsed !== undefined) {
          config.options ??= {};
          config.options.trustServerCertificate = parsed;
        }
        break;
      }
      default:
        break;
    }
  }

  return config;
}

function parseServerValue(
  rawValue: string,
): { server?: string; port?: number } {
  let value = rawValue.trim();
  const lower = value.toLowerCase();
  if (lower.startsWith("tcp:")) {
    value = value.slice(4);
  } else if (lower.startsWith("np:")) {
    value = value.slice(3);
  }

  let serverPart = value;
  let portPart: string | undefined;

  const commaIndex = value.indexOf(",");
  if (commaIndex >= 0) {
    serverPart = value.slice(0, commaIndex);
    portPart = value.slice(commaIndex + 1);
  }

  const instanceSplit = serverPart.split("\\");
  let server = instanceSplit[0]?.trim();
  if (!server) {
    return {};
  }
  const normalized = server.toLowerCase();
  if (
    normalized === "." ||
    normalized === "(local)" ||
    normalized === "(localdb)"
  ) {
    server = "localhost";
  }

  let port: number | undefined;
  if (portPart) {
    const parsed = Number(portPart.trim());
    if (Number.isFinite(parsed)) {
      port = parsed;
    }
  }

  return { server, port };
}

function parseBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n"].includes(normalized)) {
    return false;
  }
  return undefined;
}
/* c8 ignore stop */

interface MssqlModule {
  ConnectionPool: new (
    config: MssqlConnectionConfig | string,
  ) => {
    connect(): Promise<MssqlPool>;
  };
}

type MssqlModuleLoader = () => Promise<MssqlModule>;

let mssqlModulePromise: Promise<MssqlModule> | null = null;
let mssqlModuleLoader: MssqlModuleLoader = defaultMssqlModuleLoader;

function defaultMssqlModuleLoader(): Promise<MssqlModule> {
  return importMssqlModule(async () => {
    const mod = await import(MSSQL_MODULE_ID);
    return mod as MssqlModule;
  });
}

function importMssqlModule(
  importer: () => Promise<MssqlModule>,
): Promise<MssqlModule> {
  return importer().catch((error) => raiseMissingMssqlModule(error));
}

function raiseMissingMssqlModule(error: unknown): never {
  throw Object.assign(
    new Error(
      'Package "mssql" is required to use mssqlPlugin. Install it with "npm install mssql".',
    ),
    { cause: error },
  );
}

async function loadMssqlModule(): Promise<MssqlModule> {
  if (!mssqlModulePromise) {
    mssqlModulePromise = mssqlModuleLoader().catch((error) => {
      mssqlModulePromise = null;
      throw error;
    });
  }

  return mssqlModulePromise;
}

async function createDefaultMssqlPool(
  config: MssqlResolvedConfig,
): Promise<MssqlPool> {
  const mssql = await loadMssqlModule();
  if (config.connectionString) {
    const pool = new mssql.ConnectionPool(config.connectionString);
    return pool.connect();
  }
  const pool = new mssql.ConnectionPool(config);
  return pool.connect();
}

export const __mssqlInternals = {
  parseMssqlConnectionString,
  resolveMssqlConfig,
  async loadMssqlModule(): Promise<MssqlModule> {
    return loadMssqlModule();
  },
  async createDefaultMssqlPool(
    config: MssqlResolvedConfig,
  ): Promise<MssqlPool> {
    return createDefaultMssqlPool(config);
  },
  setMssqlModuleLoader(loader: MssqlModuleLoader): void {
    mssqlModuleLoader = loader;
    mssqlModulePromise = null;
  },
  resetMssqlModuleLoader(): void {
    mssqlModuleLoader = defaultMssqlModuleLoader;
    mssqlModulePromise = null;
  },
  importMssqlModule,
  raiseMissingMssqlModule,
};
