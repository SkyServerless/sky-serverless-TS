import http, { IncomingMessage, ServerResponse } from "node:http";
import { createHttpHandler } from "../../src/core/provider-adapter";
import {
  GcpFunctionsProviderAdapter,
  GcpRequest,
  GcpResponse,
} from "../../src/providers/gcp/gcpFunctionsProviderAdapter";
import { createDemoApp } from "../shared/demo-app";

const app = createDemoApp();

const adapter = new GcpFunctionsProviderAdapter();
const handler = createHttpHandler(adapter, app);

const port = Number(process.env.PORT ?? 8081);
const host = process.env.BIND_HOST ?? "0.0.0.0";

const server = http.createServer((req, res) => {
  const gcpRequest = toGcpRequest(req);
  const gcpResponse = toGcpResponse(res);

  Promise.resolve(handler(gcpRequest, gcpResponse)).catch((error) => {
    console.error("[GCP] handler failed", error);
    if (!gcpResponse.headersSent) {
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });
});

server.listen(port, host, () => {
  console.log(`[GCP] HTTP Functions emulator listening on ${host}:${port}`);
});

export { server };

function toGcpRequest(raw: IncomingMessage): GcpRequest {
  const request = raw as IncomingMessage & GcpRequest;
  const host = raw.headers.host ?? `localhost:${port}`;
  const urlPath = raw.url ?? "/";
  const url = new URL(urlPath, `http://${host}`);

  request.method = raw.method ?? "GET";
  request.path = url.pathname + url.search;
  request.url = raw.url ?? request.path;
  request.query = buildQueryObject(url);
  request.get = (header: string) => {
    const value = raw.headers[header.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };

  return request;
}

function buildQueryObject(url: URL): Record<string, string | string[]> | undefined {
  if (!url.search) {
    return undefined;
  }

  const params = new URLSearchParams(url.search);
  const entries: Record<string, string | string[]> = {};

  for (const key of params.keys()) {
    const values = params.getAll(key);
    entries[key] = values.length > 1 ? values : values[0];
  }

  return Object.keys(entries).length ? entries : undefined;
}

function toGcpResponse(raw: ServerResponse): GcpResponse {
  const response: GcpResponse = {
    headersSent: raw.headersSent,
    status(code: number) {
      raw.statusCode = code;
      return response;
    },
    set(field: string | Record<string, unknown>, value?: unknown) {
      if (typeof field === "string") {
        raw.setHeader(field, value as string);
      } else {
        for (const [key, headerValue] of Object.entries(field)) {
          raw.setHeader(key, headerValue as string);
        }
      }
      return response;
    },
    send(body?: unknown) {
      if (body === undefined) {
        raw.end();
      } else if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
        raw.end(body);
      } else if (typeof body === "string") {
        raw.end(body);
      } else if (typeof body === "number" || typeof body === "boolean") {
        raw.end(String(body));
      } else {
        raw.end(JSON.stringify(body));
      }
      response.headersSent = true;
    },
  };

  return response;
}
