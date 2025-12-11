import http from "node:http";
import { Readable } from "node:stream";
import { SkyContext } from "../../core/context";
import { SkyHeaders, SkyRequest, SkyResponse } from "../../core/http";
import { normalizeHeaders, parseBody, parseQueryString } from "../../core/http/parsers";
import {
  ProviderAdapter,
  generateRequestId,
} from "../../core/provider-adapter";
import {
  BodySizeLimitError,
  readIncomingMessage,
} from "../request-utils";

export interface OpenShiftProviderAdapterOptions {
  maxBodySizeBytes?: number;
  logger?: (message: string, details?: Record<string, unknown>) => void;
}

const DEFAULT_BODY_LIMIT = 1_048_576; // 1 MiB

export class OpenShiftProviderAdapter
  implements ProviderAdapter<http.IncomingMessage, http.ServerResponse>
{
  readonly providerName = "openshift";
  private readonly maxBodySize: number;
  private readonly logger: (message: string, details?: Record<string, unknown>) => void;
  private readonly headerCache = new WeakMap<http.IncomingMessage, SkyHeaders>();

  constructor(options: OpenShiftProviderAdapterOptions = {}) {
    this.maxBodySize = options.maxBodySizeBytes ?? DEFAULT_BODY_LIMIT;
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

  async toSkyRequest(rawReq: http.IncomingMessage): Promise<SkyRequest> {
    const headers = this.getHeaders(rawReq);
    const host = this.getFirstHeaderValue(headers, "host") ?? "localhost";
    const url = new URL(rawReq.url ?? "/", `http://${host}`);
    const rawBody = await this.readBody(rawReq);
    const contentType = this.getFirstHeaderValue(headers, "content-type");
    const parsedBody = parseBody(rawBody.length ? rawBody : undefined, contentType);

    return {
      method: (rawReq.method ?? "GET").toUpperCase(),
      path: url.pathname,
      query: url.search ? parseQueryString(url.search) : {},
      headers,
      body: parsedBody.body,
      rawBody: rawBody.length ? rawBody : undefined,
      raw: rawReq,
      requestId: this.getFirstHeaderValue(headers, "x-request-id"),
    };
  }

  async fromSkyResponse(
    skyRes: SkyResponse,
    rawReq: http.IncomingMessage,
    rawRes: http.ServerResponse,
  ): Promise<void> {
    if (rawRes.writableEnded || rawRes.headersSent) {
      return;
    }

    try {
      const status = skyRes.statusCode ?? 200;
      rawRes.statusCode = status;

      const responseHeaders = skyRes.headers ?? {};
      let hasContentType =
        this.hasHeader(rawRes, "content-type") ||
        Object.keys(responseHeaders).some((key) => key.toLowerCase() === "content-type");
      for (const [key, value] of Object.entries(responseHeaders)) {
        if (value === undefined) {
          continue;
        }
        if (this.hasHeader(rawRes, key)) {
          continue;
        }
        rawRes.setHeader(key, value);
      }

      if (
        !hasContentType &&
        this.shouldSetJsonHeader(skyRes.body)
      ) {
        rawRes.setHeader("content-type", "application/json; charset=utf-8");
        hasContentType = true;
      }

      const body = skyRes.body;
      if (this.isReadableStream(body)) {
        await new Promise<void>((resolve, reject) => {
          body
            .once("error", (error) => {
              this.log("Stream response failed", { error });
              reject(error);
            })
            .pipe(rawRes)
            .on("finish", resolve)
            .on("error", (error) => {
              this.log("Failed to send streamed response", { error });
              reject(error);
            });
        });
        return;
      }

      const serialized = this.serializeBody(body);
      rawRes.end(serialized);
    } catch (error) {
      this.log("OpenShift adapter failed to send response", { error });
      if (!rawRes.headersSent) {
        rawRes.statusCode = 500;
        rawRes.end("Internal Server Error");
      }
      throw error;
    }
  }

  async createContext(
    rawReq: http.IncomingMessage,
  ): Promise<SkyContext> {
    const headers = this.getHeaders(rawReq);
    return {
      requestId:
        this.getFirstHeaderValue(headers, "x-request-id") ?? generateRequestId(),
      provider: this.providerName,
      services: {},
      meta: {
        ip: this.extractIp(rawReq, headers),
        host: this.getFirstHeaderValue(headers, "host"),
        protocol: this.getFirstHeaderValue(headers, "x-forwarded-proto") ?? "http",
        userAgent: this.getFirstHeaderValue(headers, "user-agent"),
        forwardedFor: this.getFirstHeaderValue(headers, "x-forwarded-for"),
        path: rawReq.url ?? "/",
      },
    };
  }

  private async readBody(rawReq: http.IncomingMessage): Promise<Buffer> {
    try {
      return await readIncomingMessage(rawReq, {
        maxBodyBytes: this.maxBodySize,
      });
    } catch (error) {
      if (error instanceof BodySizeLimitError) {
        this.log("OpenShift request exceeded max body size", {
          limit: error.limit,
          size: error.size,
        });
      } else {
        this.log("Failed to read OpenShift request body", { error });
      }
      throw error;
    }
  }

  private getHeaders(rawReq: http.IncomingMessage): SkyHeaders {
    const cached = this.headerCache.get(rawReq);
    if (cached) {
      return cached;
    }
    const normalized = normalizeHeaders(
      rawReq.headers as Record<string, string | string[] | undefined>,
    );
    this.headerCache.set(rawReq, normalized);
    return normalized;
  }

  private getFirstHeaderValue(headers: SkyHeaders, key: string): string | undefined {
    const value = headers[key];
    if (Array.isArray(value)) {
      return value[0];
    }
    return value;
  }

  private extractIp(rawReq: http.IncomingMessage, headers: SkyHeaders): string | undefined {
    const forwarded = this.getFirstHeaderValue(headers, "x-forwarded-for");
    if (forwarded) {
      return forwarded.split(",")[0]?.trim();
    }
    return rawReq.socket?.remoteAddress ?? undefined;
  }

  private hasHeader(rawRes: http.ServerResponse, key: string): boolean {
    if (typeof rawRes.getHeader !== "function") {
      return false;
    }
    return rawRes.getHeader(key) !== undefined;
  }

  private shouldSetJsonHeader(body: unknown): boolean {
    if (body === null || body === undefined) {
      return false;
    }
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      return false;
    }
    if (typeof body === "string") {
      return false;
    }
    if (typeof body === "number" || typeof body === "boolean") {
      return false;
    }
    if (this.isReadableStream(body)) {
      return false;
    }
    return true;
  }

  private serializeBody(
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

  private isReadableStream(value: unknown): value is Readable {
    return value instanceof Readable;
  }

  private log(message: string, details?: Record<string, unknown>): void {
    this.logger(message, details);
  }
}
