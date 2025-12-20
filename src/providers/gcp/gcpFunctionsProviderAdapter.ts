import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "stream";
import { SkyContext } from "../../core/context";
import { HOP_BY_HOP_HEADERS, PayloadTooLargeError, SkyHeaders, SkyRequest, SkyResponse } from "../../core/http";
import { normalizeHeaders, parseBody, parseQueryString } from "../../core/http/parsers";
import {
  ProviderAdapter,
  generateRequestId,
  sanitizeRequestId,
} from "../../core/provider-adapter";
import { getClientIp, readIncomingMessage, TrustProxyConfig } from "../request-utils";

type HeaderValue = string | number | readonly string[];
type HeaderMap = Record<string, HeaderValue>;

export interface GcpRequest<
  TBody = unknown,
  TQuery extends Record<string, unknown> = Record<string, unknown>,
> extends Readable {
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
  maxBodySizeBytes?: number;
  trustProxy?: TrustProxyConfig;
  logger?: (message: string, details?: Record<string, unknown>) => void;
}

const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;

export class GcpFunctionsProviderAdapter
  implements ProviderAdapter<GcpRequest, GcpResponse>
{
  readonly providerName = "gcp";
  private readonly logger: (message: string, details?: Record<string, unknown>) => void;
  private readonly maxBodySizeBytes: number;
  private readonly trustProxy?: TrustProxyConfig;

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
    this.maxBodySizeBytes = options.maxBodySizeBytes ?? DEFAULT_BODY_LIMIT_BYTES;
    this.trustProxy = options.trustProxy ?? true;
  }

  async toSkyRequest(rawReq: GcpRequest): Promise<SkyRequest> {
    const headers = this.normalizeHeaders(rawReq.headers);
    const host = this.getHeader(headers, "host") ?? "localhost";
    const requestUrl = rawReq.path ?? rawReq.url ?? "/";
    const url = new URL(requestUrl, `http://${host}`);

    const rawBody = await this.resolveRawBody(rawReq, headers);
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
        if (HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
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
    const ip = getClientIp(rawReq.headers, this.trustProxy);
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
        ip,
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

  private async resolveRawBody(rawReq: GcpRequest, headers: SkyHeaders): Promise<Buffer | undefined> {
    const checkSize = (buf: Buffer) => {
      if (Number.isFinite(this.maxBodySizeBytes) && buf.length > this.maxBodySizeBytes) {
        throw new PayloadTooLargeError('Request body too large', this.maxBodySizeBytes);
      }
    };

    if (Buffer.isBuffer(rawReq.rawBody)) {
      checkSize(rawReq.rawBody);
      return rawReq.rawBody;
    }
    if (typeof rawReq.rawBody === "string") {
      const buffer = Buffer.from(rawReq.rawBody);
      checkSize(buffer);
      return buffer;
    }
    if (typeof rawReq.body === "string") {
      const buffer = Buffer.from(rawReq.body);
      checkSize(buffer);
      return buffer;
    }
    if (rawReq.body && typeof rawReq.body === "object") {
      const contentType = this.getHeader(headers, "content-type");
      if (this.isJsonContentType(contentType)) {
        try {
          const json = JSON.stringify(rawReq.body);
          const buffer = Buffer.from(json);
          checkSize(buffer);
          return buffer;
        } catch (error) {
          this.log("Failed to serialize request body", { error });
        }
      }
    }

    if (!this.shouldStreamBody(rawReq)) {
      return undefined;
    }
    const buffer = await readIncomingMessage(rawReq, { maxBytes: this.maxBodySizeBytes });
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

    if (traceHeader) {
      const [traceId] = traceHeader.split('/');
      return sanitizeRequestId(traceId);
    }

    return generateRequestId();
  }

  private log(message: string, details?: Record<string, unknown>): void {
    this.logger(message, details);
  }

  private shouldStreamBody(rawReq: GcpRequest): boolean {
    const method = (rawReq.method ?? "GET").toUpperCase();
    const transferEncoding = rawReq.headers["transfer-encoding"];
    const hasTransferEncoding = Array.isArray(transferEncoding)
      ? transferEncoding.some(Boolean)
      : Boolean(transferEncoding);
    const contentLengthHeader = rawReq.headers["content-length"];
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

  private isJsonContentType(contentType?: string): boolean {
    if (!contentType) {
      return false;
    }
    const normalized = contentType.split(";")[0]?.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return normalized === "application/json" || normalized.endsWith("+json");
  }
}
