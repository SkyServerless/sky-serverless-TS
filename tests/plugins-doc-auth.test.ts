import { createHmac, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/core/app";
import { SkyContext } from "../src/core/context";
import { SkyRequest, SkyResponse } from "../src/core/http";
import { httpOk } from "../src/core/http/responses";
import { Router } from "../src/core/router";
import {
  authPlugin,
  AuthHelpers,
  AuthPluginOptions,
  AuthUser,
  __authInternals,
} from "../src/plugins/auth";
import { swaggerPlugin } from "../src/plugins/doc";
import {
  buildOpenApiDocument,
  __swaggerInternals,
} from "../src/plugins/doc/swagger";

const baseContext: SkyContext = {
  requestId: "req-doc",
  provider: "test",
  services: {},
  meta: {},
};

const {
  privateKey: RSA_PRIVATE_KEY,
  publicKey: RSA_PUBLIC_KEY,
} = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const buildRequest = (
  method: string,
  path: string,
  overrides: Partial<SkyRequest> = {},
): SkyRequest => {
  const headers = overrides.headers ? { ...overrides.headers } : {};
  return {
    method,
    path,
    ...overrides,
    headers,
  };
};

const cloneContext = (): SkyContext => ({
  ...baseContext,
  services: {},
  meta: {},
});

describe("swaggerPlugin", () => {
  it("generates OpenAPI document from router metadata", async () => {
    const app = new App({
      plugins: [
        swaggerPlugin({
          info: { title: "Test API", version: "2.0.0" },
          servers: [{ url: "https://api.test.dev" }],
        }),
      ],
    });

    app.get(
      "/users/:id",
      () => httpOk({ ok: true }),
      {
        summary: "Get user",
        description: "Loads a user by id",
        tags: ["users"],
        parameters: [
          {
            name: "includePosts",
            in: "query",
            description: "Expand with related posts",
            schema: { type: "boolean" },
          },
          {
            name: "x-correlation-id",
            in: "header",
            description: "Trace identifier",
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "User payload",
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
          404: "User not found",
        },
      },
    );
    app.post(
      "/users",
      () => httpOk({ created: true }),
      {
        summary: "Create user",
        requestBody: {
          description: "User payload",
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  email: { type: "string", format: "email" },
                },
                required: ["name", "email"],
              },
              examples: {
                default: {
                  value: {
                    name: "Ada",
                    email: "ada@example.com",
                  },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Created" },
        },
      },
    );

    const response = await app.handle(
      buildRequest("GET", "/docs.json"),
      cloneContext(),
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers?.["content-type"]).toBe("application/json");
    const document = response.body as Record<string, unknown>;
    expect(document).toMatchObject({
      openapi: "3.1.0",
      info: {
        title: "Test API",
        version: "2.0.0",
      },
      paths: {
        "/users/{id}": {
          get: expect.objectContaining({
            summary: "Get user",
            tags: ["users"],
            responses: expect.objectContaining({
              "404": expect.objectContaining({
                description: "User not found",
              }),
            }),
          }),
        },
      },
    });
    const paths = document.paths as Record<string, Record<string, any>>;
    const getOperation = (paths["/users/{id}"] as Record<string, any>).get;
    expect(getOperation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "includePosts",
          in: "query",
        }),
        expect.objectContaining({
          name: "x-correlation-id",
          in: "header",
        }),
      ]),
    );
    const postOperation = (paths["/users"] as Record<string, any>).post;
    expect(postOperation.requestBody).toMatchObject({
      description: "User payload",
      required: true,
      content: {
        "application/json": expect.objectContaining({
          schema: expect.objectContaining({ type: "object" }),
        }),
      },
    });
  });

  it("cacheia documento JSON até que novas rotas alterem a versão", () => {
    const router = new Router();
    const plugin = swaggerPlugin();
    plugin.setup?.({ router });
    router.register("GET", "/ping", () => httpOk({ ok: true }));
    const docsRoute = router.match("GET", "/docs.json");
    if (!docsRoute) {
      throw new Error("Docs route not registered");
    }
    const handler = docsRoute.route.handler;
    const firstResponse = handler({} as SkyRequest, {} as SkyContext) as SkyResponse;
    const secondResponse = handler({} as SkyRequest, {} as SkyContext) as SkyResponse;
    expect(secondResponse.body).toBe(firstResponse.body);

    router.register("GET", "/health", () => httpOk({ status: "ok" }));
    const thirdResponse = handler({} as SkyRequest, {} as SkyContext) as SkyResponse;
    expect(thirdResponse.body).not.toBe(firstResponse.body);
  });

  it("cacheia HTML da UI entre requisições", () => {
    const router = new Router();
    const plugin = swaggerPlugin();
    plugin.setup?.({ router });
    const uiRoute = router.match("GET", "/docs");
    if (!uiRoute) {
      throw new Error("UI route not registered");
    }
    const handler = uiRoute.route.handler;
    const firstResponse = handler({} as SkyRequest, {} as SkyContext) as SkyResponse;
    const secondResponse = handler({} as SkyRequest, {} as SkyContext) as SkyResponse;
    expect(secondResponse.body).toBe(firstResponse.body);
  });

  it("serves Swagger UI bound to the JSON document", async () => {
    const app = new App({
      plugins: [
        swaggerPlugin({
          jsonPath: "/swagger.json",
          uiPath: "/swagger",
          uiTitle: "Docs",
        }),
      ],
    });

    const response = await app.handle(
      buildRequest("GET", "/swagger"),
      cloneContext(),
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers?.["content-type"]).toContain("text/html");
    expect(typeof response.body).toBe("string");
    expect(response.body).toContain("/swagger.json");
    expect(response.body).toContain("SwaggerUIBundle");
  });
});

describe("swagger internals", () => {
  it("buildOpenApiDocument toggles docs filtering and copies optional metadata", () => {
    const router = new Router();
    router.register("GET", "/docs.json", () => httpOk({}));
    router.register("GET", "/docs", () => httpOk({}));
    router.register(
      "GET",
      "/users/:id",
      () => httpOk({ ok: true }),
      {
        summary: "Lookup user",
        description: "Loads the user resource",
        tags: ["users"],
        responses: {
          200: {
            description: "User payload",
          },
          404: "User not found",
        },
      },
    );
    router.register("POST", "/files/*rest", () => httpOk({}));
    router.register("GET", "/wild/*", () => httpOk({}));
    router.register("GET", "/health", () => httpOk({ status: "ok" }));
    router.register(
      "POST",
      "/payload",
      () => httpOk({ ok: true }),
      {
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object" },
            },
          },
        },
        responses: {
          200: { description: "Payload ok" },
        },
      },
    );

    const baseOptions = {
      openapi: "3.2.0",
      includeDocsEndpoints: false,
      jsonPath: "/docs.json",
      uiPath: "/docs",
    };
    const defaultDocument = buildOpenApiDocument(router, baseOptions);
    expect(defaultDocument.paths).not.toHaveProperty("/docs.json");
    const filesOperation = defaultDocument.paths["/files/{rest}"] as Record<string, any>;
    expect(filesOperation.post.responses).toMatchObject({
      "200": { description: "Successful response" },
    });
    const healthOperation = defaultDocument.paths["/health"] as Record<string, any>;
    expect(healthOperation.get.responses).toMatchObject({
      "200": expect.objectContaining({ description: "Successful response" }),
    });
    const payloadOperation = defaultDocument.paths["/payload"] as Record<string, any>;
    expect(payloadOperation.post.requestBody).toMatchObject({
      content: {
        "application/json": expect.any(Object),
      },
    });
    expect(payloadOperation.post.requestBody).not.toHaveProperty("description");
    expect(payloadOperation.post.requestBody).not.toHaveProperty("required");

    const withMetadata = buildOpenApiDocument(router, {
      ...baseOptions,
      includeDocsEndpoints: true,
      info: {
        title: "Doc Suite",
        version: "9.9.9",
        description: "detailed",
      },
      servers: [{ url: "https://api.sky.dev", description: "prod" }],
      tags: [{ name: "docs", description: "Doc endpoints" }],
      components: { securitySchemes: { bearerAuth: { type: "http" } } },
      security: [{ bearerAuth: [] }],
    });
    expect(withMetadata.paths).toHaveProperty("/docs.json");
    const servers = Array.isArray(withMetadata.servers) ? withMetadata.servers : [];
    expect(servers[0]).toMatchObject({ url: "https://api.sky.dev" });
    const tags = Array.isArray(withMetadata.tags) ? withMetadata.tags : [];
    expect(tags[0]).toMatchObject({ name: "docs" });
    expect(withMetadata.components).toHaveProperty("securitySchemes");
    expect(Object.keys(withMetadata.paths)).toContain("/wild/{wildcard}");
    expect(withMetadata.security).toEqual([{ bearerAuth: [] }]);
  });

  it("buildResponses preserves headers and default descriptions", () => {
    const stubRouter = {
      getRoutes: () => [
        {
          method: "GET",
          path: "/legacy",
          handler: () => httpOk({ legacy: true }),
          meta: {
            responses: {
              418: {
                content: { "application/json": { schema: { type: "object" } } },
                headers: { "x-reason": { description: "why" } },
              },
            },
          },
        },
        {
          method: "GET",
          path: "/",
          handler: () => httpOk({ root: true }),
        },
      ],
    } as unknown as Router;

    const document = buildOpenApiDocument(stubRouter, {
      openapi: "3.0.0",
      includeDocsEndpoints: true,
      jsonPath: "/docs.json",
      uiPath: "/docs",
    });

    const legacyOperation = document.paths["/legacy"] as Record<string, any>;
    expect(legacyOperation.get.responses).toMatchObject({
      "418": {
        description: "Response",
        headers: { "x-reason": expect.any(Object) },
      },
    });
    const rootOperation = document.paths["/"] as Record<string, any>;
    expect(rootOperation.get.responses).toHaveProperty("200");
  });

  it("convertRouterPathToOpenApi converts wildcard patterns", () => {
    expect(convertRouterPathToOpenApi("/files/*rest")).toBe("/files/{rest}");
    expect(convertRouterPathToOpenApi("/wild/*")).toBe("/wild/{wildcard}");
    expect(convertRouterPathToOpenApi("/users/:id/profile")).toBe("/users/{id}/profile");
    expect(convertRouterPathToOpenApi("")).toBe("/");
  });
});

const VALID_EMAIL = "dev@sky.io";
const {
  createAuthHelpers,
  verifyJwt,
  extractCookie,
  extractBearerToken,
  resolveAuthConfig,
  resolveRouteAuthMode,
} = __authInternals;
const { convertRouterPathToOpenApi } = __swaggerInternals;

const buildUser = (): AuthUser => ({
  id: "user-1",
  email: VALID_EMAIL,
  role: "admin",
});

const createAuthApp = (overrides: Partial<AuthPluginOptions> = {}): App => {
  const { config: rawConfig, ...rest } = overrides;
  const config = { ...(rawConfig ?? {}) };
  if (config.algorithm === "RS256") {
    config.privateKey = config.privateKey ?? RSA_PRIVATE_KEY;
    config.publicKey = config.publicKey ?? RSA_PUBLIC_KEY;
  } else if (!config.jwtSecret) {
    config.jwtSecret = "unit-secret";
  }

  return new App({
    plugins: [
      authPlugin({
        ...rest,
        config,
      }),
    ],
  });
};

const registerLoginRoute = (app: App): void => {
  app.post("/login", (_req, ctx) => {
    const auth = ctx.services.auth as AuthHelpers;
    return httpOk(auth.issueTokens(buildUser()));
  });
};

describe("authPlugin", () => {
  it("exposes auth helpers so developers can emit tokens themselves", async () => {
    const app = createAuthApp();
    registerLoginRoute(app);

    const response = await app.handle(
      buildRequest("POST", "/login"),
      cloneContext(),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });
  });

  it("injects authenticated user when Authorization header is present", async () => {
    const app = createAuthApp();
    registerLoginRoute(app);
    app.get("/secure", (_req, ctx) => httpOk({ user: ctx.services.user }));

    const loginResponse = await app.handle(
      buildRequest("POST", "/login"),
      cloneContext(),
    );
    const accessToken = (loginResponse.body as { accessToken: string }).accessToken;

    const secureResponse = await app.handle(
      buildRequest("GET", "/secure", {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
      cloneContext(),
    );

    expect(secureResponse.statusCode).toBe(200);
    expect(secureResponse.body).toMatchObject({
      user: { email: VALID_EMAIL },
    });
  });

  it("reads token from cookies when configured", async () => {
    const app = createAuthApp({ config: { cookieName: "auth.token" } });
    registerLoginRoute(app);
    app.get("/me", (_req, ctx) => httpOk({ user: ctx.services.user }));

    const loginResponse = await app.handle(
      buildRequest("POST", "/login"),
      cloneContext(),
    );
    const token = (loginResponse.body as { accessToken: string }).accessToken;

    const response = await app.handle(
      buildRequest("GET", "/me", {
        headers: { cookie: `auth.token=${token}` },
      }),
      cloneContext(),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      user: { email: VALID_EMAIL },
    });
  });

  it("supports custom token resolvers", async () => {
    const app = createAuthApp({
      tokenResolver: (request) =>
        typeof request.headers["x-session"] === "string"
          ? (request.headers["x-session"] as string)
          : undefined,
    });
    registerLoginRoute(app);
    app.get("/secure", (_req, ctx) => httpOk({ user: ctx.services.user }));

    const loginResponse = await app.handle(
      buildRequest("POST", "/login"),
      cloneContext(),
    );
    const accessToken = (loginResponse.body as { accessToken: string }).accessToken;

    const secureResponse = await app.handle(
      buildRequest("GET", "/secure", {
        headers: { "x-session": accessToken },
      }),
      cloneContext(),
    );

    expect(secureResponse.statusCode).toBe(200);
    expect(secureResponse.body).toMatchObject({
      user: { email: VALID_EMAIL },
    });
  });

  it("supports RS256 key pairs for signing and verification", async () => {
    const app = createAuthApp({
      config: {
        algorithm: "RS256",
        privateKey: RSA_PRIVATE_KEY,
        publicKey: RSA_PUBLIC_KEY,
      },
    });
    registerLoginRoute(app);
    app.get("/secure", (_req, ctx) => httpOk({ user: ctx.services.user }));

    const loginResponse = await app.handle(
      buildRequest("POST", "/login"),
      cloneContext(),
    );
    const accessToken = (loginResponse.body as { accessToken: string }).accessToken;

    const secureResponse = await app.handle(
      buildRequest("GET", "/secure", {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
      cloneContext(),
    );

    expect(secureResponse.statusCode).toBe(200);
    expect(secureResponse.body).toMatchObject({
      user: { email: VALID_EMAIL },
    });
  });

  it("allows resolveUser override to fetch custom user data", async () => {
    const app = createAuthApp({
      resolveUser: async () => ({ id: "user-1", email: VALID_EMAIL, tier: "gold" }),
    });
    registerLoginRoute(app);
    app.get("/secure", (_req, ctx) => httpOk({ user: ctx.services.user }));

    const loginResponse = await app.handle(
      buildRequest("POST", "/login"),
      cloneContext(),
    );
    const token = (loginResponse.body as { accessToken: string }).accessToken;

    const response = await app.handle(
      buildRequest("GET", "/secure", {
        headers: { authorization: `Bearer ${token}` },
      }),
      cloneContext(),
    );

    expect(response.body).toMatchObject({
      user: { tier: "gold" },
    });
  });

  it("blocks handlers for routes that require authentication", async () => {
    const app = createAuthApp();
    const handler = vi.fn(() => httpOk({ ok: true }));
    app.get(
      "/secure-required",
      handler,
      {
        auth: { required: true },
      },
    );

    const response = await app.handle(
      buildRequest("GET", "/secure-required"),
      cloneContext(),
    );

    expect(response.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("honors defaultRouteAuthMode for routes without metadata", async () => {
    const app = createAuthApp({ defaultRouteAuthMode: "required" });
    const handler = vi.fn(() => httpOk({ ok: true }));
    app.get("/needs-auth", handler);

    const response = await app.handle(
      buildRequest("GET", "/needs-auth"),
      cloneContext(),
    );

    expect(response.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("skips token resolution when route meta marks it as public", async () => {
    const tokenResolver = vi.fn(() => {
      throw new Error("resolver should not execute");
    });
    const app = createAuthApp({ tokenResolver });
    const handler = vi.fn(() => httpOk({ ok: true }));
    app.get(
      "/public",
      handler,
      {
        auth: { public: true },
      },
    );

    const response = await app.handle(
      buildRequest("GET", "/public"),
      cloneContext(),
    );

    expect(response.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(tokenResolver).not.toHaveBeenCalled();
  });

  it("respects default mode even when meta exists without auth", async () => {
    const app = createAuthApp({ defaultRouteAuthMode: "required" });
    const handler = vi.fn(() => httpOk({ ok: true }));
    app.get(
      "/meta-no-auth",
      handler,
      {
        summary: "Has doc metadata but no auth field",
      },
    );

    const response = await app.handle(
      buildRequest("GET", "/meta-no-auth"),
      cloneContext(),
    );

    expect(response.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("supports explicit auth.mode overrides", async () => {
    const tokenResolver = vi.fn(() => {
      throw new Error("resolver should not execute");
    });
    const app = createAuthApp({ tokenResolver });
    const handler = vi.fn(() => httpOk({ ok: true }));
    app.get(
      "/auth-mode-public",
      handler,
      {
        auth: { mode: "public" },
      },
    );

    const response = await app.handle(
      buildRequest("GET", "/auth-mode-public"),
      cloneContext(),
    );

    expect(response.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(tokenResolver).not.toHaveBeenCalled();
  });

  it("falls back to default when auth meta object is empty", async () => {
    const app = createAuthApp({ defaultRouteAuthMode: "required" });
    const handler = vi.fn(() => httpOk({ ok: true }));
    app.get(
      "/auth-meta-empty",
      handler,
      {
        auth: {},
      },
    );

    const response = await app.handle(
      buildRequest("GET", "/auth-meta-empty"),
      cloneContext(),
    );

    expect(response.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("treats auth optional flag as best effort even if default requires auth", async () => {
    const app = createAuthApp({ defaultRouteAuthMode: "required" });
    const handler = vi.fn(() => httpOk({ ok: true }));
    app.get(
      "/optional-auth",
      handler,
      {
        auth: { optional: true },
      },
    );

    const response = await app.handle(
      buildRequest("GET", "/optional-auth"),
      cloneContext(),
    );

    expect(response.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("falls back to default when router has no match for route pattern", async () => {
    const plugin = authPlugin({
      config: { jwtSecret: "unit-secret" },
      defaultRouteAuthMode: "required",
    });
    const router = new Router();
    await plugin.setup?.({ router });

    const context = cloneContext();
    context.routePattern = "/ghost";

    const response = await plugin.onRequest?.(
      buildRequest("GET", "/ghost"),
      context,
    );

    expect(response?.statusCode).toBe(401);
  });

  it("supports jwtSecret from environment fallback", () => {
    const original = process.env.SKY_AUTH_JWT_SECRET;
    process.env.SKY_AUTH_JWT_SECRET = "env-secret";
    expect(() =>
      authPlugin({}),
    ).not.toThrow();
    if (original === undefined) {
      delete process.env.SKY_AUTH_JWT_SECRET;
    } else {
      process.env.SKY_AUTH_JWT_SECRET = original;
    }
  });

  it("supports RS256 keys from environment fallback", () => {
    const originalPrivate = process.env.SKY_AUTH_JWT_PRIVATE_KEY;
    const originalPublic = process.env.SKY_AUTH_JWT_PUBLIC_KEY;
    process.env.SKY_AUTH_JWT_PRIVATE_KEY = RSA_PRIVATE_KEY;
    process.env.SKY_AUTH_JWT_PUBLIC_KEY = RSA_PUBLIC_KEY;
    expect(() =>
      authPlugin({ config: { algorithm: "RS256" } }),
    ).not.toThrow();
    if (originalPrivate === undefined) {
      delete process.env.SKY_AUTH_JWT_PRIVATE_KEY;
    } else {
      process.env.SKY_AUTH_JWT_PRIVATE_KEY = originalPrivate;
    }
    if (originalPublic === undefined) {
      delete process.env.SKY_AUTH_JWT_PUBLIC_KEY;
    } else {
      process.env.SKY_AUTH_JWT_PUBLIC_KEY = originalPublic;
    }
  });

  it("throws when jwtSecret is missing", () => {
    const original = process.env.SKY_AUTH_JWT_SECRET;
    delete process.env.SKY_AUTH_JWT_SECRET;
    expect(() =>
      authPlugin({}),
    ).toThrow(/jwtSecret/);
    if (original === undefined) {
      delete process.env.SKY_AUTH_JWT_SECRET;
    } else {
      process.env.SKY_AUTH_JWT_SECRET = original;
    }
  });

  it("throws when privateKey is missing for RS256", () => {
    expect(() =>
      authPlugin({ config: { algorithm: "RS256", privateKey: undefined } }),
    ).toThrow(/privateKey/);
  });
});

describe("authPlugin internals", () => {
  const helperConfig: Parameters<typeof createAuthHelpers>[0] = {
    jwt: {
      algorithm: "HS256",
      signingKey: "unit-secret",
      verificationKey: "unit-secret",
    },
    accessTokenTtlSeconds: 60,
    refreshTokenTtlSeconds: 120,
  };
  const rsaHelperConfig: Parameters<typeof createAuthHelpers>[0] = {
    jwt: {
      algorithm: "RS256",
      signingKey: RSA_PRIVATE_KEY,
      verificationKey: RSA_PUBLIC_KEY,
    },
    accessTokenTtlSeconds: 60,
    refreshTokenTtlSeconds: 120,
  };
  const buildHelpers = (config = helperConfig) => createAuthHelpers(config);

  it("resolveRouteAuthMode reads router metadata when route matches", () => {
    const router = new Router();
    router.register({
      method: "GET",
      path: "/secure",
      handler: () => httpOk({ ok: true }),
      meta: { auth: { required: true } },
    });
    const context = cloneContext();
    context.routePattern = "/secure";
    const mode = resolveRouteAuthMode(
      router,
      buildRequest("GET", "/secure"),
      context,
      "optional",
    );

    expect(mode).toBe("required");
  });

  it("resolveRouteAuthMode falls back when router has no matching route", () => {
    const router = new Router();
    router.register({
      method: "GET",
      path: "/known",
      handler: () => httpOk({ ok: true }),
    });
    const context = cloneContext();
    context.routePattern = "/unknown";
    const mode = resolveRouteAuthMode(
      router,
      buildRequest("GET", "/unknown"),
      context,
      "required",
    );

    expect(mode).toBe("required");
  });

  it("resolveRouteAuthMode returns default when router is undefined", () => {
    const mode = resolveRouteAuthMode(
      undefined,
      buildRequest("GET", "/any"),
      cloneContext(),
      "public",
    );

    expect(mode).toBe("public");
  });

  it("resolveRouteAuthMode returns default when route pattern is missing", () => {
    const router = new Router();
    router.register({
      method: "GET",
      path: "/known",
      handler: () => httpOk({ ok: true }),
    });
    const context = cloneContext();
    context.routePattern = undefined;
    const mode = resolveRouteAuthMode(
      router,
      buildRequest("GET", "/known"),
      context,
      "optional",
    );

    expect(mode).toBe("optional");
  });

  it("resolveRouteAuthMode differentiates HTTP methods", () => {
    const router = new Router();
    router.register({
      method: "POST",
      path: "/secure",
      handler: () => httpOk({ ok: true }),
      meta: { auth: { required: true } },
    });
    const context = cloneContext();
    context.routePattern = "/secure";
    const mode = resolveRouteAuthMode(
      router,
      buildRequest("GET", "/secure"),
      context,
      "optional",
    );

    expect(mode).toBe("optional");
  });

  it("resolveRouteAuthMode honors explicit path patterns", () => {
    const router = new Router();
    router.register({
      method: "GET",
      path: "/wildcard",
      pathPattern: "/wildcard/:id",
      handler: () => httpOk({ ok: true }),
      meta: { auth: { required: true } },
    });
    const context = cloneContext();
    context.routePattern = "/wildcard/:id";
    const mode = resolveRouteAuthMode(
      router,
      buildRequest("GET", "/wildcard/123"),
      context,
      "optional",
    );

    expect(mode).toBe("required");
  });

  it("resolveRouteAuthMode handles routers without registered routes", () => {
    const router = new Router();
    const context = cloneContext();
    context.routePattern = "/ghost";
    const mode = resolveRouteAuthMode(
      router,
      buildRequest("GET", "/ghost"),
      context,
      "required",
    );

    expect(mode).toBe("required");
  });

  it("resolveRouteAuthMode returns default for missing router even when pattern exists", () => {
    const context = cloneContext();
    context.routePattern = "/ghost";
    const mode = resolveRouteAuthMode(
      undefined,
      buildRequest("GET", "/ghost"),
      context,
      "public",
    );

    expect(mode).toBe("public");
  });

  it("resolveRouteAuthMode normalizes undefined http methods", () => {
    const router = new Router();
    router.register({
      method: "GET",
      path: "/with-method",
      handler: () => httpOk({ ok: true }),
      meta: { auth: { required: true } },
    });
    const request = buildRequest("GET", "/with-method");
    (request as SkyRequest).method = undefined as unknown as string;
    const context = cloneContext();
    context.routePattern = "/with-method";

    const mode = resolveRouteAuthMode(router, request, context, "optional");
    expect(mode).toBe("optional");
  });

  it("resolveRouteAuthMode falls back to raw path when pathPattern is missing", () => {
    const router = {
      getRoutes: () => [
        {
          method: "GET",
          path: "/legacy",
          handler: () => httpOk({ ok: true }),
        },
      ],
    } as unknown as Router;
    const context = cloneContext();
    context.routePattern = "/legacy";

    const mode = resolveRouteAuthMode(
      router,
      buildRequest("GET", "/legacy"),
      context,
      "optional",
    );

    expect(mode).toBe("optional");
  });

  it("defaults RS256 publicKey to privateKey when unspecified", () => {
    const resolved = resolveAuthConfig(
      { algorithm: "RS256", privateKey: RSA_PRIVATE_KEY },
      { secret: undefined, privateKey: undefined, publicKey: undefined },
    );
    expect(resolved.jwt.algorithm).toBe("RS256");
    expect(resolved.jwt.signingKey).toBe(RSA_PRIVATE_KEY);
    expect(resolved.jwt.verificationKey).toBe(RSA_PRIVATE_KEY);
  });

  it("does not override existing auth service registrations", async () => {
    const plugin = authPlugin({
      config: { jwtSecret: helperConfig.jwt.signingKey },
    });
    const context = cloneContext();
    context.services.auth = { sentinel: true };

    await plugin.onRequest?.(buildRequest("GET", "/noop"), context);

    expect(context.services.auth).toEqual({ sentinel: true });
  });

  it("ignores refresh tokens when injecting users", async () => {
    const plugin = authPlugin({
      config: { jwtSecret: helperConfig.jwt.signingKey },
    });
    const refreshToken = buildHelpers().signRefreshToken(buildUser());
    const context = cloneContext();

    await plugin.onRequest?.(
      buildRequest("GET", "/secure", {
        headers: { authorization: `Bearer ${refreshToken}` },
      }),
      context,
    );

    expect(context.services.user).toBeUndefined();
  });

  it("skips injection when resolveUser returns null", async () => {
    const plugin = authPlugin({
      config: { jwtSecret: helperConfig.jwt.signingKey },
      resolveUser: () => null,
    });
    const token = buildHelpers().signAccessToken(buildUser());
    const context = cloneContext();

    await plugin.onRequest?.(
      buildRequest("GET", "/secure", {
        headers: { authorization: `Bearer ${token}` },
      }),
      context,
    );

    expect(context.services.user).toBeUndefined();
  });

  it("creates meta container when it is missing", async () => {
    const plugin = authPlugin({
      config: { jwtSecret: helperConfig.jwt.signingKey },
    });
    const token = buildHelpers().signAccessToken(buildUser());
    const context = cloneContext();
    context.meta = undefined;
    const request = buildRequest("GET", "/secure", {
      headers: { authorization: `Bearer ${token}` },
    });

    await plugin.onRequest?.(request, context);

    expect(context.meta).toMatchObject({
      user: expect.objectContaining({ email: VALID_EMAIL }),
    });
    expect(request.user).toMatchObject({ email: VALID_EMAIL });
  });

  it("exposes helpers for manual token signing overrides", () => {
    const helpers = buildHelpers();
    const accessToken = helpers.signAccessToken(buildUser(), {
      ttlSeconds: 5,
      claims: { scope: "admin" },
    });
    const decodedAccess = helpers.verifyToken<{
      type: string;
      exp: number;
      iat: number;
      scope?: string;
    }>(accessToken)!;
    expect(decodedAccess.type).toBe("access");
    expect(decodedAccess.scope).toBe("admin");
    expect(decodedAccess.exp - decodedAccess.iat).toBe(5);

    const refreshToken = helpers.signRefreshToken(buildUser(), { ttlSeconds: 9 });
    const decodedRefresh = helpers.verifyToken<{
      type: string;
      exp: number;
      iat: number;
    }>(refreshToken)!;
    expect(decodedRefresh.type).toBe("refresh");
    expect(decodedRefresh.exp - decodedRefresh.iat).toBe(9);
  });

  it("verifyJwt rejects malformed, mismatched, and expired tokens", () => {
    const helpers = buildHelpers();
    expect(verifyJwt("invalid-token", helperConfig.jwt)).toBeNull();

    const token = helpers.signAccessToken(buildUser());
    const wrongJwt = {
      algorithm: "HS256" as const,
      signingKey: "wrong-secret",
      verificationKey: "wrong-secret",
    };
    expect(verifyJwt(token, wrongJwt)).toBeNull();

    const expired = helpers.signAccessToken(buildUser(), { ttlSeconds: -1 });
    expect(verifyJwt(expired, helperConfig.jwt)).toBeNull();

    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from("{not json").toString("base64url");
    const body = `${header}.${payload}`;
    const signature = createHmac("sha256", helperConfig.jwt.verificationKey)
      .update(body)
      .digest("base64url");
    const malformed = `${body}.${signature}`;
    expect(verifyJwt(malformed, helperConfig.jwt)).toBeNull();

    const [tokenHeader, tokenPayload] = token.split(".");
    const shortenedSignature = token.split(".")[2]?.slice(1) ?? "";
    const shortToken = `${tokenHeader}.${tokenPayload}.${shortenedSignature}`;
    expect(verifyJwt(shortToken, helperConfig.jwt)).toBeNull();
  });

  it("signs and verifies tokens with RS256 key pairs", () => {
    const helpers = buildHelpers(rsaHelperConfig);
    const token = helpers.signAccessToken(buildUser());
    const decoded = verifyJwt(token, rsaHelperConfig.jwt);
    expect(decoded).not.toBeNull();
    const corrupted = `${token.slice(0, -2)}aa`;
    expect(verifyJwt(corrupted, rsaHelperConfig.jwt)).toBeNull();
  });

  it("extractBearerToken ignores non Bearer schemes", () => {
    const request = buildRequest("GET", "/secure", {
      headers: { authorization: "Basic ZGV2OmRldg==" },
    });
    expect(extractBearerToken(request)).toBeUndefined();
  });

  it("extractCookie returns undefined for missing cookie names", () => {
    const request = buildRequest("GET", "/", {
      headers: { cookie: "session=abc; theme=dark" },
    });
    expect(extractCookie(request, "auth.token")).toBeUndefined();
  });

  it("extractCookie handles multi-value cookie headers", () => {
    const request = buildRequest("GET", "/", {
      headers: { cookie: ["session=abc", "auth.token=from-array"] },
    });
    expect(extractCookie(request, "auth.token")).toBe("from-array");
  });
});
