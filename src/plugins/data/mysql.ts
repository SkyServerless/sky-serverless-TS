import { SkyPlugin } from "../../core/plugin";

const MYSQL_MODULE_ID = ["mysql2", "promise"].join("/");

export type MysqlQueryValues =
  | Array<string | number | boolean | null | Date | Buffer>
  | Record<string, string | number | boolean | null | Date | Buffer>;

export interface MysqlPool {
  query<T = unknown>(
    sql: string,
    values?: MysqlQueryValues,
  ): Promise<[T[], unknown]>;
  end(): Promise<void>;
}

export interface MysqlPoolConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  waitForConnections?: boolean;
  connectionLimit?: number;
  queueLimit?: number;
  ssl?: unknown;
  charset?: string;
}

export interface MysqlResolvedConfig extends MysqlPoolConfig {
  connectionString?: string;
}

export interface MysqlClient {
  query<T = unknown>(
    sql: string,
    params?: MysqlQueryValues,
  ): Promise<T[]>;
  rawQuery<T = unknown>(
    sql: string,
    params?: MysqlQueryValues,
  ): Promise<[T[], unknown]>;
  getPool(): Promise<MysqlPool>;
  close(): Promise<void>;
}

export interface MysqlPluginOptions {
  connectionString?: string;
  uri?: string;
  connection?: MysqlPoolConfig;
  envKey?: string;
  serviceKey?: string;
  poolFactory?: (
    config: MysqlResolvedConfig,
  ) => MysqlPool | Promise<MysqlPool>;
}

export function mysqlPlugin(options: MysqlPluginOptions = {}): SkyPlugin {
  const serviceKey = options.serviceKey ?? "mysql";
  const envKey = options.envKey ?? "SKY_MYSQL_URI";
  const poolFactory = options.poolFactory ?? createDefaultMysqlPool;
  const resolvedConfig = resolveMysqlConfig(options, envKey);

  let poolPromise: Promise<MysqlPool> | null = null;

  async function obtainPool(): Promise<MysqlPool> {
    if (!poolPromise) {
      if (!resolvedConfig) {
        throw new Error(
          `Missing MySQL configuration. Provide connectionString/connection or set ${envKey}.`,
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
    await pool.end();
    poolPromise = null;
  }

  const client: MysqlClient = {
    async query<T = unknown>(
      sql: string,
      params?: MysqlQueryValues,
    ) {
      const [rows] = await client.rawQuery<T>(sql, params);
      return rows;
    },
    async rawQuery<T = unknown>(
      sql: string,
      params?: MysqlQueryValues,
    ) {
      const pool = await obtainPool();
      return pool.query<T>(sql, params);
    },
    async getPool() {
      return obtainPool();
    },
    async close() {
      await resetPool();
    },
  };

  return {
    name: "@sky/mysql",
    version: "0.1.0",
    async onRequest(_request, context) {
      if (!context.services[serviceKey]) {
        context.services[serviceKey] = client;
      }
    },
  };
}

function resolveMysqlConfig(
  options: MysqlPluginOptions,
  envKey: string,
): MysqlResolvedConfig | null {
  const connectionString =
    options.connectionString ??
    options.uri ??
    process.env[envKey] ??
    undefined;

  if (connectionString) {
    return {
      ...parseMysqlConnectionString(connectionString),
      ...(options.connection ?? {}),
      connectionString,
    };
  }

  if (options.connection) {
    return { ...options.connection };
  }

  return null;
}

/* c8 ignore start */
function parseMysqlConnectionString(uri: string): MysqlPoolConfig {
  const normalized = uri.includes("://") ? uri : `mysql://${uri}`;
  const url = new URL(normalized);
  const database = url.pathname.replace(/^\//, "");
  const config: MysqlPoolConfig = {};

  if (url.hostname) {
    config.host = url.hostname;
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
  if (database) {
    config.database = decodeURIComponent(database);
  }

  const waitForConnections = url.searchParams.get("waitForConnections");
  if (waitForConnections) {
    config.waitForConnections = waitForConnections === "true";
  }

  const connectionLimit = url.searchParams.get("connectionLimit");
  if (connectionLimit) {
    config.connectionLimit = Number(connectionLimit);
  }

  const queueLimit = url.searchParams.get("queueLimit");
  if (queueLimit) {
    config.queueLimit = Number(queueLimit);
  }

  const charset = url.searchParams.get("charset");
  if (charset) {
    config.charset = charset;
  }

  const ssl = url.searchParams.get("ssl");
  if (ssl) {
    if (ssl === "true") {
      config.ssl = {};
    } else if (ssl !== "false") {
      config.ssl = ssl;
    }
  }

  return config;
}
/* c8 ignore stop */

interface MysqlModule {
  createPool(config: MysqlPoolConfig | string): MysqlPool;
}

type MysqlModuleLoader = () => Promise<MysqlModule>;

let mysqlModulePromise: Promise<MysqlModule> | null = null;
let mysqlModuleLoader: MysqlModuleLoader = defaultMysqlModuleLoader;

function defaultMysqlModuleLoader(): Promise<MysqlModule> {
  return importMysqlModule(async () => {
    const mod = await import(MYSQL_MODULE_ID);
    return mod as MysqlModule;
  });
}

function importMysqlModule(
  importer: () => Promise<MysqlModule>,
): Promise<MysqlModule> {
  return importer().catch((error) => raiseMissingMysqlModule(error));
}

function raiseMissingMysqlModule(error: unknown): never {
  throw Object.assign(
    new Error(
      'Package "mysql2" is required to use mysqlPlugin. Install it with "npm install mysql2".',
    ),
    { cause: error },
  );
}

async function loadMysqlModule(): Promise<MysqlModule> {
  if (!mysqlModulePromise) {
    mysqlModulePromise = mysqlModuleLoader().catch((error) => {
      mysqlModulePromise = null;
      throw error;
    });
  }
  return mysqlModulePromise;
}

async function createDefaultMysqlPool(
  config: MysqlResolvedConfig,
): Promise<MysqlPool> {
  const mysql = await loadMysqlModule();
  const { connectionString, ...rest } = config;
  if (connectionString && objectIsEmpty(rest)) {
    return mysql.createPool(connectionString);
  }
  return mysql.createPool(rest);
}

function objectIsEmpty(value: Record<string, unknown>): boolean {
  return Object.keys(value).length === 0;
}

export const __mysqlInternals = {
  parseMysqlConnectionString,
  resolveMysqlConfig,
  objectIsEmpty,
  async loadMysqlModule(): Promise<MysqlModule> {
    return loadMysqlModule();
  },
  async createDefaultMysqlPool(
    config: MysqlResolvedConfig,
  ): Promise<MysqlPool> {
    return createDefaultMysqlPool(config);
  },
  setMysqlModuleLoader(loader: MysqlModuleLoader): void {
    mysqlModuleLoader = loader;
    mysqlModulePromise = null;
  },
  resetMysqlModuleLoader(): void {
    mysqlModuleLoader = defaultMysqlModuleLoader;
    mysqlModulePromise = null;
  },
  importMysqlModule,
  raiseMissingMysqlModule,
};
