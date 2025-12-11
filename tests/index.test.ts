import { describe, expect, it } from "vitest";
import {
  App,
  Router,
  SkyRequest,
  SkyResponse,
  SkyContext,
  httpOk,
  parseBody,
  ProviderAdapter,
  createHttpHandler,
  SKY_HTTP_METHODS,
  isSkyHttpMethod,
  SKY_CONTEXT_SYMBOL,
  SKY_PLUGIN_HOOKS,
  SKY_CORE_SYMBOL,
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

  it("exposes helpers/utilities via entrypoint", async () => {
    const okResponse = httpOk({ hello: "world" });
    expect(okResponse).toMatchObject({ statusCode: 200, body: { hello: "world" } });

    const parsed = parseBody(Buffer.from("hello"), "text/plain");
    expect(parsed.body).toBe("hello");
    expect(SKY_HTTP_METHODS).toContain("GET");
    expect(isSkyHttpMethod("POST")).toBe(true);
    expect(isSkyHttpMethod("INVALID")).toBe(false);
    expect(typeof SKY_CONTEXT_SYMBOL).toBe("symbol");
    expect(SKY_PLUGIN_HOOKS).toContain("onRequest");
    expect(typeof SKY_CORE_SYMBOL).toBe("symbol");

    const app = new App();
    app.get("/entry", () => httpOk("ok"));

    const adapter: ProviderAdapter<{ method: string; path: string }, { body?: unknown }> = {
      providerName: "entry",
      toSkyRequest: (raw) => ({ method: raw.method, path: raw.path, headers: {} }),
      fromSkyResponse: (response, _rawReq, rawRes) => {
        rawRes.body = response.body;
      },
    };

    const handler = createHttpHandler(adapter, app);
    const response: { body?: unknown } = {};
    await handler({ method: "GET", path: "/entry" }, response);

    expect(response.body).toBe("ok");
  });
});
