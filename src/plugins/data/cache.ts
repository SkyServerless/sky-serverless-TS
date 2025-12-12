import { SkyContext } from "../../core/context";
import { SkyPlugin } from "../../core/plugin";
import { RedisLike } from "./redis";

export interface CacheHelper {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(
    key: string,
    value: T,
    ttlSeconds?: number,
  ): Promise<void>;
  del(key: string): Promise<void>;
  wrap<T>(
    key: string,
    ttlSeconds: number | undefined,
    fetcher: () => Promise<T> | T,
  ): Promise<T>;
}

export interface CachePluginOptions {
  serviceKey?: string;
  redisServiceKey?: string;
  defaultTtlSeconds?: number;
  keyPrefix?: string;
  serializer?: (value: unknown) => string;
  deserializer?: (payload: string) => unknown;
  redisClient?: RedisLike;
  getRedisClient?: (context: SkyContext) => RedisLike | Promise<RedisLike>;
}

export function cachePlugin(options: CachePluginOptions = {}): SkyPlugin {
  const serviceKey = options.serviceKey ?? "cache";
  const redisServiceKey = options.redisServiceKey ?? "redis";
  const serializer = options.serializer ?? defaultSerializer;
  const deserializer = options.deserializer ?? defaultDeserializer;
  const defaultTtl = options.defaultTtlSeconds;

  return {
    name: "@sky/cache",
    version: "0.1.0",
    async onRequest(_request, context) {
      if (context.services[serviceKey]) {
        return;
      }

      const redis =
        options.redisClient ??
        (await options.getRedisClient?.(context)) ??
        (context.services[redisServiceKey] as RedisLike | undefined);

      if (!redis) {
        throw new Error(
          `Redis service "${redisServiceKey}" not found for cachePlugin.`,
        );
      }

      context.services[serviceKey] = createCacheHelper({
        redis,
        keyPrefix: options.keyPrefix,
        serializer,
        deserializer,
        defaultTtl,
      });
    },
  };
}

interface CacheHelperFactoryOptions {
  redis: RedisLike;
  keyPrefix?: string;
  serializer: (value: unknown) => string;
  deserializer: (value: string) => unknown;
  defaultTtl?: number;
}

function createCacheHelper(options: CacheHelperFactoryOptions): CacheHelper {
  const normalizedPrefix =
    options.keyPrefix && !options.keyPrefix.endsWith(":")
      ? `${options.keyPrefix}:`
      : options.keyPrefix;
  const usablePrefix = normalizedPrefix ?? "";

  const keyFor = (key: string): string => `${usablePrefix}${key}`;

  const helper: CacheHelper = {
    async get<T = unknown>(key: string) {
      const raw = await options.redis.get(keyFor(key));
      if (raw === null) {
        return null;
      }
      try {
        return options.deserializer(raw) as T;
      } catch {
        await options.redis.del(keyFor(key));
        return null;
      }
    },
    async set<T>(
      key: string,
      value: T,
      ttlSeconds?: number,
    ) {
      const payload = options.serializer(value);
      if (typeof payload !== "string") {
        throw new Error("Cache serializer must return a string value.");
      }
      const ttl = resolveTtl(ttlSeconds, options.defaultTtl);
      if (ttl && ttl > 0) {
        await options.redis.set(keyFor(key), payload, "EX", ttl);
      } else {
        await options.redis.set(keyFor(key), payload);
      }
    },
    async del(key: string) {
      await options.redis.del(keyFor(key));
    },
    async wrap<T>(
      key: string,
      ttlSeconds: number | undefined,
      fetcher: () => Promise<T> | T,
    ) {
      const cached = await helper.get<T>(key);
      if (cached !== null) {
        return cached;
      }
      const fresh = await fetcher();
      if (fresh !== undefined) {
        await helper.set(key, fresh, ttlSeconds);
      }
      return fresh;
    },
  };

  return helper;
}

function defaultSerializer(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized ?? "null";
}

function defaultDeserializer<T = unknown>(payload: string): T {
  return JSON.parse(payload) as T;
}

function resolveTtl(
  requestedTtl?: number,
  defaultTtl?: number,
): number | undefined {
  if (typeof requestedTtl === "number") {
    return requestedTtl;
  }
  if (typeof defaultTtl === "number") {
    return defaultTtl;
  }
  return undefined;
}
