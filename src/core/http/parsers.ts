import { SkyHeaders } from "../http";

export interface ParseBodyResult<TBody = unknown> {
  body: TBody;
  contentType: string | undefined;
}

export class BodyParserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyParserError";
  }
}

export function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): SkyHeaders {
  const normalized: SkyHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!key) {
      continue;
    }
    const targetKey = key.toLowerCase();
    if (value === undefined) {
      continue;
    }
    normalized[targetKey] = value;
  }

  return normalized;
}

export function parseQueryString(
  query: string,
): Record<string, string | string[]> {
  const normalized = query.startsWith("?") ? query.slice(1) : query;
  const params = new URLSearchParams(normalized);
  const result: Record<string, string | string[]> = {};

  for (const [key, value] of params.entries()) {
    if (key in result) {
      const existing = result[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        result[key] = [existing, value];
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}

export function parseBody(
  rawBody: Buffer | Uint8Array | string | null | undefined,
  contentType?: string | null,
): ParseBodyResult {
  const normalizedType = contentType?.split(";")[0].trim().toLowerCase();
  if (rawBody === undefined || rawBody === null || rawBody.length === 0) {
    return { body: undefined, contentType: normalizedType };
  }

  if (!normalizedType) {
    return { body: rawBody, contentType: normalizedType };
  }

  if (normalizedType === "application/json") {
    try {
      const jsonString =
        typeof rawBody === "string"
          ? rawBody
          : Buffer.from(rawBody).toString("utf-8");
      return {
        body: JSON.parse(jsonString),
        contentType: normalizedType,
      };
    } catch (error) {
      throw new BodyParserError(
        `Invalid JSON payload: ${(error as Error).message}`,
      );
    }
  }

  if (normalizedType === "application/x-www-form-urlencoded") {
    const decoded =
      typeof rawBody === "string"
        ? rawBody
        : Buffer.from(rawBody).toString("utf-8");
    return {
      body: parseQueryString(decoded),
      contentType: normalizedType,
    };
  }

  if (normalizedType.startsWith("text/")) {
    return {
      body:
        typeof rawBody === "string"
          ? rawBody
          : Buffer.from(rawBody).toString("utf-8"),
      contentType: normalizedType,
    };
  }

  return {
    body: typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody,
    contentType: normalizedType,
  };
}
