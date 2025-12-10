import { describe, expect, it } from "vitest";
import {
  App,
  Router,
  SkyRequest,
  SkyResponse,
  SkyContext,
} from "../src";

describe("Pacote principal", () => {
  it("exposes essential classes and types via entrypoint", async () => {
    const app = new App();
    expect(app).toBeInstanceOf(App);
    expect(new Router()).toBeInstanceOf(Router);

    app.getRouter().register("GET", "/index", () => ({
      statusCode: 200,
      body: { source: "index" },
    }));

    const request: SkyRequest = { method: "GET", path: "/index", headers: {} };
    const context: SkyContext = {
      requestId: "idx",
      provider: "test",
      services: {},
    };

    const response: SkyResponse = await app.handle(request, context);
    expect(response.body).toMatchObject({ source: "index" });
  });
});
