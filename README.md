# SkyServerless-TS

SkyServerless-TS is a TypeScript-first toolkit for building portable HTTP workloads with a lightweight plugin system. It provides the essentials—routing, context, adapters, and infrastructure plugins—without locking you into Express/Fastify.

## Table of Contents

1. [Features](#features)
2. [Project Layout](#project-layout)
3. [Getting Started](#getting-started)
4. [Usage Example](#usage-example)
5. [Data Plugins](#data-plugins)
6. [Testing & Quality](#testing--quality)

## Features

- **Framework-agnostic HTTP core** with routing, context propagation, and provider adapters.
- **Plugin lifecycle** (`setup`, `onRequest`, `onResponse`, `onError`, `extendOpenApi`) for cross-cutting concerns.
- **Native data plugins** covering MySQL, MSSQL, Redis, and a Redis-backed cache helper.
- **First-class TypeScript support** including strict type checking and Vitest-based coverage.
- **Examples and adapters** that demonstrate running on Node HTTP, OpenShift, and GCP functions.

## Project Layout

- `src/core`: HTTP primitives (`App`, `Router`, `SkyContext`, response helpers, adapters).
- `src/plugins/data`: Infrastructure plugins (`mysql`, `mssql`, `redis`, `cache`) plus shared types.
- `examples`: Minimal runnable apps (`sky-http-hello`, `openshift`, `gcp`) built on the core.
- `tests`: Vitest suites with full coverage for data plugins and core behavior.
- `backlog`: Product roadmap with epics and tasks that guide the implementation order.

## Getting Started

### Prerequisites

- Node.js 20+
- npm 10+ (ships with Node 20)

### Install Dependencies

```bash
npm install
```

Optional peer services (MySQL, SQL Server, Redis) are declared as `optionalDependencies`. Install them if you plan to run the respective plugins locally:

```bash
npm install mysql2 mssql ioredis
```

### Run an Example

```bash
npm run example:hello
```

This command boots the `examples/sky-http-hello` adapter via Node HTTP + ts-node so you can hit `http://localhost:3000`.

## Usage Example

Create an app with the HTTP core and register plugins during construction:

```ts
import { App } from "./src/core/app";
import {
  mysqlPlugin,
  mssqlPlugin,
  redisPlugin,
  cachePlugin,
  MysqlClient,
} from "./src/plugins/data";

const app = new App({
  plugins: [
    mysqlPlugin({ connectionString: process.env.SKY_MYSQL_URI }),
    mssqlPlugin({ connectionString: process.env.SKY_MSSQL_CONN_STR }),
    redisPlugin({ connectionString: process.env.SKY_REDIS_URI }),
    cachePlugin(),
  ],
});

app.get("/users", async (_req, ctx) => {
  const mysql = ctx.services.mysql as MysqlClient;
  return mysql.query("SELECT * FROM users WHERE status = ?", ["active"]);
});
```

Adapters (`examples/*`) expose the app as the runtime-specific handler. See `examples/sky-http-hello/server.ts` for a complete integration.

## Data Plugins

Each plugin lives in `src/plugins/data` and is exported via `src/plugins/data/index.ts`. You can provide options directly or rely on environment variables.

### `@sky/mysql`

- Injects a `MysqlClient` under `ctx.services.mysql` with `query<T>`, `rawQuery<T>`, `getPool`, and `close`.
- Configuration:
  - `connectionString`/`uri`: DSN such as `mysql://user:pass@host:3306/db?connectionLimit=10`
  - `connection`: object mirroring `mysql2/promise` pool options
  - `envKey` (default `SKY_MYSQL_URI`), `serviceKey` override, and custom `poolFactory`
- Internally caches a single `mysql2/promise` pool; `client.close()` drains and resets it.

### `@sky/mssql`

- Adds a `MssqlClient` at `ctx.services.mssql` with `query<T>`, `getPool`, and `close`.
- Parameters accept raw values or `{ value, type }` for explicit SQL Server data types.
- Configuration mirrors the MySQL plugin: `connectionString`/`uri`, `config`, `envKey` (`SKY_MSSQL_CONN_STR`), `serviceKey`, and `poolFactory`.
- Uses `mssql.ConnectionPool`; `client.close()` disposes of the cached pool.

### `@sky/redis`

- Exposes a `RedisLike` client (ioredis instance) at `ctx.services.redis`.
- Configure with `connectionString`, `uri`, or `connection` (host, port, username, password, TLS, DB, keyPrefix).
- Defaults to `SKY_REDIS_URI`. Override `serviceKey` or provide your own `clientFactory`/`getRedisClient`.

### `@sky/cache`

- Offers a `CacheHelper` at `ctx.services.cache` with `get`, `set`, `del`, and `wrap`.
- Relies on Redis by default (`ctx.services.redis`). You can pass an explicit `redisClient`, supply `getRedisClient(context)`, or change `redisServiceKey`.
- Options:
  - `keyPrefix` to namespace keys (e.g., `"myapp:cache"`)
  - `defaultTtlSeconds` plus per-call overrides
  - Custom `serializer`/`deserializer` implementations
- `wrap(key, ttl, fetcher)` reads from cache, calls `fetcher` on misses, persists non-`undefined` values, and returns the fresh payload.

## Testing & Quality

- Run the entire suite:

  ```bash
  npm test
  ```

- Generate coverage (base + plugins):

  ```bash
  npm run test:coverage
  ```

- Type-check the project:

  ```bash
  npm exec tsc -- --noEmit
  ```

Targeted coverage profiles live in `package.json` (`coverage:plugins` enforces 100% on `src/plugins/data/**`). Continuous integration should run `npm test` and `npm exec tsc -- --noEmit` at a minimum.
