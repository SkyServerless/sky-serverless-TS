import { App } from "./app";
import { SkyContext } from "./context";
import { SkyRequest, SkyResponse } from "./http";
import { httpError } from "./http/responses";

export interface HttpProviderAdapter<
  TRawRequest = unknown,
  TRawResponse = unknown,
  TContext extends SkyContext = SkyContext,
> {
  providerName: string;
  toSkyRequest(rawRequest: TRawRequest): Promise<SkyRequest> | SkyRequest;
  fromSkyResponse(
    response: SkyResponse,
    rawRequest: TRawRequest,
    rawResponse: TRawResponse,
  ): Promise<void> | void;
  createContext?(
    rawRequest: TRawRequest,
    rawResponse: TRawResponse,
  ): Promise<TContext> | TContext;
}

export function createHttpHandler<
  TRawRequest,
  TRawResponse,
  TContext extends SkyContext = SkyContext,
>(
  adapter: HttpProviderAdapter<TRawRequest, TRawResponse, TContext>,
  app: App,
) {
  return async (rawRequest: TRawRequest, rawResponse: TRawResponse) => {
    try {
      const skyRequest = await adapter.toSkyRequest(rawRequest);
      const context = await resolveContext(adapter, rawRequest, rawResponse, skyRequest);
      const response = await app.handle(skyRequest, context);
      await adapter.fromSkyResponse(response, rawRequest, rawResponse);
    } catch (error) {
      const fallback = httpError({
        details: serializeError(error),
      });
      await adapter.fromSkyResponse(fallback, rawRequest, rawResponse);
    }
  };
}

async function resolveContext<
  TRawRequest,
  TRawResponse,
  TContext extends SkyContext,
>(
  adapter: HttpProviderAdapter<TRawRequest, TRawResponse, TContext>,
  rawRequest: TRawRequest,
  rawResponse: TRawResponse,
  skyRequest: SkyRequest,
): Promise<TContext> {
  const provided = adapter.createContext
    ? await adapter.createContext(rawRequest, rawResponse)
    : null;

  if (provided) {
    provided.provider = adapter.providerName;
    provided.requestId = provided.requestId ?? skyRequest.requestId ?? generateRequestId();
    provided.services = provided.services ?? {};
    return provided;
  }

  return {
    requestId: skyRequest.requestId ?? generateRequestId(),
    provider: adapter.providerName,
    services: {},
  } as TContext;
}

function generateRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return { message: "Unknown error", detail: error };
}
