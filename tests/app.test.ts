import { describe, expect, it, vi } from "vitest";
import { App } from "../src/core/app";
import { Handler, SkyContext } from "../src/core/context";
import { SkyPlugin } from "../src/core/plugin";
import { SkyRequest } from "../src/core/http";
import { httpOk } from "../src/core/http/responses";

const baseContext: SkyContext = {
  requestId: "req-1",
  provider: "test",
  services: {},
};

const buildRequest = (method = "GET", path = "/"): SkyRequest => ({
  method,
  path,
  headers: {},
});

const noopHandler: Handler = async () => ({
  statusCode: 200,
  body: { ok: true },
});

describe("App", () => {
  it("Executes plugin setup on startup.", () => {
    const setup = vi.fn();
    const plugin: SkyPlugin = {
      name: "setup-checker",
      version: "1.0.0",
      setup,
    };

    new App({ plugins: [plugin] });

    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({ router: expect.anything() }),
    );
  });

  it("returns 404 when route does not exist", async () => {
    const app = new App();
    const response = await app.handle(
      buildRequest("GET", "/missing"),
      baseContext,
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toMatchObject({
      message: "Route not found",
      details: {
        path: "/missing",
        method: "GET",
      },
    });
  });

  it("calls correct handler and executes onRequest/onResponse hooks", async () => {
    const onRequest = vi.fn();
    const onResponse = vi.fn();

    const plugin: SkyPlugin = {
      name: "hooks",
      version: "1.0.0",
      onRequest,
      onResponse,
    };

    const app = new App({ plugins: [plugin] });
    app.get("/hello", noopHandler);

    const response = await app.handle(buildRequest("GET", "/hello"), baseContext);

    expect(response.statusCode).toBe(200);
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ statusCode: 200 }),
      baseContext,
    );
  });

  it("executes onError when handler throws exception", async () => {
    const onError = vi.fn();
    const plugin: SkyPlugin = {
      name: "error",
      version: "1.0.0",
      onError,
    };

    const app = new App({ plugins: [plugin] });
    app.getRouter().register("GET", "/boom", () => {
      throw new Error("boom");
    });

    const response = await app.handle(buildRequest("GET", "/boom"), baseContext);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(500);
  });

  it("allows plugins to register routes during setup.", async () => {
    const plugin: SkyPlugin = {
      name: "registrar",
      version: "1.0.0",
      setup: ({ router }) => {
        router.register("GET", "/from-plugin", noopHandler);
      },
    };

    const app = new App({ plugins: [plugin] });
    const response = await app.handle(
      buildRequest("GET", "/from-plugin"),
      baseContext,
    );

    expect(response.statusCode).toBe(200);
  });

  it("executes plugins in registration order for request and response", async () => {
    const calls: string[] = [];
    const pluginA: SkyPlugin = {
      name: "A",
      version: "1.0.0",
      onRequest: () => {
        calls.push("req:A");
      },
      onResponse: () => {
        calls.push("res:A");
      },
    };
    const pluginB: SkyPlugin = {
      name: "B",
      version: "1.0.0",
      onRequest: () => {
        calls.push("req:B");
      },
      onResponse: () => {
        calls.push("res:B");
      },
    };

    const app = new App({ plugins: [pluginA, pluginB] });

    app.get("/order", noopHandler);

    await app.handle(buildRequest("GET", "/order"), baseContext);

    expect(calls).toEqual(["req:A", "req:B", "res:A", "res:B"]);
  });

  it("returns 500 when the onRequest plugin fails and does not execute onResponse.", async () => {
    const onError = vi.fn();
    const onResponse = vi.fn();

    const plugin: SkyPlugin = {
      name: "guard",
      version: "1.0.0",
      onRequest: () => {
        throw new Error("blocked");
      },
      onResponse,
      onError,
    };

    const app = new App({ plugins: [plugin] });
    app.get("/secure", noopHandler);

    const response = await app.handle(buildRequest("GET", "/secure"), baseContext);

    expect(response.statusCode).toBe(500);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onResponse).not.toHaveBeenCalled();
  });

  it("exposes registerRoute for fluent handler registration", async () => {
    const app = new App();
    const handler = vi.fn().mockResolvedValue({ statusCode: 202 });

    const result = app.registerRoute("POST", "/registered", handler);

    expect(result).toEqual({
      method: "POST",
      path: "/registered",
      pathPattern: "/registered",
    });

    const response = await app.handle(
      buildRequest("POST", "/registered"),
      baseContext,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(202);
  });

  it("provides HTTP DSL helpers", async () => {
    const app = new App();
    app.post("/dsl/:id", (request) =>
      httpOk({ id: request.params?.id, method: request.method }),
    );

    const response = await app.handle(
      buildRequest("POST", "/dsl/55"),
      baseContext,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ id: "55", method: "POST" });
  });

  it("supports all HTTP verb helpers (put/patch/delete/options/head)", async () => {
    const app = new App();
    app.put("/dsl-put", () => httpOk("put"));
    app.patch("/dsl-patch", () => httpOk("patch"));
    app.delete("/dsl-delete", () => httpOk("delete"));
    app.options("/dsl-options", () => httpOk("options"));
    app.head("/dsl-head", () => ({ statusCode: 204 }));

    const responses = await Promise.all([
      app.handle(buildRequest("PUT", "/dsl-put"), baseContext),
      app.handle(buildRequest("PATCH", "/dsl-patch"), baseContext),
      app.handle(buildRequest("DELETE", "/dsl-delete"), baseContext),
      app.handle(buildRequest("OPTIONS", "/dsl-options"), baseContext),
      app.handle(buildRequest("HEAD", "/dsl-head"), baseContext),
    ]);

    expect(responses[0].body).toBe("put");
    expect(responses[1].body).toBe("patch");
    expect(responses[2].body).toBe("delete");
    expect(responses[3].body).toBe("options");
    expect(responses[4].statusCode).toBe(204);
  });

  it("normalizes handler return values and enriches context", async () => {
    const context: SkyContext = { ...baseContext };
    const app = new App();
    app.get("/info", () => ({ info: true }));

    const response = await app.handle(buildRequest("GET", "/info"), context);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ info: true });
    expect(context.routePattern).toBe("/info");
    expect(context.httpMethod).toBe("GET");
    expect(context.httpPath).toBe("/info");
    expect(context.requestStartedAt).toBeDefined();
    expect(context.requestEndedAt).toBeDefined();
  });

  it("exposes error details in development environment", async () => {
    const app = new App({ environment: "development" });
    app.get("/crash", () => {
      throw new Error("dev boom");
    });

    const response = await app.handle(buildRequest("GET", "/crash"), baseContext);

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({
      message: "Internal Server Error",
      details: expect.objectContaining({ message: "dev boom" }),
    });
  });

  it("does not expose error details when ambiente é production", async () => {
    const app = new App({ environment: "production" });
    app.get("/prod-crash", () => {
      throw new Error("hidden");
    });

    const response = await app.handle(
      buildRequest("GET", "/prod-crash"),
      baseContext,
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({ message: "Internal Server Error" });
    const prodBody = response.body as { details?: unknown } | undefined;
    expect(prodBody?.details).toBeUndefined();
  });

  it("usa ambiente production por padrão quando NODE_ENV está indefinido", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    const app = new App();
    app.get("/default-env", () => {
      throw new Error("hidden");
    });

    try {
      const response = await app.handle(
        buildRequest("GET", "/default-env"),
        baseContext,
      );
      const defaultBody = response.body as { details?: unknown } | undefined;
      expect(defaultBody?.details).toBeUndefined();
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it("serializes unknown error types com detalhe genérico", async () => {
    const app = new App({ environment: "development" });
    app.get("/weird-error", () => {
      throw "boom";
    });

    const response = await app.handle(
      buildRequest("GET", "/weird-error"),
      baseContext,
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({
      details: { detail: "boom" },
    });
  });
});
