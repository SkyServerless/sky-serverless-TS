# Sky Framework

**Version:** 0.1.0
**Status:** Early / Experimental
**Philosophy:** Serverless-First, Provider-Agnostic

Sky is a **TypeScript-first, serverless-first framework** for building portable HTTP workloads without locking your application to a specific cloud provider.

It ships with a lightweight HTTP core, a plugin system, and a CLI that standardizes local development, builds, and deployment packaging — while keeping infrastructure concerns at the edges.

---

## Why Sky Exists

Modern “serverless” development often leads to **strong vendor lock-in**:

* Business logic written directly against AWS Lambda, GCP Functions, or Azure Functions APIs
* Frameworks that claim portability but still depend on provider-specific runtimes
* Local development environments that do not match production behavior
* Costly rewrites when migrating between providers

Sky addresses this problem at the **architectural level**.

> Your application should not know where it runs.
> The runtime should adapt to your application — not the other way around.

---

## Core Principles

### 1. Serverless-First by Design

Sky is not a traditional web framework adapted to serverless.

It is designed from the ground up for:

* Event-driven HTTP execution
* Stateless request handling
* Explicit initialization
* Short-lived runtimes
* Predictable lifecycle hooks

There is no Express, no Fastify, and no hidden globals.

---

### 2. Provider-Agnostic Architecture

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
│   Provider Adapter      │   ← AWS / GCP / Local / etc.
└────────────────────────┘
```

Switching providers does **not** require rewriting your application — only changing the adapter.

---

### 3. Explicit Boundaries

Sky enforces clear separation between:

* **Application logic**
* **HTTP/runtime mechanics**
* **Infrastructure and deployment**

This separation is reflected in:

* Project structure
* Build configuration
* Provider entrypoints

---

## What Sky Is (and Is Not)

### Sky Is

* A serverless-first HTTP framework
* A portability layer for cloud functions
* A plugin-driven runtime
* A CLI-driven development workflow

### Sky Is Not

* A replacement for cloud providers
* A magic abstraction over provider limitations
* A full PaaS
* A framework that hides infrastructure complexity

Sky gives you **control and freedom**, not illusions.

---

## Sky CLI

The Sky CLI orchestrates the development lifecycle while keeping your code provider-agnostic.

### Usage

```bash
sky <command> [options]
```

### Commands

| Command                   | Description                      |
| ------------------------- | -------------------------------- |
| `sky new <name>`          | Scaffold a new Sky application   |
| `sky plugin new <name>`   | Scaffold a Sky plugin            |
| `sky dev [--watch]`       | Run the local development server |
| `sky build [--provider]`  | Build a provider artifact        |
| `sky deploy [--provider]` | Package a deploy artifact        |

### Global Options

| Option          | Description      |
| --------------- | ---------------- |
| `-h, --help`    | Show help        |
| `-v, --version` | Show CLI version |

---

## Project Structure

A project created with `sky new` looks like this:

```txt
.
├── src/
│   ├── app.ts
│   └── providers/
│       └── local.ts
├── sky.config.json
├── tsconfig.json
├── package.json
├── README.md
└── .gitignore
```

This structure is intentional:

* `app.ts` contains **pure application logic**
* `providers/*` contain **runtime-specific adapters**
* `sky.config.json` describes how the CLI builds and runs the project

---

## Application Core

### `src/app.ts`

```ts
import { App, httpOk } from "sky-serverless";

export function createApp(): App {
  const app = new App({});

  app.get("/hello", () => {
    return httpOk({ message: "Hello from Sky" });
  });

  app.get("/health", () => httpOk({ status: "ok" }));

  return app;
}
```

Key characteristics:

* No dependency on Node, Express, or cloud APIs
* Routes return typed HTTP responses
* Plugins and services are injected explicitly

---

## Local Provider (Development)

### `src/providers/local.ts`

```ts
import {
  createHttpHandler,
  createNodeHttpAdapter,
  startNodeHttpServer
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

This provider:

* Adapts Sky to Node’s HTTP runtime
* Exists **only for local development**
* Is not a cloud provider implementation

---

## Development Workflow

```bash
npm run dev
```

* Runs a local HTTP server
* Supports watch mode
* Mimics serverless execution semantics as closely as possible

---

## Build and Deploy (Current State)

```bash
npm run build
npm run deploy
```

### Important Note (v0.1.1)

At this stage:

* ✅ Projects run **locally only**
* ❌ No real cloud provider integrations yet
* ❌ `deploy` does **not** deploy to AWS/GCP/Azure
* ✅ `deploy` only packages artifacts

This is intentional.
Sky stabilizes **contracts before integrations**.

---

## sky-serverless Runtime

Sky applications run on top of `sky-serverless`, which provides:

* Core HTTP primitives (`App`, routing, context)
* Plugin lifecycle hooks
* Data plugins (MySQL, MSSQL, Redis, Cache)
* Documentation (Swagger) and Auth (JWT) plugins
* Multiple adapters (Node HTTP today, cloud in progress)

The runtime is framework-agnostic and fully typed.

---

## Vendor Lock-in: The Real Problem

Most serverless projects fail portability not because of business logic, but because:

* Handlers are written against provider APIs
* Middleware relies on proprietary request objects
* Frameworks leak infrastructure details
* Tests depend on cloud runtimes

Sky eliminates this by design.

Your application never imports:

* `aws-lambda`
* `@google-cloud/functions-framework`
* Provider SDKs

Those belong in adapters — not in your app.

---

## Current Limitations

Sky v0.1.1 intentionally has constraints:

* No production cloud providers yet
* No multi-provider deploys
* No bundled artifacts per provider
* No hot reload outside local Node

These are roadmap items, not oversights.

---

## When Sky Makes Sense

Sky is a strong choice if:

* You want to start serverless without committing to a provider
* You care about long-term portability
* You want realistic local development
* You plan to evolve infrastructure over time
* You value explicit architecture

---

## In One Sentence

> **Sky is a serverless-first framework that prevents cloud vendor lock-in by cleanly separating application logic from runtime and provider infrastructure.**

---

## Roadmap Direction (High Level)

* Define and stabilize the provider contract
* Implement the first production cloud provider
* Produce self-contained build artifacts
* Enable multi-provider targets from a single codebase
* Reach v1.0 with stable APIs
