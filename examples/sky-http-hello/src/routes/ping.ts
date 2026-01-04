import { App, httpError, httpOk } from "../../../../src";
import {
  CacheHelper,
  MssqlClient,
  MysqlClient,
  RedisLike,
} from "../../../../src/plugins";
import { ExampleFeatures } from "../config/features";

export function registerPingRoutes(app: App, features: ExampleFeatures): void {
  app.get(
    "/ping",
    () => httpOk({ ok: true, features }),
    { summary: "Ping summary", tags: ["ping"] },
  );

  app.get(
    "/ping/mysql",
    async (_request, ctx) => {
      const mysql = ctx.services.mysql as MysqlClient | undefined;
      if (!mysql) {
        return serviceUnavailable("MySQL not configured", "Set SKY_MYSQL_URI");
      }
      try {
        const rows = await mysql.query<{ result: number }>(
          "select 1 as result",
        );
        return httpOk({ ok: true, result: rows[0]?.result ?? 0 });
      } catch (error) {
        return serviceUnavailable("MySQL ping failed", serializeError(error));
      }
    },
    { summary: "Ping MySQL", tags: ["ping"] },
  );

  app.get(
    "/ping/mssql",
    async (_request, ctx) => {
      const mssql = ctx.services.mssql as MssqlClient | undefined;
      if (!mssql) {
        return serviceUnavailable(
          "MSSQL not configured",
          "Set SKY_MSSQL_CONN_STR",
        );
      }
      try {
        const rows = await mssql.query<{ result: number }>(
          "select 1 as result",
        );
        return httpOk({ ok: true, result: rows[0]?.result ?? 0 });
      } catch (error) {
        return serviceUnavailable("MSSQL ping failed", serializeError(error));
      }
    },
    { summary: "Ping MSSQL", tags: ["ping"] },
  );

  app.get(
    "/ping/redis",
    async (_request, ctx) => {
      const redis = ctx.services.redis as RedisLike | undefined;
      if (!redis) {
        return serviceUnavailable("Redis not configured", "Set SKY_REDIS_URI");
      }
      try {
        const value = String(Date.now());
        await redis.set("ping", value, "EX", 5);
        const stored = await redis.get("ping");
        return httpOk({ ok: true, value: stored ?? null });
      } catch (error) {
        return serviceUnavailable("Redis ping failed", serializeError(error));
      }
    },
    { summary: "Ping Redis", tags: ["ping"] },
  );

  app.get(
    "/ping/cache",
    async (_request, ctx) => {
      const cache = ctx.services.cache as CacheHelper | undefined;
      if (!cache) {
        return serviceUnavailable(
          "Cache not configured",
          "Set SKY_REDIS_URI to enable cache",
        );
      }
      try {
        await cache.set("ping", Date.now(), 5);
        return httpOk({ ok: true, cachedAt: await cache.get<number>("ping") });
      } catch (error) {
        return serviceUnavailable("Cache ping failed", serializeError(error));
      }
    },
    { summary: "Ping Cache", tags: ["ping"] },
  );
}

function serviceUnavailable(
  message: string,
  details?: string | Record<string, unknown>,
) {
  const payload =
    typeof details === "string" ? { hint: details } : details;
  return httpError({ statusCode: 503, message, details: payload });
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { message: error.message, name: error.name };
  }
  return { message: "Unknown error", detail: error };
}
