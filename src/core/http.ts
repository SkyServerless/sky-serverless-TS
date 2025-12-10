/**
 * HTTP utilities and primitives used by the SkyServerless core.
 */
export type SkyHttpMethod =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "TRACE"
  | "CONNECT";

export type SkyHeaders = Record<string, string | string[]>;

/**
 * Describe the shape of an incoming HTTP request that flows through the platform.
 */
export interface SkyRequest<
  TBody = unknown,
  TQuery extends Record<string, unknown> = Record<string, unknown>,
> {
  path: string;
  method: SkyHttpMethod | string;
  headers: SkyHeaders;
  query?: TQuery;
  body?: TBody;
  params?: Record<string, string>;
  user?: unknown;
  requestId?: string;
}

/**
 * Standard response contract understood by adapters and plugins.
 */
export interface SkyResponse<TBody = unknown> {
  statusCode: number;
  headers?: SkyHeaders;
  body?: TBody;
}
