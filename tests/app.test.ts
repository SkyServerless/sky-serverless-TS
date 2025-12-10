import { describe, expect, it, vi } from "vitest";
import { App } from "../src/core/app";
import { Handler, SkyContext } from "../src/core/context";
import { SkyPlugin } from "../src/core/plugin";
import { SkyRequest } from "../src/core/http";

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
    const response = await app.handle(buildRequest("GET", "/missing"), baseContext);

    expect(response.statusCode).toBe(404);
    expect(response.body).toMatchObject({
      message: "Route not found",
      path: "/missing",
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
    app.getRouter().register("GET", "/hello", noopHandler);

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
    app.getRouter().register("GET", "/order", noopHandler);

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
    app.getRouter().register("GET", "/secure", noopHandler);

    const response = await app.handle(buildRequest("GET", "/secure"), baseContext);

    expect(response.statusCode).toBe(500);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onResponse).not.toHaveBeenCalled();
  });

  it("exposes registerRoute for fluent handler registration", async () => {
    const app = new App();
    const handler = vi.fn().mockResolvedValue({ statusCode: 202 });

    const result = app.registerRoute("POST", "/registered", handler);

    expect(result).toEqual({ method: "POST", path: "/registered" });

    const response = await app.handle(
      buildRequest("POST", "/registered"),
      baseContext,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(202);
  });
});
