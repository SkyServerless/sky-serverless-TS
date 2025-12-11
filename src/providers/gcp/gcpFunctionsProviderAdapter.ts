import type { IncomingHttpHeaders } from "node:http";
import { SkyContext } from "../../core/context";
import { SkyHeaders, SkyRequest, SkyResponse } from "../../core/http";
import { normalizeHeaders, parseBody, parseQueryString } from "../../core/http/parsers";
import {
  ProviderAdapter,
  generateRequestId,
} from "../../core/provider-adapter";
import { readIncomingMessage } from "../request-utils";

type HeaderValue = string | number | readonly string[];
type HeaderMap = Record<string, HeaderValue>;

export interface GcpRequest<
  TBody = unknown,
  TQuery extends Record<string, unknown> = Record<string, unknown>,
> extends NodeJS.ReadableStream {
  method?: string;
  path?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  query?: TQuery | string;
  body?: TBody;
  rawBody?: Buffer | string;
  get?(header: string): string | undefined;
}

export interface GcpResponse {
  headersSent?: boolean;
  status(code: number): GcpResponse;
  set(field: string | HeaderMap, value?: HeaderValue): GcpResponse;
  send(body?: unknown): void;
}

export interface GcpFunctionsProviderAdapterOptions {
  logger?: (message: string, details?: Record<string, unknown>) => void;
}

export class GcpFunctionsProviderAdapter
  implements ProviderAdapter<GcpRequest, GcpResponse>
{
  readonly providerName = "gcp";
  private readonly logger: (message: string, details?: Record<string, unknown>) => void;

  constructor(options: GcpFunctionsProviderAdapterOptions = {}) {
    this.logger =
      options.logger ??
      ((message, details) => {
        if (details) {
          console.error(message, details);
        } else {
          console.error(message);
        }
      });
  }

  async toSkyRequest(rawReq: GcpRequest): Promise<SkyRequest> {
    const headers = this.normalizeHeaders(rawReq.headers);
    const host = this.getHeader(headers, "host") ?? "localhost";
    const requestUrl = rawReq.path ?? rawReq.url ?? "/";
    const url = new URL(requestUrl, `http://${host}`);

    const rawBody = await this.resolveRawBody(rawReq);
    let body = rawReq.body;
    if (body === undefined && rawBody) {
      const contentType = this.getHeader(headers, "content-type");
      body = parseBody(rawBody, contentType).body;
    }

    const query = this.normalizeQuery(rawReq.query, url.search);
    const requestId = this.getRequestId(rawReq, headers);

    return {
      method: (rawReq.method ?? "GET").toUpperCase(),
      path: url.pathname,
      query,
      headers,
      body,
      rawBody,
      raw: rawReq,
      requestId,
    };
  }

  async fromSkyResponse(
    skyRes: SkyResponse,
    rawReq: GcpRequest,
    rawRes: GcpResponse,
  ): Promise<void> {
    if (rawRes.headersSent) {
      return;
    }

    try {
      let response = rawRes.status(skyRes.statusCode ?? 200);
      const headers = skyRes.headers ?? {};
      let hasContentType = false;

      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) {
          continue;
        }
        response = response.set(key, value as HeaderValue);
        if (key.toLowerCase() === "content-type") {
          hasContentType = true;
        }
      }

      if (!hasContentType && this.shouldDefaultJson(skyRes.body)) {
        response = response.set("content-type", "application/json; charset=utf-8");
      }

      response.send(this.transformBodyPayload(skyRes.body));
    } catch (error) {
      this.log("GCP adapter failed to send response", { error });
      if (!rawRes.headersSent) {
        rawRes.status(500).send({ message: "Internal Server Error" });
      }
      throw error;
    }
  }

  async createContext(
    rawReq: GcpRequest,
  ): Promise<SkyContext> {
    const headers = this.normalizeHeaders(rawReq.headers);
    return {
      requestId: this.getRequestId(rawReq, headers),
      provider: this.providerName,
      services: {},
      meta: {
        functionName: process.env.FUNCTION_NAME,
        projectId: process.env.GCP_PROJECT ?? process.env.GCLOUD_PROJECT,
        traceContext: this.getHeader(headers, "x-cloud-trace-context"),
        host: this.getHeader(headers, "host"),
        userAgent: this.getHeader(headers, "user-agent"),
      },
    };
  }

  private normalizeHeaders(
    headers: IncomingHttpHeaders,
  ): SkyHeaders {
    return normalizeHeaders(headers as Record<string, string | string[] | undefined>);
  }

  private getHeader(headers: SkyHeaders, key: string): string | undefined {
    const value = headers[key];
    if (Array.isArray(value)) {
      return value[0];
    }
    return value;
  }

  private normalizeQuery(
    provided: unknown,
    search: string,
  ): Record<string, string | string[]> | undefined {
    if (provided && typeof provided === "object" && !Array.isArray(provided)) {
      const result: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(provided as Record<string, unknown>)) {
        if (value === undefined || value === null) {
          continue;
        }
        if (Array.isArray(value)) {
          result[key] = value.map((item) => String(item));
        } else {
          result[key] = String(value);
        }
      }
      return result;
    }

    if (typeof provided === "string") {
      return parseQueryString(provided);
    }

    if (search) {
      const parsed = parseQueryString(search);
      return Object.keys(parsed).length ? parsed : undefined;
    }

    return undefined;
  }

  private async resolveRawBody(rawReq: GcpRequest): Promise<Buffer | undefined> {
    if (Buffer.isBuffer(rawReq.rawBody)) {
      return rawReq.rawBody;
    }
    if (typeof rawReq.rawBody === "string") {
      return Buffer.from(rawReq.rawBody);
    }
    if (typeof rawReq.body === "string") {
      return Buffer.from(rawReq.body);
    }
    if (rawReq.body && typeof rawReq.body === "object") {
      try {
        return Buffer.from(JSON.stringify(rawReq.body));
      } catch (error) {
        this.log("Failed to serialize request body", { error });
      }
    }

    const buffer = await readIncomingMessage(rawReq);
    return buffer.length ? buffer : undefined;
  }

  private transformBodyPayload(body: unknown): unknown {
    if (body instanceof Uint8Array && !Buffer.isBuffer(body)) {
      return Buffer.from(body);
    }
    if (typeof body === "number" || typeof body === "boolean") {
      return String(body);
    }
    return body;
  }

  private shouldDefaultJson(body: unknown): boolean {
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

  private getRequestId(rawReq: GcpRequest, headers: SkyHeaders): string {
    const traceHeader =
      rawReq.get?.("X-Cloud-Trace-Context") ??
      this.getHeader(headers, "x-cloud-trace-context");
    return traceHeader ?? generateRequestId();
  }

  private log(message: string, details?: Record<string, unknown>): void {
    this.logger(message, details);
  }
}
