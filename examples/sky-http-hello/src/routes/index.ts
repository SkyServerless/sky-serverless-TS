import { App } from "../../../../src";
import { ExampleFeatures } from "../config/features";
import { registerAuthRoutes } from "./auth";
import { registerHealthRoutes } from "./health";
import { registerHelloRoutes } from "./hello";
import { registerMssqlTodoRoutes } from "./mssql-todos";
import { registerPingRoutes } from "./ping";
import { registerTodoRoutes } from "./todos";

export function registerExampleRoutes(
  app: App,
  features: ExampleFeatures,
): void {
  registerHealthRoutes(app, features);
  registerHelloRoutes(app);
  registerPingRoutes(app, features);
  registerAuthRoutes(app);
  registerTodoRoutes(app);
  registerMssqlTodoRoutes(app);
}
