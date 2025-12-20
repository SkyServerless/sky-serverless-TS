import { App } from "./app";
import { SkyContext } from "./context";
import { PayloadTooLargeError, SkyRequest, SkyResponse } from "./http";
import { httpError } from "./http/responses";

/**
 * Generic contract used by providers to translate native HTTP events into Sky requests/responses.
 */
export interface ProviderAdapter<
  TRawRequest = unknown,
  TRawResponse = unknown,
  TContext extends SkyContext = SkyContext,
> {
  readonly providerName: "openshift" | "gcp" | string;
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

export type HttpProviderAdapter<
  TRawRequest = unknown,
  TRawResponse = unknown,
  TContext extends SkyContext = SkyContext,
> = ProviderAdapter<TRawRequest, TRawResponse, TContext>;

export function createHttpHandler<
  TRawRequest,
  TRawResponse,
  TContext extends SkyContext = SkyContext,
>(
  adapter: ProviderAdapter<TRawRequest, TRawResponse, TContext>,
  app: App,
) {
  return async (rawRequest: TRawRequest, rawResponse: TRawResponse) => {
    try {
      const skyRequest = await adapter.toSkyRequest(rawRequest);
      const context = await resolveContext(adapter, rawRequest, rawResponse, skyRequest);
      const response = await app.handle(skyRequest, context);
      await adapter.fromSkyResponse(response, rawRequest, rawResponse);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        const response = httpError({
          statusCode: 413,
          message: error.message,
          details: {
            code: error.code,
            limitBytes: error.limitBytes,
          },
        });
        await adapter.fromSkyResponse(response, rawRequest, rawResponse);
        return;
      }
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
  adapter: ProviderAdapter<TRawRequest, TRawResponse, TContext>,
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
    if (!provided.services) {
      provided.services = {};
    }
    return provided;
  }

  return {
    requestId: skyRequest.requestId ?? generateRequestId(),
    provider: adapter.providerName,
    services: {},
  } as TContext;
}

export function generateRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function sanitizeRequestId(id: string): string {
  if (!id) return '';
  return id.trim().slice(0, 128).replace(/[^a-zA-Z0-9._:-]/g, '_');
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
