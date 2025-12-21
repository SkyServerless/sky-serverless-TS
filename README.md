# SkyServerless-TS

**Version:** 0.3.0
**Status:** Early / Experimental
**Philosophy:** Serverless-First, Provider-Agnostic

Sky is a **TypeScript-first, serverless-first framework** for building portable HTTP workloads without locking your application to a specific cloud provider.

It ships with a lightweight HTTP core, a plugin system, and a CLI that standardizes local development, builds, and deployment packaging — while keeping infrastructure concerns at the edges.

## Why Sky Exists

Modern “serverless” development often leads to **strong vendor lock-in**:

- Business logic written directly against AWS Lambda, GCP Functions, or Azure Functions APIs
- Frameworks that claim portability but still depend on provider-specific runtimes
- Local development environments that do not match production behavior
- Costly rewrites when migrating between providers

Sky addresses this problem at the **architectural level**.

> Your application should not know where it runs.
> The runtime should adapt to your application — not the other way around.

## Core behavior (what happens under the hood)

### Request lifecycle

1. Adapter converts provider request into `SkyRequest`
2. Context is created (provider + requestId + services + meta)
3. `onRequest` hooks run (in order)
4. Route handler runs
5. `onResponse` hooks run (in order)
6. If any error occurs, `onError` hooks run

### Error handling and environment

- Unhandled errors become `500`
- In non-production environments, error details are included in the response
- `environment` is set via `new App({ environment })` or `NODE_ENV`

### Request and response normalization

Request parsing (by adapters):

- `application/json` -> object
- `application/x-www-form-urlencoded` -> object
- `text/*` -> string
- Other content-types -> Buffer/Uint8Array

Response defaults:

- If you return a primitive or object, it becomes `{ statusCode: 200, body }`
- If no `content-type` is set and body is an object, JSON is used
- Buffer/Uint8Array and string are sent as-is

### Provider-Agnostic Architecture

Your application code is written against a **portable HTTP core**.

Cloud providers are integrated through **adapters**, which live entirely outside your business logic.

```
┌────────────────┐
│   Application  │   ← business logic
└───────┬────────┘
        │
┌───────▼────────┐
│    Sky Core    │   ← routing, context, plugins
└───────┬────────┘
        │
┌───────▼────────────────┐
│   Provider Adapter     │   ← AWS / GCP / Local / etc.
└────────────────────────┘
```

## Request IDs and tracing

- `x-request-id` is honored when provided (sanitized)
- GCP adapter uses `X-Cloud-Trace-Context` when present
- Generated IDs follow: `req-<time>-<random>`

Use `ctx.requestId` to correlate logs across services.

## Requirements

- Node.js 20+
- npm 10+

## Quickstart (CLI)

```bash
sky new my-api --provider=local,gcp --db=mysql --cache=redis
cd my-api
npm install
npm run dev
```

This generates a project with:

- `src/app.ts` (your routes and plugins)
- `src/providers/*.ts` (provider entrypoints)
- `sky.config.json` (dev/build/deploy config)
- `package.json` scripts (`dev`, `build`, `deploy`)

## Project layout (scaffolded)

```
my-api/
  src/
    app.ts
    providers/
      local.ts
      gcp.ts
  sky.config.json
  package.json
  tsconfig.json
```

## App entry (`src/app.ts`)

The scaffold exports a `createApp()` factory. It is the default shape expected by `sky dev`.

```ts
import { App, httpOk } from "sky-serverless";
import {
  mysqlPlugin,
  redisPlugin,
  cachePlugin,
} from "sky-serverless/plugins/data";

export function createApp(): App {
  const app = new App({
    plugins: [
      mysqlPlugin({ connectionString: process.env.SKY_MYSQL_URI }),
      redisPlugin({ connectionString: process.env.SKY_REDIS_URI }),
      cachePlugin({ keyPrefix: "sky-cache" }),
    ],
  });

  app.get("/hello", () => {
    return httpOk({ message: "Hello from Sky" });
  });

  app.get("/health", () => httpOk({ status: "ok" }));

  return app;
}
```

## Provider entrypoints (`src/providers/*.ts`)

### Local (Node HTTP)

```ts
import {
  createHttpHandler,
  createNodeHttpAdapter,
  startNodeHttpServer,
} from "sky-serverless";
import { createApp } from "../app";

const app = createApp();
const adapter = createNodeHttpAdapter({ providerName: "local-dev" });
export const handler = createHttpHandler(adapter, app);

export function start() {
  const port = Number(process.env.PORT ?? process.env.SKY_DEV_PORT ?? 3000);
  return startNodeHttpServer(app, { port });
}

if (require.main === module) {
  start();
}
```

### OpenShift (developing)

```ts
import { createHttpHandler, OpenShiftProviderAdapter } from "sky-serverless";
import { createApp } from "../app";

const adapter = new OpenShiftProviderAdapter();
const app = createApp();
export const handler = createHttpHandler(adapter, app);
export default handler;
```

### GCP

```ts
import { startNodeHttpServer } from "sky-serverless";
import { createApp } from "../app";

const app = createApp();
const port = Number(process.env.PORT) || 8080;
startNodeHttpServer(app, { port });
```

## sky.config.json

```json
{
  "name": "my-api",
  "appEntry": "./src/app.ts",
  "defaultProvider": "local",
  "providers": {
    "local": { "entry": "./src/providers/local.ts" },
    "gcp": { "entry": "./src/providers/gcp.ts" }
  },
  "dev": { "port": 3000, "watchPaths": ["src"] },
  "build": { "outDir": "dist", "tsconfig": "tsconfig.json" },
  "deploy": { "artifactDir": "deploy" }
}
```

## CLI commands (scaffold-first)

```bash
sky new <name> [--db=mysql] [--cache=redis] [--provider=local,gcp,openshift]
sky dev [--entry=src/app.ts] [--watch] [--port=3000]
sky build [--provider=gcp] [--outDir=dist]
sky deploy [--provider=gcp]
sky remove [--provider=gcp]
```

Notes:

- `sky dev` expects `createApp()` in `appEntry`.
- `sky build` compiles the selected provider entry.
- `sky deploy` packs the local framework (npm pack) and creates a deploy artifact.

## Native plugins (same pattern as scaffold)

Native plugins are imported from explicit entrypoints. This keeps plugin-specific typings (route meta) available only when you opt in.

- Data plugins: `sky-serverless/plugins/data`
- Swagger docs: `sky-serverless/plugins/doc`
- JWT auth: `sky-serverless/plugins/auth`
- All plugins (convenience import): `sky-serverless/plugins`

When you import `sky-serverless/plugins`, all native plugin typings are enabled (docs + auth meta) even if you only use one plugin.

### mysqlPlugin

```ts
import { mysqlPlugin, MysqlClient } from "sky-serverless/plugins/data";

const app = new App({
  plugins: [mysqlPlugin({ connectionString: process.env.SKY_MYSQL_URI })],
});

app.get("/db/ping", async (_req, ctx) => {
  const mysql = ctx.services.mysql as MysqlClient;
  const rows = await mysql.query<{ result: number }>("select 1 + 1 as result");
  return { result: rows[0]?.result ?? 0 };
});
```

Options:

- `connectionString` or `uri` (example: `mysql://user:pass@host:3306/db`)
- `connection` (mysql2/promise config)
- `envKey` (default `SKY_MYSQL_URI`)
- `serviceKey` to change `ctx.services.mysql`

### mssqlPlugin

```ts
import { mssqlPlugin, MssqlClient } from "sky-serverless/plugins/data";

const app = new App({
  plugins: [mssqlPlugin({ connectionString: process.env.SKY_MSSQL_CONN_STR })],
});

app.get("/orders", async (_req, ctx) => {
  const mssql = ctx.services.mssql as MssqlClient;
  return mssql.query("SELECT * FROM orders WHERE status = @status", {
    status: "open",
  });
});
```

Options:

- `connectionString` or `uri`
- `config` (mssql connection config)
- `envKey` (default `SKY_MSSQL_CONN_STR`)
- parameters can be `{ value, type }` for SQL Server types

### redisPlugin + cachePlugin

```ts
import {
  redisPlugin,
  cachePlugin,
  CacheHelper,
} from "sky-serverless/plugins/data";

const app = new App({
  plugins: [
    redisPlugin({ connectionString: process.env.SKY_REDIS_URI }),
    cachePlugin({ keyPrefix: "sky-cache", defaultTtlSeconds: 30 }),
  ],
});

app.get("/cache/ping", async (_req, ctx) => {
  const cache = ctx.services.cache as CacheHelper;
  await cache.set("ping", Date.now(), 5);
  return { cachedAt: await cache.get<number>("ping") };
});
```

## Docs and auth plugins (scaffold-compatible)

### swaggerPlugin

```ts
import { swaggerPlugin } from "sky-serverless/plugins/doc";

const app = new App({
  plugins: [
    swaggerPlugin({
      info: { title: "My API", version: "1.0.0" },
      jsonPath: "/docs.json",
      uiPath: "/docs",
    }),
  ],
});
```

Importing `sky-serverless/plugins/doc` enables route meta autocomplete for `summary`, `description`, `tags`, `responses`, `requestBody`, and `parameters`.

### authPlugin

```ts
import { authPlugin, AuthHelpers, AuthUser } from "sky-serverless/plugins/auth";

const app = new App({
  plugins: [
    authPlugin({
      config: {
        jwtSecret: process.env.SKY_AUTH_JWT_SECRET!,
        accessTokenTtlSeconds: 900,
        refreshTokenTtlSeconds: 604800,
      },
      async resolveUser(payload) {
        return userRepo.findById(payload.sub) as Promise<AuthUser | null>;
      },
    }),
  ],
});

app.post("/login", async (req, ctx) => {
  const user = await userRepo.verify(req.body.email, req.body.password);
  if (!user)
    return { statusCode: 401, body: { message: "Invalid credentials" } };
  const auth = ctx.services.auth as AuthHelpers;
  return { tokens: auth.issueTokens(user) };
});
```

Importing `sky-serverless/plugins/auth` enables `meta.auth` typing for route-level auth configuration.

## Provider adapter contract (for custom providers)

If you want to implement your own provider, follow this contract:

```ts
import { ProviderAdapter } from "sky-serverless";

export const myAdapter: ProviderAdapter<MyReq, MyRes> = {
  providerName: "my-provider",
  async toSkyRequest(rawReq) {
    return {
      method: "GET",
      path: "/",
      headers: {},
    };
  },
  async fromSkyResponse(res, rawReq, rawRes) {
    // Write status, headers, body to rawRes
  },
  async createContext(rawReq, rawRes) {
    return {
      requestId: "custom-id",
      provider: "my-provider",
      services: {},
    };
  },
};
```

## CLI deploy/remove details

### Deploy

`sky deploy`:

- builds the provider entry
- packs the local framework (`npm pack`)
- generates a deploy artifact with `package.json` + `manifest.json`
- for GCP, writes a Dockerfile and deploys with `gcloud`

### Remove

`sky remove --provider=gcp` deletes the Cloud Run service created by deploy.

## Creating custom plugins (via CLI)

```bash
sky plugin new my-plugin
cd my-plugin
npm install
npm run build
```

Then install it in your app and register in `App`:

```ts
import { App } from "sky-serverless";
import { createMyPlugin } from "@sky/my-plugin";

const app = new App({
  plugins: [createMyPlugin()],
});
```

## Operational gaps and tips

- Native plugins require optional deps (`mysql2`, `mssql`, `ioredis`).
- `cachePlugin` depends on Redis (from `redisPlugin` or a custom client).
- Default body limit is 1 MiB in Node, OpenShift, and GCP.
- Use `trustProxy` behind a load balancer to get real client IP in `ctx.meta.ip`.
- `sky dev` requires `ts-node` in your project.
- Adapters enforce `maxBodySizeBytes` (default 1 MiB). Payloads above that return `413`.
- Use `trustProxy` with `allowCidrs` when behind load balancers to avoid spoofed IPs.
