import { describe, expect, it, vi } from "vitest";
import { App } from "../src/core/app";
import { SkyContext } from "../src/core/context";
import { ProviderAdapter, createHttpHandler } from "../src/core/provider-adapter";
import { httpOk } from "../src/core/http/responses";

describe("HttpProviderAdapter integration", () => {
  it("converts requests/responses through adapter helpers", async () => {
    const app = new App();
    app.get("/hello/:name", (request) => httpOk({ greeting: request.params?.name }));

    interface RawRequest {
      method: string;
      path: string;
      body?: unknown;
    }

    interface RawResponse {
      statusCode?: number;
      body?: unknown;
      headers?: Record<string, string>;
    }

    const adapter: ProviderAdapter<RawRequest, RawResponse> = {
      providerName: "test-provider",
      toSkyRequest(rawRequest) {
        return {
          method: rawRequest.method,
          path: rawRequest.path,
          headers: {},
          body: rawRequest.body,
          requestId: "adapter-req",
        };
      },
      fromSkyResponse(response, _rawRequest, rawResponse) {
        rawResponse.statusCode = response.statusCode;
        rawResponse.body = response.body;
        rawResponse.headers = Object.fromEntries(
          Object.entries(response.headers ?? {}).map(([key, value]) => [key, String(value)]),
        );
      },
      createContext() {
        return {
          requestId: "ctx-123",
          provider: "test-provider",
          services: {},
        };
      },
    };

    const handler = createHttpHandler(adapter, app);
    const rawResponse: RawResponse = {};

    await handler({ method: "GET", path: "/hello/sky" }, rawResponse);

    expect(rawResponse.statusCode).toBe(200);
    expect(rawResponse.body).toEqual({ greeting: "sky" });
  });

  it("creates default context when adapter does not provide one", async () => {
    const app = new App();
    app.get("/ping", () => httpOk("pong"));

    const adapter: ProviderAdapter<{ method: string; path: string }, { body?: unknown }> = {
      providerName: "minimal",
      toSkyRequest: (rawReq) => ({ method: rawReq.method, path: rawReq.path, headers: {} }),
      fromSkyResponse: (response, _rawRequest, rawResponse) => {
        rawResponse.body = response.body;
      },
    };

    const handler = createHttpHandler(adapter, app);
    const rawResponse: { body?: unknown } = {};

    await handler({ method: "GET", path: "/ping" }, rawResponse);

    expect(rawResponse.body).toBe("pong");
  });

  it("normaliza campos quando createContext retorna parcial", async () => {
    const app = new App();
    app.get("/ctx", () => httpOk("ctx"));

    const contexts: SkyContext[] = [];
    const adapter: ProviderAdapter<{ method: string; path: string }, { body?: unknown }> = {
      providerName: "partial",
      toSkyRequest: (rawReq) => ({ method: rawReq.method, path: rawReq.path, headers: {} }),
      fromSkyResponse: (response, _rawRequest, rawResponse) => {
        rawResponse.body = response.body;
      },
      createContext: () => {
        const ctx = {
          provider: "should-be-overridden",
        } as SkyContext;
        contexts.push(ctx);
        return ctx;
      },
    };

    const handler = createHttpHandler(adapter, app);
    const rawResponse: { body?: unknown } = {};
    await handler({ method: "GET", path: "/ctx" }, rawResponse);

    expect(rawResponse.body).toBe("ctx");
    expect(contexts[0].provider).toBe("partial");
    expect(contexts[0].requestId).toBeDefined();
    expect(contexts[0].services).toEqual({});
  });

  it("retorna erro padrão quando o adapter falha com Error", async () => {
    const app = new App();
    const fromSkyResponse = vi.fn();
    const adapter: ProviderAdapter<{ method: string }, { statusCode?: number; body?: unknown }> =
      {
        providerName: "fails",
        toSkyRequest: () => {
          throw new Error("adapter boom");
        },
        fromSkyResponse,
      };

    const handler = createHttpHandler(adapter, app);
    await handler({ method: "GET" }, {});

    expect(fromSkyResponse).toHaveBeenCalledTimes(1);
    const response = fromSkyResponse.mock.calls[0][0];
    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({ message: "Internal Server Error" });
  });

  it("serializa detalhes genéricos quando adapter lança valor não-Error", async () => {
    const app = new App();
    const fromSkyResponse = vi.fn();
    const adapter: ProviderAdapter<{ method: string }, { statusCode?: number; body?: unknown }> =
      {
        providerName: "fails",
        toSkyRequest: () => {
          throw "boom";
        },
        fromSkyResponse,
      };

    const handler = createHttpHandler(adapter, app);
    await handler({ method: "GET" }, {});

    const response = fromSkyResponse.mock.calls[0][0];
    expect(response.body).toMatchObject({
      details: { message: "Unknown error", detail: "boom" },
    });
  });
});
