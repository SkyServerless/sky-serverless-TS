import { SkyPlugin } from "../../core/plugin";

const IOREDIS_MODULE_ID = ["io", "redis"].join("");

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode?: string,
    duration?: number,
  ): Promise<unknown>;
  del(key: string): Promise<number>;
}

export interface RedisConnectionOptions {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: boolean | Record<string, unknown>;
  keyPrefix?: string;
}

export interface RedisResolvedConfig {
  connectionString?: string;
  options?: RedisConnectionOptions;
}

export interface RedisPluginOptions {
  connectionString?: string;
  uri?: string;
  connection?: RedisConnectionOptions;
  envKey?: string;
  serviceKey?: string;
  clientFactory?: (
    config: RedisResolvedConfig,
  ) => RedisLike | Promise<RedisLike>;
}

export function redisPlugin(options: RedisPluginOptions = {}): SkyPlugin {
  const serviceKey = options.serviceKey ?? "redis";
  const envKey = options.envKey ?? "SKY_REDIS_URI";
  const resolvedConfig = resolveRedisConfig(options, envKey);
  const clientFactory = options.clientFactory ?? createDefaultRedisClient;

  let clientPromise: Promise<RedisLike> | null = null;

  async function obtainClient(): Promise<RedisLike> {
    if (!clientPromise) {
      if (!resolvedConfig) {
        throw new Error(
          `Missing Redis configuration. Provide connectionString/connection or set ${envKey}.`,
        );
      }
      clientPromise = Promise.resolve(clientFactory({ ...resolvedConfig }));
    }
    return clientPromise;
  }

  return {
    name: "@sky/redis",
    version: "0.1.0",
    async onRequest(_request, context) {
      if (!context.services[serviceKey]) {
        context.services[serviceKey] = await obtainClient();
      }
    },
  };
}

function resolveRedisConfig(
  options: RedisPluginOptions,
  envKey: string,
): RedisResolvedConfig | null {
  const connectionString =
    options.connectionString ??
    options.uri ??
    process.env[envKey] ??
    undefined;

  const optionsConfig = options.connection
    ? { ...options.connection }
    : undefined;

  if (!connectionString && !optionsConfig) {
    return null;
  }

  return {
    connectionString,
    options: optionsConfig,
  };
}

interface RedisModule {
  default?: new (
    connection?: string | RedisConnectionOptions,
    options?: RedisConnectionOptions,
  ) => RedisLike;
  Redis?: RedisModule["default"];
}

type RedisConstructor = new (
  connection?: string | RedisConnectionOptions,
  options?: RedisConnectionOptions,
) => RedisLike;

type RedisModuleLoader = () => Promise<RedisModule>;

let redisModulePromise: Promise<RedisModule> | null = null;
let redisModuleLoader: RedisModuleLoader = defaultRedisModuleLoader;

function defaultRedisModuleLoader(): Promise<RedisModule> {
  return importRedisModule(async () => {
    const mod = await import(IOREDIS_MODULE_ID);
    return mod as RedisModule;
  });
}

function importRedisModule(
  importer: () => Promise<RedisModule>,
): Promise<RedisModule> {
  return importer().catch((error) => raiseMissingRedisModule(error));
}

function raiseMissingRedisModule(error: unknown): never {
  throw Object.assign(
    new Error(
      'Package "ioredis" is required to use redisPlugin. Install it with "npm install ioredis".',
    ),
    { cause: error },
  );
}

async function loadRedisModule(): Promise<RedisModule> {
  if (!redisModulePromise) {
    redisModulePromise = redisModuleLoader().catch((error) => {
      redisModulePromise = null;
      throw error;
    });
  }
  return redisModulePromise;
}

async function createDefaultRedisClient(
  config: RedisResolvedConfig,
): Promise<RedisLike> {
  const redisModule = await loadRedisModule();
  const RedisConstructor = (
    redisModule.default ?? redisModule.Redis
  ) as RedisConstructor | undefined;
  if (!RedisConstructor) {
    throw new Error(
      "Could not resolve Redis constructor from ioredis module exports.",
    );
  }

  if (config.connectionString && config.options) {
    return new RedisConstructor(config.connectionString, config.options);
  }
  if (config.connectionString) {
    return new RedisConstructor(config.connectionString);
  }
  return new RedisConstructor(config.options);
}

export const __redisInternals = {
  resolveRedisConfig,
  async loadRedisModule(): Promise<RedisModule> {
    return loadRedisModule();
  },
  async createDefaultRedisClient(
    config: RedisResolvedConfig,
  ): Promise<RedisLike> {
    return createDefaultRedisClient(config);
  },
  setRedisModuleLoader(loader: RedisModuleLoader): void {
    redisModuleLoader = loader;
    redisModulePromise = null;
  },
  resetRedisModuleLoader(): void {
    redisModuleLoader = defaultRedisModuleLoader;
    redisModulePromise = null;
  },
  importRedisModule,
  raiseMissingRedisModule,
};
