import { App, httpOk } from "../../../../src";
import { ExampleFeatures } from "../config/features";

export function registerHealthRoutes(
  app: App,
  features: ExampleFeatures,
): void {
  app.get("/health", () =>
    httpOk({
      status: "ok",
      features,
    }),
  );
}
