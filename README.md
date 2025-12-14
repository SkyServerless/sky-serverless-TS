# SkyServerless-TS

SkyServerless-TS is a TypeScript-first toolkit for building portable HTTP workloads with a lightweight plugin system. It provides the essentials—routing, context, adapters, and infrastructure plugins—without locking you into Express/Fastify.

## Table of Contents

1. [Features](#features)
2. [Project Layout](#project-layout)
3. [Getting Started](#getting-started)
4. [Usage Example](#usage-example)
5. [Data Plugins](#data-plugins)
6. [Docs & Auth Plugins](#docs--auth-plugins)
7. [Testing & Quality](#testing--quality)

## Features

- **Framework-agnostic HTTP core** with routing, context propagation, and provider adapters.
- **Plugin lifecycle** (`setup`, `onRequest`, `onResponse`, `onError`, `extendOpenApi`) for cross-cutting concerns.
- **Native data plugins** covering MySQL, MSSQL, Redis, and a Redis-backed cache helper.
- **First-class TypeScript support** including strict type checking and Vitest-based coverage.
- **Examples and adapters** that demonstrate running on Node HTTP, OpenShift, and GCP functions.
- **Sky CLI** that scaffolds apps/plugins and provides `dev`, `build`, and `deploy` helpers.

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

### Build the CLI

The `sky` CLI compiles to `dist/cli/index.js`. Run the local build once before invoking the binary so consumers don’t need `ts-node`:

```bash
npm run build:cli
```

The `bin/sky.js` launcher loads the compiled file when it exists; if not, it falls back to ts-node for development.

### Link the CLI (optional)

If you want `sky` available globally while iterating on the repo (and make the scaffolds resolve `sky-serverless-ts` without hitting npm), link it:

```bash
npm link
```

Now you can run commands such as `sky --help` or `sky new demo-api` anywhere, and every scaffold will depend on this local copy of the framework. Inside the generated project, run `npm link sky-serverless-ts` (followed by `npm install`) so the app resolves the dependency locally instead of fetching from the registry. Use `npm unlink sky-serverless-ts` when finished and `npm unlink --global`.

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

## Sky CLI

The CLI lives in `src/cli/index.ts` and is exposed via the `sky` binary (declared in `package.json#bin`). After running `npm run build:cli` (and optionally `npm link`), you can:

- `sky new <name> [--db=mysql] [--cache=redis] [--provider=openshift]`: scaffold a framework project with Sky Core, plugins, and provider entrypoints.
- `sky plugin new <name>`: scaffold a plugin package with `package.json`, `tsconfig`, README, and a sample `SkyPlugin`.
- `sky dev [--watch] [--entry=src/app.ts] [--port=3000]`: spin up the Node HTTP adapter with auto-restart.
- `sky build [--provider=gcp] [--outDir=dist]`: compile a provider entry (reads `sky.config.*`).
- `sky deploy [--provider=openshift]`: run the build and copy artifacts into `dist/deploy/<provider>` with a manifest.

Each command accepts `--help` for full options. The scaffolds include a `sky.config.json` so the CLI knows which entrypoint to compile/run. When the compiled bundle is missing the bin will fall back to ts-node, but shipping the prebuilt JS keeps downstream installs lightweight.

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

## Docs & Auth Plugins

The documentation/authentication backlog (`backlog/05-plugins-doc-auth.yaml`) defines the acceptance criteria for both plugins that now ship with the toolkit:

1. **DOC-1 – `@sky/swagger`**: automatically mirror every registered route into an OpenAPI document plus a Swagger UI served by the framework.
2. **AUTH-1 – `@sky/auth-jwt`**: middleware-only authentication helpers that validate JWTs (headers or cookies) and expose helpers so apps can implement their own auth flows.

### `@sky/swagger`

- Mirrors router metadata into an OpenAPI 3.1 document available at `/docs.json` and serves Swagger UI at `/docs`. Override `jsonPath`, `uiPath`, `uiTitle`, or the OpenAPI version (`openapi`) if you want custom endpoints or branding.
- Route metadata accepts `summary`, `description`, `tags`, `responses` (plain strings or `{ description, content, headers }` objects), `requestBody` definitions (`description`, `required`, `content`) for payloads, and `parameters` arrays (query, header, path, cookie) so the Swagger UI can render both body and input controls.
- `requestBody` follows the OpenAPI structure:
  - `description`: short explanation of the payload.
  - `required`: boolean flag to enforce input before enabling “Try it out”.
  - `content`: keyed by media type; each entry can specify `schema`, `example`, and `examples` to render JSON editors or form-data inputs.
- `parameters` are arrays with `{ name, in, description, required, schema, example }` entries. `in` accepts `query`, `header`, `path`, and `cookie`, mirroring the OpenAPI spec so Swagger UI renders text boxes, selects, or checkboxes automatically.
- Configuration:
  - `info`, `servers`, `tags`, and `components` (incluindo `securitySchemes`) to enrich the document.
  - `security` (requirements matrix) to apply global authentication to Swagger UI routes.
  - `includeDocsEndpoints` to optionally expose the `/docs`/`/docs.json` routes inside the document (disabled by default to keep docs internals hidden).

```ts
import { swaggerPlugin } from "./src/plugins/doc";
import { httpOk } from "./src/core/http/responses";

const app = new App({
  plugins: [
    swaggerPlugin({
      info: { title: "Billing API", version: "1.2.3" },
      servers: [{ url: "https://api.example.com" }],
      jsonPath: "/swagger.json",
      uiPath: "/swagger",
    }),
  ],
});

app.get(
  "/invoices/:id",
  () => httpOk({ ok: true }),
  {
    summary: "Invoice detail",
    tags: ["billing"],
    parameters: [
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "includeLines",
        in: "query",
        description: "Expand invoice with line items.",
        schema: { type: "boolean" },
      },
      {
        name: "x-correlation-id",
        in: "header",
        description: "Trace identifier for observability.",
        schema: { type: "string" },
      },
    ],
    responses: {
      200: { description: "Invoice payload" },
      404: "Invoice not found",
    },
  },
);

app.post(
  "/invoices",
  () => httpOk({ created: true }),
  {
    summary: "Create invoice",
    tags: ["billing"],
    parameters: [
      {
        name: "x-request-id",
        in: "header",
        description: "Optional idempotency key.",
        schema: { type: "string" },
      },
    ],
    requestBody: {
      description: "Invoice payload",
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              customerId: { type: "string" },
              amount: { type: "number" },
            },
            required: ["customerId", "amount"],
          },
          examples: {
            sample: {
              value: { customerId: "cust-1", amount: 120.5 },
            },
          },
        },
      },
    },
    responses: {
      201: { description: "Invoice created" },
    },
  },
);
```

### `@sky/auth-jwt`

- Pure middleware: validates JWT access tokens on every request (Authorization header by default, optional cookie) and injects the resolved user into `ctx.services.user` and `request.user`.
- Offers helper utilities (via `ctx.services.auth`) so you can implement your own login/refresh/logout flows without the framework touching your database. Helpers include `signAccessToken`, `signRefreshToken`, `issueTokens`, and `verifyToken`.
- Configuration:
  - `jwtSecret` (or fallback env `SKY_AUTH_JWT_SECRET` defined in AUTH-1.1), `accessTokenTtlSeconds`, `refreshTokenTtlSeconds`.
  - `algorithm` (default `HS256`). Set to `RS256` e fornecer `privateKey`/`publicKey` (ou variáveis `SKY_AUTH_JWT_PRIVATE_KEY`/`SKY_AUTH_JWT_PUBLIC_KEY`) para usar chaves assimétricas.
  - `cookieName`: nome do cookie cuja leitura deve ser tentada quando não houver header `Authorization`.
  - `userServiceKey`/`authServiceKey`: mudam os registries (`ctx.services.user` e `.auth`) caso você queira isolar contextos.
  - `tokenResolver(request, context)`: estratégia personalizada para extrair tokens (útil para cabeçalhos proprietários, WebSockets, etc.).
  - `resolveUser(payload, context)`: reidrata seu usuário (buscando no banco, cache, etc.) antes de expô-lo ao handler; retorne `null` para bloquear o request.

```ts
import { httpError, httpOk } from "./src/core/http/responses";
import { authPlugin, AuthHelpers, AuthUser } from "./src/plugins/auth";

const app = new App({
  plugins: [
    authPlugin({
      config: {
        jwtSecret: process.env.SKY_AUTH_JWT_SECRET!,
        cookieName: "myapp.auth",
        accessTokenTtlSeconds: 30 * 60,
        refreshTokenTtlSeconds: 7 * 24 * 60 * 60,
      },
      async resolveUser(payload) {
        // Optionally fetch extra fields from your database.
        return userRepo.findById(payload.sub) as Promise<AuthUser | null>;
      },
    }),
  ],
});

app.post("/login", async (req, ctx) => {
  const user = await userRepo.verify(req.body.email, req.body.password);
  if (!user) {
    return httpError({ statusCode: 401, message: "Invalid credentials" });
  }
  const auth = ctx.services.auth as AuthHelpers;
  const tokens = auth.issueTokens({ id: user.id, email: user.email });
  return httpOk(tokens);
}, {
  summary: "Authenticate user",
  tags: ["auth"],
  requestBody: {
    description: "Credentials payload",
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string" },
          },
          required: ["email", "password"],
        },
        examples: {
          demo: {
            value: { email: "ada@example.com", password: "pass-ada" },
          },
        },
      },
    },
  },
  responses: {
    200: { description: "JWT pair" },
    401: "Invalid credentials",
  },
});

app.get("/profile", (_req, ctx) => {
  const user = ctx.services.user as AuthUser | undefined;
  if (!user) {
    return httpError({ statusCode: 401, message: "Unauthorized" });
  }
  return httpOk({ user });
}, {
  summary: "Current profile",
  tags: ["auth"],
  parameters: [
    {
      name: "Authorization",
      in: "header",
      description: "Bearer access token",
      required: true,
      schema: { type: "string" },
    },
  ],
  responses: {
    200: { description: "User payload" },
    401: "Missing/invalid token",
  },
});

// Configure RS256 (public/private key pair) instead of shared secrets:
const rsaApp = new App({
  plugins: [
    authPlugin({
      config: {
        algorithm: "RS256",
        privateKey: process.env.SKY_AUTH_JWT_PRIVATE_KEY!,
        publicKey: process.env.SKY_AUTH_JWT_PUBLIC_KEY,
      },
    }),
  ],
});
```

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
  - `components.securitySchemes` lets you define auth flows for the UI. The demo registers a `bearerAuth` scheme so you can click on “Authorize”, paste the token `/auth/login` and test any protected route without manually rewriting the header.
