import { SkyHttpMethod, SkyRequest, SkyResponse } from "./http";

export type SkyServicesRegistry = Record<string, unknown>;

export interface SkyContext<
  TServices extends SkyServicesRegistry = SkyServicesRegistry,
  TMeta = Record<string, unknown>,
> {
  requestId: string;
  provider: string;
  services: TServices;
  meta?: TMeta;
  httpMethod?: SkyHttpMethod | string;
  httpPath?: string;
  routePattern?: string;
  requestStartedAt?: number;
  requestEndedAt?: number;
}

export const SKY_CONTEXT_SYMBOL = Symbol.for("sky.context");

/**
 * Handlers process requests with access to the context assembled by adapters/plugins.
 */
export type Handler<
  TRequest extends SkyRequest = SkyRequest,
  TContext extends SkyContext = SkyContext,
  TResponse extends SkyResponse = SkyResponse,
> = (
  request: TRequest,
  context: TContext,
) => TResponse | Promise<TResponse>;
