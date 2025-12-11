import { SkyHeaders, SkyResponse } from "../http";

export interface HttpErrorOptions {
  message?: string;
  statusCode?: number;
  details?: unknown;
  headers?: SkyHeaders;
}

export const httpOk = <TBody>(
  body: TBody,
  headers?: SkyHeaders,
): SkyResponse<TBody> => ({
  statusCode: 200,
  body,
  headers,
});

export const httpBadRequest = (
  message: string,
  details?: unknown,
  headers?: SkyHeaders,
): SkyResponse => createErrorResponse(400, message, details, headers);

export const httpNotFound = (
  message = "Route not found",
  details?: unknown,
  headers?: SkyHeaders,
): SkyResponse => createErrorResponse(404, message, details, headers);

export const httpError = (options: HttpErrorOptions = {}): SkyResponse =>
  createErrorResponse(
    options.statusCode ?? 500,
    options.message ?? "Internal Server Error",
    options.details,
    options.headers,
  );

export type HandlerResult =
  | SkyResponse
  | string
  | number
  | boolean
  | Buffer
  | Record<string, unknown>
  | null
  | void;

export function normalizeHandlerResult(result: HandlerResult): SkyResponse {
  if (isSkyResponse(result)) {
    return result;
  }

  if (result === undefined || result === null) {
    return { statusCode: 200 };
  }

  if (
    typeof result === "string" ||
    typeof result === "number" ||
    typeof result === "boolean"
  ) {
    return { statusCode: 200, body: result };
  }

  return { statusCode: 200, body: result };
}

function createErrorResponse(
  statusCode: number,
  message: string,
  details?: unknown,
  headers?: SkyHeaders,
): SkyResponse {
  const payload: Record<string, unknown> = { message };
  if (details !== undefined) {
    payload.details = details;
  }

  return {
    statusCode,
    headers,
    body: payload,
  };
}

function isSkyResponse(value: HandlerResult): value is SkyResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "statusCode" in value &&
    typeof (value as SkyResponse).statusCode === "number"
  );
}
