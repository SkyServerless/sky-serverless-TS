# SkyServerless-TS

## Sky HTTP Core

A stack-agnostic HTTP layer powers SkyServerless without depending on frameworks such as Fastify/Express. Key building blocks now live inside `src/core`:

- `App` + Router: define routes with `app.route/app.get/...`, matching params/wildcards with structured `RouteMatch`.
- Pipeline + plugins: `App.handle` orchestrates hooks (`onRequest`, `onResponse`, `onError`) and normalizes handler returns via helpers in `src/core/http/responses.ts`.
- Provider adapters: `HttpProviderAdapter` + `createHttpHandler` bridge providers (OpenShift, GCP, Node HTTP). Utilities in `src/core/http/parsers.ts` normalize headers, query, and body.
- Example: `examples/sky-http-hello` shows a minimal Node HTTP adapter built only with the Sky HTTP Core.
