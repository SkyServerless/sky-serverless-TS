import { App, httpBadRequest, httpError, httpOk } from "../../../../src";
import { AuthHelpers } from "../../../../src/plugins";
import {
  authenticateDemoUser,
  DemoUser,
  parseLoginRequest,
} from "../auth/demo-users";

export function registerAuthRoutes(app: App): void {
  app.post(
    "/auth/login",
    async (request, ctx) => {
      const credentials = parseLoginRequest(request.body);
      if (!credentials) {
        return httpBadRequest("Expected JSON body with email and password.");
      }

      const user = authenticateDemoUser(credentials);
      if (!user) {
        return httpError({ statusCode: 401, message: "Invalid credentials" });
      }

      const auth = ctx.services.auth as AuthHelpers;
      const tokens = auth.issueTokens(user);
      return httpOk({ user, tokens });
    },
    {
      summary: "Login and receive JWT tokens",
      tags: ["auth"],
      auth: { public: true },
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
        200: { description: "Tokens and user profile" },
        400: "Invalid payload",
        401: "Invalid credentials",
      },
    },
  );

  app.get(
    "/auth/me",
    (_request, ctx) => {
      const user = ctx.services.user as DemoUser | undefined;
      if (!user) {
        return httpError({ statusCode: 401, message: "Unauthorized" });
      }
      return httpOk({ user });
    },
    {
      summary: "Return the authenticated user",
      tags: ["auth"],
      auth: { required: true },
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
        200: { description: "Current user profile" },
        401: "Missing or invalid token",
      },
    },
  );

  app.get(
    "/protected",
    (_request, ctx) => {
      const user = ctx.services.user as DemoUser | undefined;
      if (!user) {
        return httpError({ statusCode: 401, message: "Unauthorized" });
      }
      return httpOk({
        message: "You have access to this protected route.",
        user,
      });
    },
    {
      summary: "Protected route example",
      tags: ["auth"],
      auth: { required: true },
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
        200: { description: "Protected payload" },
        401: "Missing or invalid token",
      },
    },
  );

  app.get(
    "/auth/ping",
    (_request, ctx) => {
      const user = ctx.services.user as DemoUser | undefined;
      if (!user) {
        return httpError({ statusCode: 401, message: "Unauthorized" });
      }
      return httpOk({ ok: true, user });
    },
    {
      summary: "Ping route that validates auth",
      tags: ["auth"],
      auth: { required: true },
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
        200: { description: "Authenticated user" },
        401: "Missing or invalid token",
      },
    },
  );
}
