import http from "node:http";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import { describe, expect, it, vi, afterEach } from "vitest";
import { App } from "../src/core/app";
import { httpOk } from "../src/core/http/responses";
import {
  createNodeHttpAdapter,
  startNodeHttpServer,
} from "../src/providers/node-http-adapter";
import * as providerAdapter from "../src/core/provider-adapter";

function createMockRequest(bodyChunks: Array<string | Buffer>) {
  const request = new Readable({
    objectMode: true,
    read() {
      while (bodyChunks.length > 0) {
        const chunk = bodyChunks.shift();
        if (chunk !== undefined) {
          this.push(chunk);
          return;
        }
      }
      this.push(null);
    },
  }) as unknown as http.IncomingMessage;

  request.headers = {
    host: "localhost:3000",
    "content-type": "application/json",
    "x-request-id": "req-test",
  };
  request.method = "POST";
  request.url = "/hello/world?tag=a&tag=b";
  request.socket = { remoteAddress: "127.0.0.1" } as unknown as Socket;

  return request;
}

function createMockResponse() {
  const headers: Record<string, string> = {};
  const end = vi.fn();
  return {
    statusCode: 0,
    setHeader: (key: string, value: unknown) => {
      headers[key] = String(value);
    },
    end,
    getHeaders: () => headers,
  } as unknown as http.ServerResponse;
}

describe("Node HTTP adapter", () => {
  it("converte requisições/respostas do Node", async () => {
    const adapter = createNodeHttpAdapter();
    const request = createMockRequest(['{"name":"sky"', Buffer.from("}")]);
    const rawResponse = createMockResponse();

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.path).toBe("/hello/world");
    expect(skyRequest.query).toEqual({ tag: ["a", "b"] });
    expect(skyRequest.headers).toMatchObject({
      "content-type": "application/json",
    });
    expect(skyRequest.body).toEqual({ name: "sky" });

    await adapter.fromSkyResponse(
      {
        statusCode: 201,
        body: { ok: true },
        headers: { "content-type": "application/json" },
      },
      request,
      rawResponse,
    );

    expect(rawResponse.statusCode).toBe(201);
    expect(rawResponse.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
  });

  it("aplica defaults quando request está incompleto", async () => {
    const adapter = createNodeHttpAdapter();
    const request = createMockRequest([]);
    request.url = undefined as unknown as string;
    delete request.headers.host;
    request.method = undefined;

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.path).toBe("/");
    expect(skyRequest.method).toBe("GET");
    expect(skyRequest.body).toBeUndefined();
  });

  it("serializa payloads diversos no fromSkyResponse", async () => {
    const adapter = createNodeHttpAdapter();
    const request = createMockRequest([]);

    const emptyResponse = createMockResponse();
    await adapter.fromSkyResponse({ statusCode: 204 }, request, emptyResponse);
    expect(emptyResponse.end).toHaveBeenCalledWith(undefined);

    const bufferPayload = Buffer.from("ok");
    const bufferResponse = createMockResponse();
    await adapter.fromSkyResponse(
      { statusCode: 200, body: bufferPayload },
      request,
      bufferResponse,
    );
    expect(bufferResponse.end).toHaveBeenCalledWith(bufferPayload);

    const stringResponse = createMockResponse();
    await adapter.fromSkyResponse(
      { statusCode: 200, body: "hello" },
      request,
      stringResponse,
    );
    expect(stringResponse.end).toHaveBeenCalledWith("hello");

  const numberResponse = createMockResponse();
  await adapter.fromSkyResponse(
    { statusCode: 200, body: 123 },
    request,
    numberResponse,
  );
  expect(numberResponse.end).toHaveBeenCalledWith("123");

  const booleanResponse = createMockResponse();
  await adapter.fromSkyResponse(
    { statusCode: 200, body: true },
    request,
    booleanResponse,
  );
  expect(booleanResponse.end).toHaveBeenCalledWith("true");

  const uint8Payload = new Uint8Array([111, 107]);
  const uint8Response = createMockResponse();
  await adapter.fromSkyResponse(
    { statusCode: 200, body: uint8Payload },
    request,
    uint8Response,
  );
  expect(uint8Response.end).toHaveBeenCalledWith(uint8Payload);
});

  it("normaliza createContext e permite extender dados", async () => {
    const adapter = createNodeHttpAdapter({
      providerName: "dev-node",
      extendContext: () => ({
        services: { cache: true },
        meta: { user: "local" },
      }),
    });
    const request = createMockRequest([]);
    delete request.headers["x-request-id"];
    const rawResponse = createMockResponse();

    if (!adapter.createContext) {
      throw new Error("Adapter did not expose createContext");
    }
    const context = await adapter.createContext(request, rawResponse);

    expect(context.provider).toBe("dev-node");
    expect(context.services).toEqual({ cache: true });
    expect(context.meta).toMatchObject({ user: "local", ip: "127.0.0.1" });
    expect(context.requestId).toMatch(/req-/);
  });

  it("permite sobrescrever o IP via extendContext", async () => {
    const adapter = createNodeHttpAdapter({
      extendContext: () => ({
        meta: { ip: "10.0.0.1" },
      }),
    });
    const request = createMockRequest([]);
    if (!adapter.createContext) {
      throw new Error("Adapter did not expose createContext");
    }
    const context = await adapter.createContext(request, createMockResponse());
    expect(context.meta?.ip).toBe("10.0.0.1");
  });

  it("usa requestId do header ou do extendContext quando disponível", async () => {
    const headerAdapter = createNodeHttpAdapter();
    const requestWithHeader = createMockRequest([]);
    if (!headerAdapter.createContext) {
      throw new Error("Adapter did not expose createContext");
    }
    const headerContext = await headerAdapter.createContext(
      requestWithHeader,
      createMockResponse(),
    );
    expect(headerContext.requestId).toBe("req-test");

    const adapterWithId = createNodeHttpAdapter({
      extendContext: () => ({ requestId: "extend-id" }),
    });
    const requestWithoutHeader = createMockRequest([]);
    delete requestWithoutHeader.headers["x-request-id"];
    if (!adapterWithId.createContext) {
      throw new Error("Adapter did not expose createContext");
    }
    const extendedContext = await adapterWithId.createContext(
      requestWithoutHeader,
      createMockResponse(),
    );
    expect(extendedContext.requestId).toBe("extend-id");
  });
});

describe("startNodeHttpServer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cria servidor HTTP e loga endereço", () => {
    const app = new App();
    app.get("/dev", () => httpOk("ready"));

    const handler = vi.fn();
    vi.spyOn(providerAdapter, "createHttpHandler").mockReturnValue(
      handler as unknown as ReturnType<typeof providerAdapter.createHttpHandler>,
    );

    const listen = vi.fn((port, host, callback) => {
      callback?.();
      return {} as http.Server;
    });
    const createServerSpy = vi.spyOn(http, "createServer").mockReturnValue({
      listen,
    } as unknown as http.Server);

    const logger = vi.fn();
    const server = startNodeHttpServer(app, {
      port: 4567,
      host: "127.0.0.1",
      logger,
    });

    expect(providerAdapter.createHttpHandler).toHaveBeenCalled();
    expect(listen).toHaveBeenCalledWith(4567, "127.0.0.1", expect.any(Function));
    expect(logger).toHaveBeenCalledWith("Sky HTTP dev server running at http://127.0.0.1:4567");
    expect(server).toBe(createServerSpy.mock.results[0].value as http.Server);
  });

  it("usa defaults de porta/host/logger", () => {
    const app = new App();
    const handler = vi.fn();
    vi.spyOn(providerAdapter, "createHttpHandler").mockReturnValue(
      handler as unknown as ReturnType<typeof providerAdapter.createHttpHandler>,
    );

    const listen = vi.fn((port, host, callback) => {
      callback?.();
      return {} as http.Server;
    });
    vi.spyOn(http, "createServer").mockReturnValue({
      listen,
    } as unknown as http.Server);

    const originalPort = process.env.SKY_HTTP_PORT;
    process.env.SKY_HTTP_PORT = "3456";
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      startNodeHttpServer(app);
      expect(listen).toHaveBeenCalledWith(3456, "0.0.0.0", expect.any(Function));
      expect(consoleSpy).toHaveBeenCalledWith(
        "Sky HTTP dev server running at http://localhost:3456",
      );
    } finally {
      if (originalPort === undefined) {
        delete process.env.SKY_HTTP_PORT;
      } else {
        process.env.SKY_HTTP_PORT = originalPort;
      }
      consoleSpy.mockRestore();
    }
  });

  it("fallback para process.env.PORT quando SKY_HTTP_PORT não existe", () => {
    const app = new App();
    const handler = vi.fn();
    vi.spyOn(providerAdapter, "createHttpHandler").mockReturnValue(
      handler as unknown as ReturnType<typeof providerAdapter.createHttpHandler>,
    );

    const listen = vi.fn((port, host, callback) => {
      callback?.();
      return {} as http.Server;
    });
    vi.spyOn(http, "createServer").mockReturnValue({
      listen,
    } as unknown as http.Server);

    const originalSky = process.env.SKY_HTTP_PORT;
    const originalPort = process.env.PORT;
    delete process.env.SKY_HTTP_PORT;
    process.env.PORT = "4321";
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      startNodeHttpServer(app);
      expect(listen).toHaveBeenCalledWith(4321, "0.0.0.0", expect.any(Function));
      expect(consoleSpy).toHaveBeenCalledWith(
        "Sky HTTP dev server running at http://localhost:4321",
      );
    } finally {
      if (originalSky === undefined) {
        delete process.env.SKY_HTTP_PORT;
      } else {
        process.env.SKY_HTTP_PORT = originalSky;
      }
      if (originalPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = originalPort;
      }
      consoleSpy.mockRestore();
    }
  });

  it("usa porta padrão 3000 quando nenhuma variável está definida", () => {
    const app = new App();
    const handler = vi.fn();
    vi.spyOn(providerAdapter, "createHttpHandler").mockReturnValue(
      handler as unknown as ReturnType<typeof providerAdapter.createHttpHandler>,
    );

    const listen = vi.fn((port, host, callback) => {
      callback?.();
      return {} as http.Server;
    });
    vi.spyOn(http, "createServer").mockReturnValue({
      listen,
    } as unknown as http.Server);

    const originalSky = process.env.SKY_HTTP_PORT;
    const originalPort = process.env.PORT;
    delete process.env.SKY_HTTP_PORT;
    delete process.env.PORT;
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      startNodeHttpServer(app);
      expect(listen).toHaveBeenCalledWith(3000, "0.0.0.0", expect.any(Function));
      expect(consoleSpy).toHaveBeenCalledWith(
        "Sky HTTP dev server running at http://localhost:3000",
      );
    } finally {
      if (originalSky === undefined) {
        delete process.env.SKY_HTTP_PORT;
      } else {
        process.env.SKY_HTTP_PORT = originalSky;
      }
      if (originalPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = originalPort;
      }
      consoleSpy.mockRestore();
    }
  });
});
