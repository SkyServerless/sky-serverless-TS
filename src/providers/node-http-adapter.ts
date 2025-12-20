import http from "node:http";
import { App } from "../core/app";
import { SkyContext } from "../core/context";
import {
  ProviderAdapter,
  createHttpHandler,
  generateRequestId,
  sanitizeRequestId,
} from "../core/provider-adapter";
import { normalizeHeaders, parseBody, parseQueryString } from "../core/http/parsers";
import { getClientIp, readIncomingMessage, TrustProxyConfig } from "./request-utils";
import { HOP_BY_HOP_HEADERS } from "../core/http";

const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;

export interface NodeHttpAdapterOptions {
  providerName?: string;
  maxBodySizeBytes?: number;
  trustProxy?: TrustProxyConfig;
  extendContext?: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => Partial<SkyContext> | Promise<Partial<SkyContext>>;
}

export interface NodeHttpServerOptions extends NodeHttpAdapterOptions {
  port?: number;
  host?: string;
  logger?: (message: string) => void;
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
}

export function createNodeHttpAdapter(
  options: NodeHttpAdapterOptions = {},
): ProviderAdapter<http.IncomingMessage, http.ServerResponse> {
  const providerName = options.providerName ?? "local-node";
  const maxBodySizeBytes = options.maxBodySizeBytes ?? DEFAULT_BODY_LIMIT_BYTES;

  return {
    providerName,
    async toSkyRequest(rawRequest) {
      const url = new URL(
        rawRequest.url ?? "/",
        `http://${rawRequest.headers.host ?? "localhost"}`,
      );
      const bodyBuffer = (shouldReadRequestBody(rawRequest)
        ? await readIncomingMessage(rawRequest, { maxBytes: maxBodySizeBytes })
        : Buffer.alloc(0));
      const parsedBody = parseBody(
        bodyBuffer.length ? bodyBuffer : undefined,
        rawRequest.headers["content-type"],
      );
      const headerRequestId = rawRequest.headers["x-request-id"] as string | undefined;

      return {
        method: rawRequest.method ?? "GET",
        path: url.pathname,
        query: parseQueryString(url.search),
        headers: normalizeHeaders(
          rawRequest.headers as Record<string, string | string[] | undefined>,
        ),
        body: parsedBody.body,
        requestId: headerRequestId ? sanitizeRequestId(headerRequestId) : undefined,
      };
    },
    async fromSkyResponse(response, _rawRequest, rawResponse) {
      rawResponse.statusCode = response.statusCode;
      let hasContentType = false;
      if (response.headers) {
        for (const [key, value] of Object.entries(response.headers)) {
          if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
            rawResponse.setHeader(key, value as string);
            if (key.toLowerCase() === "content-type") {
              hasContentType = true;
            }
          }
        }
      }
      if (!hasContentType && shouldDefaultJson(response.body)) {
        rawResponse.setHeader("content-type", "application/json; charset=utf-8");
      }
      rawResponse.end(serializeBody(response.body));
    },
    async createContext(rawRequest, rawResponse) {
      const partial = (await options.extendContext?.(rawRequest, rawResponse)) ?? {};
      const headerRequestId = rawRequest.headers["x-request-id"] as string | undefined;
      const ip = getClientIp(
        rawRequest.headers,
        options.trustProxy,
        rawRequest.socket.remoteAddress,
      );
      const context: SkyContext = {
        requestId:
          partial.requestId ??
          (headerRequestId ? sanitizeRequestId(headerRequestId) : generateRequestId()),
        provider: providerName,
        services: partial.services ?? {},
        meta: {
          ...(partial.meta ?? {}),
          ip: partial.meta?.ip ?? ip,
        },
      };
      return context;
    },
  };
}

export function startNodeHttpServer(
  app: App,
  options: NodeHttpServerOptions = {},
): http.Server {
  const adapter = createNodeHttpAdapter(options);
  const handler = createHttpHandler(adapter, app);
  const server = http.createServer(handler);

  const port =
    options.port ??
    Number(process.env.SKY_HTTP_PORT ?? process.env.PORT ?? 3000);
  const host = options.host ?? "0.0.0.0";
  const logger = options.logger ?? console.log;

  server.headersTimeout = options.headersTimeoutMs ?? 10_000;
  server.requestTimeout = options.requestTimeoutMs ?? 30_000;
  server.keepAliveTimeout = options.keepAliveTimeoutMs ?? 5_000;

  server.listen(port, host, () => {
    const displayHost = host === "0.0.0.0" ? "localhost" : host;
    logger(`Sky HTTP dev server running at http://${displayHost}:${port}`);
  });

  return server;
}

function serializeBody(
  body: unknown,
): string | Buffer | Uint8Array | undefined {
  if (body === undefined) {
    return undefined;
  }

  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return body;
  }

  if (typeof body === "string") {
    return body;
  }

  if (typeof body === "number" || typeof body === "boolean") {
    return String(body);
  }

  return JSON.stringify(body);
}

function shouldDefaultJson(body: unknown): boolean {
  if (body === undefined || body === null) {
    return false;
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return false;
  }
  if (typeof body === "string" || typeof body === "number" || typeof body === "boolean") {
    return false;
  }
  return true;
}

function shouldReadRequestBody(request: http.IncomingMessage): boolean {
  const method = (request.method ?? "GET").toUpperCase();
  const transferEncoding = request.headers["transfer-encoding"];
  const contentLengthHeader = request.headers["content-length"];
  const hasTransferEncoding = !!transferEncoding;
  const contentLength = Array.isArray(contentLengthHeader)
    ? contentLengthHeader[0]
    : contentLengthHeader;

  if ((method === "GET" || method === "HEAD") && !hasTransferEncoding) {
    if (!contentLength || Number(contentLength) === 0) {
      return false;
    }
  }

  return true;
}
