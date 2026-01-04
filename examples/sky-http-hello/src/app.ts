import { App } from "../../../src";
import {
  authPlugin,
  cachePlugin,
  mssqlPlugin,
  mysqlPlugin,
  redisPlugin,
  swaggerPlugin,
} from "../../../src/plugins";
import { findDemoUserById } from "./auth/demo-users";
import { resolveExampleFeatures } from "./config/features";
import { registerExampleRoutes } from "./routes";

export function createApp(): App {
  const features = resolveExampleFeatures();
  const plugins = [
    authPlugin({
      config: {
        jwtSecret: process.env.SKY_AUTH_JWT_SECRET ?? "dev-secret",
        accessTokenTtlSeconds: 15 * 60,
        refreshTokenTtlSeconds: 7 * 24 * 60 * 60,
        cookieName: "sky.examples.session",
      },
      resolveUser(payload) {
        return findDemoUserById(payload.sub);
      },
    }),
    swaggerPlugin({
      info: {
        title: "Sky Examples API",
        version: "1.0.0",
        description: "Unified example app showcasing Sky plugins and routes.",
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
        { name: "demo", description: "Hello and health routes" },
        { name: "auth", description: "JWT authentication" },
        { name: "mysql", description: "CRUD with MySQL" },
        { name: "mssql", description: "CRUD with MSSQL" },
        { name: "ping", description: "Service ping routes" },
      ],
    }),
  ];

  if (features.mysql) {
    plugins.push(
      mysqlPlugin({ connectionString: process.env.SKY_MYSQL_URI }),
    );
  }

  if (features.mssql) {
    plugins.push(
      mssqlPlugin({ connectionString: process.env.SKY_MSSQL_CONN_STR }),
    );
  }

  if (features.redis) {
    plugins.push(
      redisPlugin({ connectionString: process.env.SKY_REDIS_URI }),
    );
    plugins.push(cachePlugin({ keyPrefix: "sky-examples" }));
  }

  const app = new App({
    environment: "development",
    plugins,
  });

  registerExampleRoutes(app, features);
  return app;
}

export const createExampleApp = createApp;
