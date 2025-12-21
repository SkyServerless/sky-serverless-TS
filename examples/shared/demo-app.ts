import { App, httpBadRequest, httpError, httpOk } from "../../src";
import { swaggerPlugin } from "../../src/plugins/doc";
import { AuthHelpers } from "../../src/plugins/auth";
import { MysqlClient } from "../../src/plugins/data/mysql";
import {
  DemoAuthUser,
  authenticateDemoUser,
  createDemoAuthPlugin,
  parseDemoLoginRequest,
} from "./demo-auth";
import { DemoUserRow, createDemoMysqlPlugin } from "./demo-mysql";

export function createDemoApp(): App {
  const app = new App({
    environment: "development",
    plugins: [
      createDemoMysqlPlugin(),
      createDemoAuthPlugin(),
      swaggerPlugin({
        info: {
          title: "Sky Demo API",
          version: "1.0.0",
          description: "Sample routes exercising auth and documentation plugins.",
        },
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
            },
          },
        },
        security: [{ bearerAuth: [] }],
        tags: [
          { name: "demo", description: "Hello and sample data routes" },
          { name: "auth", description: "JWT authentication flow" },
        ],
      }),
    ],
  });

  registerDemoRoutes(app);
  return app;
}

function registerDemoRoutes(app: App): void {
  app.get(
    "/hello/:name",
    (request, ctx) => {
      const name = request.params?.name ?? "world";
      const langValue = request.query?.lang;
      const lang =
        typeof langValue === "string" ? langValue.toLowerCase() : undefined;
      const message =
        lang === "pt"
          ? `Olá, ${name}!`
          : lang === "es"
            ? `Hola, ${name}!`
            : `Hello, ${name}!`;
      const clientHeader = request.headers["x-demo-client"];
      const clientId = Array.isArray(clientHeader)
        ? clientHeader[0]
        : clientHeader;
      return httpOk({
        provider: ctx.provider,
        message,
        query: request.query,
        ...(clientId ? { clientId } : {}),
      });
    },
    {
      summary: "Say hello",
      description: "Echo the path parameter and show provider metadata.",
      tags: ["demo"],
      parameters: [
        {
          name: "lang",
          in: "query",
          description: "Optional language code (en, pt, es).",
          schema: { type: "string", enum: ["en", "pt", "es"] },
        },
        {
          name: "x-demo-client",
          in: "header",
          description: "Client identifier for demo tracking.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: { description: "Greeting payload" },
      },
    },
  );

  app.get(
    "/users",
    async (request, ctx) => {
      const mysql = ctx.services.mysql as MysqlClient;
      const users = await mysql.query<DemoUserRow>("select * from users");
      const limitParam = request.query?.limit;
      const limitValue =
        typeof limitParam === "string" ? Number(limitParam) : undefined;
      const normalizedLimit =
        Number.isFinite(limitValue) && limitValue! > 0
          ? Math.min(Math.floor(limitValue!), 50)
          : undefined;
      const limitedUsers =
        normalizedLimit !== undefined ? users.slice(0, normalizedLimit) : users;
      return httpOk({
        provider: ctx.provider,
        users: limitedUsers,
      });
    },
    {
      summary: "List demo users",
      tags: ["demo"],
      parameters: [
        {
          name: "limit",
          in: "query",
          description: "Max users to return (1-50).",
          schema: { type: "integer", minimum: 1, maximum: 50 },
        },
      ],
      responses: {
        200: { description: "Array of demo users" },
      },
    },
  );

  app.post(
    "/auth/login",
    async (request, ctx) => {
      const credentials = parseDemoLoginRequest(request.body);
      if (!credentials) {
        return httpBadRequest("Expected JSON body with email and password.");
      }

      const user = authenticateDemoUser(credentials);
      if (!user) {
        return httpError({ statusCode: 401, message: "Invalid credentials" });
      }

      const auth = ctx.services.auth as AuthHelpers;
      const tokens = auth.issueTokens(user);
      return httpOk({ tokens, user });
    },
    {
      summary: "Authenticate and receive JWTs",
      tags: ["auth"],
      parameters: [
        {
          name: "x-demo-client",
          in: "header",
          description: "Optional client identifier for logging purposes.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        description: "User credentials",
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                email: { type: "string", format: "email" },
                password: { type: "string", minLength: 1 },
              },
              required: ["email", "password"],
            },
            examples: {
              default: {
                value: {
                  email: "ada@example.com",
                  password: "pass-ada",
                },
              },
            },
          },
        },
      },
      responses: {
        200: { description: "Access and refresh tokens" },
        400: "Missing credentials",
        401: "Invalid credentials",
      },
    },
  );

  app.get(
    "/auth/me",
    (request, ctx) => {
      const user = ctx.services.user as DemoAuthUser;
      const authHeader = request.headers["authorization"];
      const authorization =
        typeof authHeader === "string"
          ? authHeader
          : Array.isArray(authHeader)
            ? authHeader[0]
            : undefined;
      return httpOk({ user, authorization });
    },
    {
      summary: "Return the authenticated user",
      tags: ["auth"],
      auth: { required: true },
      parameters: [
        {
          name: "Authorization",
          in: "header",
          description: "Bearer access token.",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        200: { description: "Current authenticated user" },
        401: "Missing or invalid token",
      },
    },
  );

  app.get(
    "/notes",
    (request, ctx) => {
      const user = ctx.services.user as DemoAuthUser;
      const clientVersionHeader = request.headers["x-client-version"];
      const clientVersion = Array.isArray(clientVersionHeader)
        ? clientVersionHeader[0]
        : clientVersionHeader;
      return httpOk({
        notes: [
          `Welcome back, ${user.name}!`,
          `Your current role is ${user.role}.`,
        ],
        ...(clientVersion ? { clientVersion } : {}),
      });
    },
    {
      summary: "Protected notes endpoint",
      tags: ["auth"],
      auth: { required: true },
      parameters: [
        {
          name: "Authorization",
          in: "header",
          description: "Bearer access token.",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "x-client-version",
          in: "header",
          description: "Optional client version for compatibility tracking.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: { description: "Sample protected payload" },
        401: "Missing or invalid token",
      },
    },
  );
}
