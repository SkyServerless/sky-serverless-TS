import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkyResponse } from "../src/core/http";
import {
  GcpFunctionsProviderAdapter,
  GcpRequest,
  GcpResponse,
} from "../src/providers/gcp/gcpFunctionsProviderAdapter";
import * as requestUtils from "../src/providers/request-utils";

function createGcpRequest(
  overrides: Partial<GcpRequest> & { body?: unknown } = {},
): GcpRequest & Readable {
  const stream = new Readable({
    read() {
      this.push(null);
    },
  });

  const { headers: overrideHeaders, get: overrideGet, ...rest } = overrides;
  const headers: IncomingHttpHeaders = {
    host: "functions.cloud",
    "content-type": "application/json",
    "x-cloud-trace-context": "trace-123",
  };

  if (overrideHeaders) {
    for (const [key, value] of Object.entries(overrideHeaders)) {
      if (value === undefined || value === null) {
        delete (headers as Record<string, unknown>)[key];
      } else {
        headers[key] = value;
      }
    }
  }

  const request = Object.assign(
    stream,
    {
      method: "POST",
      path: "/api/hello?ref=dev",
      url: "/api/hello?ref=dev",
      query: { env: "dev" },
      headers,
    },
    rest,
  ) as GcpRequest & Readable;
  request.get =
    overrideGet ??
    vi.fn((header: string) => {
      const normalized = header.toLowerCase();
      const value = (headers as Record<string, string | string[]>)[normalized];
      return Array.isArray(value) ? value[0] : value;
    });

  return request;
}

type MockGcpResponse = GcpResponse & {
  payload?: unknown;
  status: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  getHeaders(): Record<string, unknown>;
};

function createGcpResponse(): MockGcpResponse {
  const headers: Record<string, unknown> = {};
  const response = {
    headersSent: false,
  } as MockGcpResponse;

  response.status = vi.fn(() => response);
  response.set = vi.fn((field: string | Record<string, unknown>, value?: unknown) => {
    if (typeof field === "string") {
      headers[field.toLowerCase()] = value;
    } else {
      for (const [key, val] of Object.entries(field)) {
        headers[key.toLowerCase()] = val;
      }
    }
    return response;
  });
  response.send = vi.fn((payload?: unknown) => {
    response.headersSent = true;
    response.payload = payload;
  });
  response.getHeaders = () => headers;

  return response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GcpFunctionsProviderAdapter", () => {
  it("transforma Request Express em SkyRequest com rawBody", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      rawBody: Buffer.from('{"message":"hello"}'),
      body: undefined,
    });

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.method).toBe("POST");
    expect(skyRequest.path).toBe("/api/hello");
    expect(skyRequest.query).toEqual({ env: "dev" });
    expect(skyRequest.body).toEqual({ message: "hello" });
    expect(skyRequest.rawBody?.toString("utf-8")).toBe('{"message":"hello"}');
    expect(skyRequest.requestId).toBe("trace-123");

    const context = await adapter.createContext(request);
    expect(context.provider).toBe("gcp");
    expect(context.requestId).toBe("trace-123");
    expect(context.meta).toMatchObject({
      traceContext: "trace-123",
      host: "functions.cloud",
    });
  });

  it("usa método GET quando a plataforma não envia method", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      method: undefined,
      path: "/heartbeat",
      url: "/heartbeat",
    });

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.method).toBe("GET");
  });

  it("usa querystring da URL quando req.query não está presente", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      query: undefined,
      path: "/simple?team=backend",
      url: "/simple?team=backend",
    });

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.query).toEqual({ team: "backend" });
  });

  it("serializa respostas com defaults para JSON", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest();
    const response = createGcpResponse();

    await adapter.fromSkyResponse(
      { statusCode: 202, body: { ok: true } },
      request,
      response,
    );

    expect(response.status).toHaveBeenCalledWith(202);
    expect(response.set).toHaveBeenCalledWith(
      "content-type",
      "application/json; charset=utf-8",
    );
    expect(response.send).toHaveBeenCalledWith({ ok: true });
  });

  it("usa stream quando rawBody e body estão vazios", async () => {
    vi.spyOn(requestUtils, "readIncomingMessage").mockResolvedValueOnce(
      Buffer.from("fallback"),
    );
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      rawBody: undefined,
      body: undefined,
      headers: { host: "functions.cloud", "content-type": "text/plain" },
    });

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.rawBody?.toString("utf-8")).toBe("fallback");
  });

  it("normaliza query params complexos em strings simples", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      query: {
        list: ["a", "b"],
        count: 2,
        skip: null,
        nested: undefined,
      } as Record<string, unknown>,
    });

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.query).toEqual({ list: ["a", "b"], count: "2" });
  });

  it("não define content-type extra para textos ou buffers", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest();
    const response = createGcpResponse();

    await adapter.fromSkyResponse(
      { statusCode: 200, body: "plain" },
      request,
      response,
    );

    expect(response.set).not.toHaveBeenCalled();
    expect(response.send).toHaveBeenCalledWith("plain");
  });

  it("transforma Uint8Array e boolean para formatos suportados", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest();
    const bufferResponse = createGcpResponse();

    await adapter.fromSkyResponse(
      { statusCode: 200, body: new Uint8Array([1, 2, 3]) },
      request,
      bufferResponse,
    );
    expect(bufferResponse.payload).toBeInstanceOf(Buffer);

    const booleanResponse = createGcpResponse();
    await adapter.fromSkyResponse(
      { statusCode: 200, body: true },
      request,
      booleanResponse,
    );
    expect(booleanResponse.payload).toBe("true");
  });

  it("remove headers hop-by-hop das respostas", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest();
    const response = createGcpResponse();

    await adapter.fromSkyResponse(
      {
        statusCode: 200,
        body: { ok: true },
        headers: {
          connection: "keep-alive",
          "x-data": "42",
        },
      },
      request,
      response,
    );

    expect(response.set).toHaveBeenCalledWith("x-data", "42");
    expect(
      (response as GcpResponse & { getHeaders(): Record<string, unknown> }).getHeaders(),
    ).not.toHaveProperty("connection");
  });

  it("respeita maxBodySizeBytes quando rawBody excede o limite", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {}, maxBodySizeBytes: 4 });
    const request = createGcpRequest({
      rawBody: Buffer.from("0123456789"),
      body: undefined,
    });

    await expect(adapter.toSkyRequest(request)).rejects.toMatchObject({
      code: "payload_too_large",
    });
  });

  it("gera requestId quando headers não possuem trace-id", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      headers: {
        host: "functions.cloud",
        "x-cloud-trace-context": undefined,
      },
      get: undefined,
      rawBody: undefined,
      body: undefined,
    });
    const context = await adapter.createContext(request);
    expect(context.requestId).toMatch(/^req-/);
  });

  it("propaga erro e retorna 500 quando set falha", async () => {
    const logger = vi.fn();
    const adapter = new GcpFunctionsProviderAdapter({ logger });
    const request = createGcpRequest();
    const response: GcpResponse = {
      headersSent: false,
      status: (() => response) as GcpResponse["status"],
      set: vi.fn(() => {
        throw new Error("boom");
      }),
      send: vi.fn(),
    };
    const statusMock = vi.fn(() => response);
    response.status = statusMock;

    await expect(
      adapter.fromSkyResponse(
        { statusCode: 200, headers: { "x-test": "ok" } },
        request,
        response,
      ),
    ).rejects.toThrow("boom");

    expect(logger).toHaveBeenCalledWith("GCP adapter failed to send response", expect.any(Object));
    expect(statusMock).toHaveBeenLastCalledWith(500);
    expect(response.send).toHaveBeenCalledWith({ message: "Internal Server Error" });
  });

  it("ignora resposta quando headers já foram enviados", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest();
    const response = createGcpResponse();
    response.headersSent = true;

    await adapter.fromSkyResponse({ statusCode: 200, body: { ok: true } }, request, response);
    expect(response.status).not.toHaveBeenCalled();
  });

  it("respeita content-type custom e ignora headers indefinidos", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest();
    const response = createGcpResponse();

    await adapter.fromSkyResponse(
      {
        statusCode: 200,
        body: "<html/>",
        headers: {
          "content-type": "text/html",
          "x-null": undefined as unknown as string,
        } as Record<string, string | string[]>,
      },
      request,
      response,
    );

    expect(response.set).toHaveBeenCalledWith("content-type", "text/html");
  });

  it("normaliza headers quando valores são arrays", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      headers: {
        host: ["multi.host.com", "fallback"],
        "content-type": "application/json",
        "x-cloud-trace-context": ["trace-array"],
      } as Record<string, string | string[]>,
    });

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.headers.host).toEqual(["multi.host.com", "fallback"]);

    const context = await adapter.createContext(request);
    expect(context.meta?.host).toBe("multi.host.com");
    expect(context.requestId).toBe("trace-array");
  });

  it("interpreta req.query string e ausência de query", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      query: "token=abc",
      path: "/plain",
      url: "/plain",
    });

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.query).toEqual({ token: "abc" });

    const noQuery = createGcpRequest({
      query: undefined,
      path: "/plain",
      url: "/plain",
    });
    noQuery.query = undefined;
    const withoutQuery = await adapter.toSkyRequest(noQuery);
    expect(withoutQuery.query).toBeUndefined();
  });

  it("usa rawReq.url quando path não está disponível", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      path: undefined,
      url: "/only-url?debug=true",
      query: undefined,
    });

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.path).toBe("/only-url");
    expect(skyRequest.query).toEqual({ debug: "true" });
  });

  it("usa host localhost quando cabeçalho está ausente", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      headers: {
        host: undefined as unknown as string,
        "content-type": "application/json",
        "x-cloud-trace-context": "trace-123",
      },
      path: undefined,
      url: "/hostless",
    });

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.path).toBe("/hostless");
    expect(skyRequest.headers.host).toBeUndefined();
  });

  it("ignora querystring vazia ao usar fallback da URL", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      query: undefined,
      path: "/empty?&",
      url: "/empty?&",
    });

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.query).toBeUndefined();
  });

  it("resolve raw body a partir de strings e objetos", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const requestWithString = createGcpRequest({
      rawBody: undefined,
      body: "gcp-body",
      headers: { host: "functions.cloud", "content-type": "text/plain" },
    });
    const stringRequest = await adapter.toSkyRequest(requestWithString);
    expect(stringRequest.rawBody?.toString("utf-8")).toBe("gcp-body");

    const requestWithObject = createGcpRequest({
      rawBody: undefined,
      body: { nested: true },
      headers: { host: "functions.cloud", "content-type": "application/json" },
    });
    const objectRequest = await adapter.toSkyRequest(requestWithObject);
    expect(objectRequest.rawBody?.toString("utf-8")).toBe('{"nested":true}');

    const requestWithRawString = createGcpRequest({
      rawBody: "raw-platform-body",
      body: undefined,
      headers: { host: "functions.cloud", "content-type": "text/plain" },
    });
    const rawStringRequest = await adapter.toSkyRequest(requestWithRawString);
    expect(rawStringRequest.rawBody?.toString("utf-8")).toBe("raw-platform-body");
  });

  it("loga erro quando não consegue serializar o body", async () => {
    const logger = vi.fn();
    const adapter = new GcpFunctionsProviderAdapter({ logger });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const request = createGcpRequest({
      rawBody: undefined,
      body: circular,
      headers: { "content-type": "application/json" } as IncomingHttpHeaders,
    });
    await adapter.toSkyRequest(request);
    expect(logger).toHaveBeenCalledWith("Failed to serialize request body", expect.any(Object));
  });

  it("retorna undefined quando stream não tem payload", async () => {
    vi.spyOn(requestUtils, "readIncomingMessage").mockResolvedValueOnce(Buffer.alloc(0));
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({ rawBody: undefined, body: undefined });
    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.rawBody).toBeUndefined();
  });

  it("não tenta serializar objetos sem content-type JSON", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      rawBody: undefined,
      body: { html: true },
      headers: { "content-type": "text/html" } as IncomingHttpHeaders,
    });

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.rawBody).toBeUndefined();
  });

  it("serializa objetos para content-type custom com +json", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      rawBody: undefined,
      body: { custom: true },
      headers: { "content-type": "application/vnd.company+json" } as IncomingHttpHeaders,
    });

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.rawBody?.toString("utf-8")).toBe('{"custom":true}');
  });

  it("não serializa objetos quando content-type está ausente", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      rawBody: undefined,
      body: { missing: true },
      headers: { "content-type": undefined } as unknown as IncomingHttpHeaders,
    });

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.rawBody).toBeUndefined();
  });

  it("ignora content-type sem tipo base ao serializar objetos", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      rawBody: undefined,
      body: { weird: true },
      headers: { "content-type": "; charset=utf-8" } as IncomingHttpHeaders,
    });

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.rawBody).toBeUndefined();
  });

  it("evita ler stream para GET sem payload anunciado", async () => {
    const streamSpy = vi.spyOn(requestUtils, "readIncomingMessage");
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      rawBody: undefined,
      body: undefined,
      headers: {
        "content-length": undefined,
        "transfer-encoding": undefined,
      } as IncomingHttpHeaders,
    });
    request.method = "GET";

    const skyRequest = await adapter.toSkyRequest(request);
    expect(streamSpy).not.toHaveBeenCalled();
    expect(skyRequest.rawBody).toBeUndefined();
    streamSpy.mockRestore();
  });

  it("considera arrays em transfer-encoding ao decidir stream", async () => {
    const streamSpy = vi
      .spyOn(requestUtils, "readIncomingMessage")
      .mockResolvedValueOnce(Buffer.from('{"chunked":true}'));
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      rawBody: undefined,
      body: undefined,
      headers: {
        "transfer-encoding": ["", "chunked"],
      } as unknown as IncomingHttpHeaders,
    });
    request.method = "GET";

    await adapter.toSkyRequest(request);
    expect(streamSpy).toHaveBeenCalled();
    streamSpy.mockRestore();
  });

  it("usa primeiro valor de content-length quando header é array", async () => {
    const streamSpy = vi.spyOn(requestUtils, "readIncomingMessage");
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      rawBody: undefined,
      body: undefined,
      headers: {
        "content-length": ["0", "99"],
      } as unknown as IncomingHttpHeaders,
    });
    request.method = "HEAD";

    await adapter.toSkyRequest(request);
    expect(streamSpy).not.toHaveBeenCalled();
    streamSpy.mockRestore();
  });

  it("lê stream para GET com content-length maior que zero", async () => {
    const streamSpy = vi
      .spyOn(requestUtils, "readIncomingMessage")
      .mockResolvedValueOnce(Buffer.from('{"len":1}'));
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      rawBody: undefined,
      body: undefined,
      headers: {
        "content-length": "10",
      } as IncomingHttpHeaders,
    });
    request.method = "GET";

    await adapter.toSkyRequest(request);
    expect(streamSpy).toHaveBeenCalled();
    streamSpy.mockRestore();
  });

  it("não aplica header JSON quando body é indefinido", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest();
    const response = createGcpResponse();

    await adapter.fromSkyResponse({ statusCode: 204 }, request, response);
    expect(response.set).not.toHaveBeenCalled();
    expect(response.send).toHaveBeenCalledWith(undefined);
  });

  it("usa logger padrão quando nenhum logger customizado é informado", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const adapter = new GcpFunctionsProviderAdapter();
    const internal = adapter as unknown as {
      log: (message: string, details?: Record<string, unknown>) => void;
    };
    internal.log("log simples");
    internal.log("log com detalhes", { request: "1" });
    expect(consoleSpy).toHaveBeenCalledWith("log simples");
    expect(consoleSpy).toHaveBeenCalledWith("log com detalhes", { request: "1" });
    consoleSpy.mockRestore();
  });

  it("usa status 200 quando statusCode não é informado", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest();
    const response = createGcpResponse();
    const noStatus = { body: { ok: true } } as SkyResponse;

    await adapter.fromSkyResponse(noStatus, request, response);
    expect(response.status).toHaveBeenCalledWith(200);
  });

  it("não envia fallback 500 quando erro acontece após headers serem enviados", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest();
    const response = createGcpResponse();
    const originalStatus = response.status;
    response.set = vi.fn(() => {
      response.headersSent = true;
      throw new Error("late failure");
    }) as typeof response.set;

    await expect(
      adapter.fromSkyResponse(
        { statusCode: 200, headers: { "x-crash": "1" }, body: { ok: true } },
        request,
        response,
      ),
    ).rejects.toThrow("late failure");

    expect(originalStatus).toHaveBeenCalledWith(200);
    expect(originalStatus).not.toHaveBeenCalledWith(500);
  });

  it("usa defaults de host e caminho raiz quando plataforma não envia dados", async () => {
    const adapter = new GcpFunctionsProviderAdapter({ logger: () => {} });
    const request = createGcpRequest({
      headers: {} as GcpRequest["headers"],
      path: undefined,
      url: undefined,
      query: undefined,
      get: undefined,
    });

    const skyRequest = await adapter.toSkyRequest(request);
    expect(skyRequest.path).toBe("/");
  });
});
