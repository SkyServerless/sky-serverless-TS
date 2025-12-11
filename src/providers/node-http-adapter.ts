import http from "node:http";
import { App } from "../core/app";
import { SkyContext } from "../core/context";
import {
  ProviderAdapter,
  createHttpHandler,
  generateRequestId,
} from "../core/provider-adapter";
import { normalizeHeaders, parseBody, parseQueryString } from "../core/http/parsers";
import { readIncomingMessage } from "./request-utils";

export interface NodeHttpAdapterOptions {
  providerName?: string;
  extendContext?: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => Partial<SkyContext> | Promise<Partial<SkyContext>>;
}

export interface NodeHttpServerOptions extends NodeHttpAdapterOptions {
  port?: number;
  host?: string;
  logger?: (message: string) => void;
}

export function createNodeHttpAdapter(
  options: NodeHttpAdapterOptions = {},
): ProviderAdapter<http.IncomingMessage, http.ServerResponse> {
  const providerName = options.providerName ?? "local-node";
  return {
    providerName,
    async toSkyRequest(rawRequest) {
      const url = new URL(
        rawRequest.url ?? "/",
        `http://${rawRequest.headers.host ?? "localhost"}`,
      );
      const bodyBuffer = await readIncomingMessage(rawRequest);
      const parsedBody = parseBody(
        bodyBuffer.length ? bodyBuffer : undefined,
        rawRequest.headers["content-type"],
      );

      return {
        method: rawRequest.method ?? "GET",
        path: url.pathname,
        query: parseQueryString(url.search),
        headers: normalizeHeaders(
          rawRequest.headers as Record<string, string | string[] | undefined>,
        ),
        body: parsedBody.body,
        requestId: rawRequest.headers["x-request-id"] as string | undefined,
      };
    },
    async fromSkyResponse(response, _rawRequest, rawResponse) {
      rawResponse.statusCode = response.statusCode;
      if (response.headers) {
        for (const [key, value] of Object.entries(response.headers)) {
          rawResponse.setHeader(key, value as string);
        }
      }
      rawResponse.end(serializeBody(response.body));
    },
    async createContext(rawRequest, rawResponse) {
      const partial = (await options.extendContext?.(rawRequest, rawResponse)) ?? {};
      const context: SkyContext = {
        requestId:
          partial.requestId ??
          (rawRequest.headers["x-request-id"] as string | undefined) ??
          generateRequestId(),
        provider: providerName,
        services: partial.services ?? {},
        meta: {
          ...(partial.meta ?? {}),
          ip: partial.meta?.ip ?? rawRequest.socket.remoteAddress,
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
