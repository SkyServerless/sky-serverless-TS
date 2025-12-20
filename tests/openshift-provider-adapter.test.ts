import http from "node:http";
import type { Socket } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkyResponse } from "../src/core/http";
import { OpenShiftProviderAdapter } from "../src/providers/openshift/openShiftProviderAdapter";
import { PayloadTooLargeError } from "../src/core/http";
import * as requestUtils from "../src/providers/request-utils";

function createIncomingMessage(
  chunks: Array<string | Buffer>,
  extraHeaders: http.IncomingHttpHeaders = {},
): http.IncomingMessage {
  const stream = new Readable({
    read() {
      while (chunks.length > 0) {
        const chunk = chunks.shift();
        if (chunk !== undefined) {
          this.push(chunk);
          return;
        }
      }
      this.push(null);
    },
  }) as unknown as http.IncomingMessage;

  stream.method = "POST";
  stream.url = "/foo/bar?lang=pt";
  stream.headers = {
    host: "sky.local:8080",
    "content-type": "application/json",
    "x-forwarded-for": "10.10.0.1, 10.10.0.2",
    "x-forwarded-proto": "https",
    ...extraHeaders,
  };
  stream.socket = { remoteAddress: "127.0.0.1" } as unknown as Socket;

  return stream;
}

type MutableServerResponse = Omit<http.ServerResponse, "headersSent" | "writableEnded"> & {
  headersSent: boolean;
  writableEnded: boolean;
  getHeaders(): Record<string, unknown>;
  end: ReturnType<typeof vi.fn>;
};

function createServerResponse() {
  const headers: Record<string, unknown> = {};
  const response = {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    setHeader: vi.fn((key: string, value: unknown) => {
      headers[key.toLowerCase()] = value;
    }),
    getHeader: (key: string) => headers[key.toLowerCase()],
    end: vi.fn(() => {
      response.headersSent = true;
      response.writableEnded = true;
    }),
    getHeaders: () => headers,
  };

  return response as unknown as MutableServerResponse;
}

type MutableStreamingResponse = Omit<http.ServerResponse, "headersSent"> &
  PassThrough & {
    headersSent: boolean;
    getHeaders(): Record<string, unknown>;
  };

function createStreamingResponse() {
  const headers: Record<string, unknown> = {};
  const stream = new PassThrough({ objectMode: false });
  const response = Object.assign(stream, {
    headersSent: false,
    statusCode: 0,
    setHeader: (key: string, value: unknown) => {
      headers[key.toLowerCase()] = value;
    },
    getHeader: (key: string) => headers[key.toLowerCase()],
    getHeaders: () => headers,
  });
  response.on("finish", () => {
    response.headersSent = true;
  });
  return response as unknown as MutableStreamingResponse;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenShiftProviderAdapter", () => {
  it("converte IncomingMessage e preserva rawBody/metadados", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: () => {} });
    const request = createIncomingMessage(['{"hello":"sky"}'], {
      "x-request-id": "req-openshift",
    });
    const rawResponse = createServerResponse();

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.path).toBe("/foo/bar");
    expect(skyRequest.query).toEqual({ lang: "pt" });
    expect(skyRequest.headers["content-type"]).toBe("application/json");
    expect(skyRequest.rawBody?.toString("utf-8")).toBe('{"hello":"sky"}');
    expect(skyRequest.requestId).toBe("req-openshift");

    await adapter.fromSkyResponse(
      { statusCode: 201, body: { ok: true }, headers: { "x-custom": "abc" } },
      request,
      rawResponse,
    );

    expect(rawResponse.statusCode).toBe(201);
    expect(rawResponse.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
    expect(rawResponse.getHeaders()).toMatchObject({
      "x-custom": "abc",
      "content-type": "application/json; charset=utf-8",
    });
  });

  it("não sobrescreve headers existentes e monta contexto com IP/protocolo", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: () => {}, trustProxy: true });
    const request = createIncomingMessage(["name=sky"], {
      "content-type": "application/x-www-form-urlencoded",
    });
    const rawResponse = createServerResponse();
    rawResponse.setHeader("content-type", "text/plain");

    await adapter.fromSkyResponse(
      {
        statusCode: 200,
        body: "ok",
        headers: { "content-type": "application/json" },
      },
      request,
      rawResponse,
    );

    expect(rawResponse.getHeaders()["content-type"]).toBe("text/plain");

    const context = await adapter.createContext(request);
    expect(context.provider).toBe("openshift");
    expect(context.meta).toMatchObject({
      ip: "10.10.0.1",
      protocol: "https",
      host: "sky.local:8080",
    });
  });

  it("usa x-request-id fornecido pelo cliente no contexto", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: () => {} });
    const request = createIncomingMessage([], { "x-request-id": "ctx-custom" });

    const context = await adapter.createContext(request);
    expect(context.requestId).toBe("ctx-custom");
  });

  it("gera requestId quando x-request-id não é fornecido", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: () => {} });
    const request = createIncomingMessage(["{}"]);
    delete request.headers["x-request-id"];

    const context = await adapter.createContext(request);
    expect(context.requestId).toMatch(/^req-/);
  });

  it("aplica limite de tamanho do corpo e emite erro", async () => {
    const adapter = new OpenShiftProviderAdapter({
      maxBodySizeBytes: 4,
      logger: () => {},
    });
    const request = createIncomingMessage(["0123456789"]);

    await expect(adapter.toSkyRequest(request)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
  });

  it("transmite payloads Readable sem ajustar headers extras", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: () => {} });
    const request = createIncomingMessage([]);
    const response = createStreamingResponse();
    const endSpy = vi.spyOn(response, "end");
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    await adapter.fromSkyResponse(
      { statusCode: 200, body: Readable.from(["hello"]) },
      request,
      response,
    );

    expect(Buffer.concat(chunks).toString()).toBe("hello");
    expect(response.getHeaders()["content-type"]).toBeUndefined();
  });

  it("filtra headers hop-by-hop ao enviar resposta", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: () => {} });
    const request = createIncomingMessage([]);
    const response = createServerResponse();

    await adapter.fromSkyResponse(
      {
        statusCode: 200,
        body: "ok",
        headers: {
          connection: "keep-alive",
          "x-safe": "value",
        },
      },
      request,
      response,
    );

    expect(response.getHeaders()).toMatchObject({ "x-safe": "value" });
    expect(response.getHeaders()).not.toHaveProperty("connection");
  });

  it("ignora respostas quando headers já foram enviados", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: () => {} });
    const request = createIncomingMessage([]);
    const response = createServerResponse();
    response.headersSent = true;
    response.writableEnded = true;

    await adapter.fromSkyResponse(
      { statusCode: 200, body: { ok: true } },
      request,
      response,
    );
    expect(response.end).not.toHaveBeenCalled();
  });

  it("ignora respostas quando writableEnded já é true", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: () => {} });
    const request = createIncomingMessage([]);
    const response = createServerResponse();
    response.writableEnded = true;

    await adapter.fromSkyResponse(
      { statusCode: 200, body: { ok: true } },
      request,
      response,
    );
    expect(response.end).not.toHaveBeenCalled();
  });

  it("não envia fallback 500 quando erro acontece após headers terem sido enviados", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: () => {} });
    const request = createIncomingMessage([]);
    const response = createServerResponse();
    response.setHeader = vi.fn(() => {
      response.headersSent = true;
      throw new Error("late failure");
    });

    await expect(
      adapter.fromSkyResponse(
        { statusCode: 200, body: { ok: true }, headers: { "x-error": "1" } },
        request,
        response,
      ),
    ).rejects.toThrow("late failure");
    expect(response.statusCode).not.toBe(500);
  });

  it("serializa payloads primitivos e binários corretamente", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: () => {} });
    const request = createIncomingMessage([]);

    const binary = createServerResponse();
    const bufferPayload = Buffer.from("bin");
    await adapter.fromSkyResponse(
      { statusCode: 200, body: bufferPayload },
      request,
      binary,
    );
    expect(binary.end).toHaveBeenCalledWith(bufferPayload);

    const uintRes = createServerResponse();
    await adapter.fromSkyResponse(
      { statusCode: 200, body: new Uint8Array([1, 2]) },
      request,
      uintRes,
    );
    expect(uintRes.end).toHaveBeenCalledWith(new Uint8Array([1, 2]));

    const numberRes = createServerResponse();
    await adapter.fromSkyResponse(
      { statusCode: 200, body: 42 },
      request,
      numberRes,
    );
    expect(numberRes.end).toHaveBeenCalledWith("42");

    const undefinedRes = createServerResponse();
    await adapter.fromSkyResponse({ statusCode: 204 }, request, undefinedRes);
    expect(undefinedRes.end).toHaveBeenCalledWith(undefined);

    const stringRes = createServerResponse();
    await adapter.fromSkyResponse(
      { statusCode: 200, body: "text" },
      request,
      stringRes,
    );
    expect(stringRes.end).toHaveBeenCalledWith("text");
  });

  it("usa remoteAddress quando não há cabeçalho x-forwarded-for", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: () => {} });
    const request = createIncomingMessage([]);
    delete request.headers["x-forwarded-for"];
    const context = await adapter.createContext(request);
    expect(context.meta?.ip).toBe("127.0.0.1");
  });

  it("usa defaults de método, host e query quando não enviados", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: () => {} });
    const request = createIncomingMessage([]);
    delete request.headers.host;
    request.method = undefined as unknown as string;
    request.url = undefined;

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.method).toBe("GET");
    expect(skyRequest.path).toBe("/");
    expect(skyRequest.query).toEqual({});
  });

  it("retorna contexto com defaults quando headers ausentes", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: () => {} });
    const request = createIncomingMessage([]);
    delete request.headers["x-forwarded-proto"];
    delete request.headers["x-forwarded-for"];
    delete request.headers.host;
    request.url = undefined;

    const context = await adapter.createContext(request);
    expect(context.meta).toMatchObject({
      protocol: "http",
      host: undefined,
      forwardedFor: undefined,
      path: "/",
    });
  });

  it("propaga erros genéricos durante leitura do corpo", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: vi.fn() });
    vi.spyOn(requestUtils, "readIncomingMessage").mockRejectedValueOnce(
      new Error("broken stream"),
    );
    const request = createIncomingMessage([]);
    await expect(adapter.toSkyRequest(request)).rejects.toThrow("broken stream");
  });

  it("reutiliza headers normalizados ao criar contexto depois de toSkyRequest", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: () => {}, trustProxy: true });
    const request = createIncomingMessage([]);
    request.headers["x-forwarded-for"] = ["10.1.0.5", "10.1.0.6"];
    await adapter.toSkyRequest(request);
    request.headers.host = "changed-host";

    const context = await adapter.createContext(request);
    expect(context.meta?.host).toBe("sky.local:8080");
    expect(context.meta?.ip).toBe("10.1.0.5");
  });

  it("manipula responses sem getHeader e ignora headers indefinidos", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: () => {} });
    const request = createIncomingMessage([]);
    const response = {
      headersSent: false,
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn(),
    } as unknown as http.ServerResponse;

    await adapter.fromSkyResponse(
      {
        statusCode: 200,
        body: "ping",
        headers: {
          "x-ignore": undefined as unknown as string,
          "x-keep": "1",
        } as Record<string, string | string[]>,
      },
      request,
      response,
    );

    expect(response.setHeader).toHaveBeenCalledWith("x-keep", "1");
  });

  it("envia fallback 500 quando stream falha antes do envio", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const adapter = new OpenShiftProviderAdapter();
    const request = createIncomingMessage([]);
    const response = createStreamingResponse();
    const endSpy = vi.spyOn(response, "end");
    const failingStream = new Readable({
      read() {
        this.destroy(new Error("stream failure"));
      },
    });

    await expect(
      adapter.fromSkyResponse(
        { statusCode: 200, body: failingStream },
        request,
        response,
      ),
    ).rejects.toThrow("stream failure");
    expect(response.statusCode).toBe(500);
    expect(endSpy).toHaveBeenLastCalledWith("Internal Server Error");
    consoleSpy.mockRestore();
  });

  it("propaga erro quando destino falha durante pipeline", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: () => {} });
    const request = createIncomingMessage([]);
    const response = createStreamingResponse();
    response.once("pipe", () => {
      response.emit("error", new Error("write failure"));
    });

    await expect(
      adapter.fromSkyResponse(
        { statusCode: 200, body: Readable.from(["chunk"]) },
        request,
        response,
      ),
    ).rejects.toThrow("write failure");
  });

  it("usa logger padrão quando nenhum logger é informado", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const adapter = new OpenShiftProviderAdapter();
    const internal = adapter as unknown as {
      log: (message: string, details?: Record<string, unknown>) => void;
    };
    internal.log("sem-detalhes");
    internal.log("com detalhes", { foo: "bar" });
    expect(consoleSpy).toHaveBeenCalledWith("sem-detalhes");
    expect(consoleSpy).toHaveBeenCalledWith("com detalhes", { foo: "bar" });
    consoleSpy.mockRestore();
  });

  it("retorna IP indefinido quando nem forwarded nem socket existem", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: () => {} });
    const request = createIncomingMessage([]);
    delete request.headers["x-forwarded-for"];
    request.socket = undefined as unknown as Socket;

    const context = await adapter.createContext(request);
    expect(context.meta?.ip).toBeUndefined();
  });

  it("usa status 200 quando statusCode não é informado", async () => {
    const adapter = new OpenShiftProviderAdapter({ logger: () => {} });
    const request = createIncomingMessage([]);
    const response = createServerResponse();
    const noStatus = { body: { ok: true } } as SkyResponse;

    await adapter.fromSkyResponse(noStatus, request, response);
    expect(response.statusCode).toBe(200);
  });
});
