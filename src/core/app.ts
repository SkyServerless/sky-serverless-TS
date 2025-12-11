import { Handler, SkyContext } from "./context";
import { SkyPlugin } from "./plugin";
import { RouteDefinition, RouteMeta, Router } from "./router";
import { SkyRequest, SkyResponse } from "./http";
import {
  HandlerResult,
  httpError,
  httpNotFound,
  normalizeHandlerResult,
} from "./http/responses";

export interface AppConfig {
  plugins?: SkyPlugin[];
  environment?: string;
}

export interface RouteRegistrationInput<TMeta extends RouteMeta = RouteMeta> {
  method: string;
  path: string;
  handler: Handler;
  meta?: TMeta;
  pathPattern?: string;
}

export class App {
  private readonly router: Router;
  private readonly plugins: SkyPlugin[];
  private readonly environment: string;

  constructor(config: AppConfig = {}) {
    this.router = new Router();
    this.plugins = [...(config.plugins ?? [])];
    this.environment =
      config.environment ?? process.env.NODE_ENV ?? "production";
    this.initializePlugins();
  }

  private initializePlugins(): void {
    for (const plugin of this.plugins) {
      plugin.setup?.({ router: this.router });
    }
  }

  getRouter(): Router {
    return this.router;
  }

  route(definition: RouteRegistrationInput): RouteRegistrationResult {
    this.router.register({
      method: definition.method,
      path: definition.path,
      pathPattern: definition.pathPattern ?? definition.path,
      handler: definition.handler,
      meta: definition.meta,
    } satisfies RouteDefinition);
    return {
      method: definition.method.toUpperCase(),
      path: definition.path,
      pathPattern: definition.pathPattern ?? definition.path,
    };
  }

  registerRoute(
    method: string,
    path: string,
    handler: Handler,
    meta?: RouteMeta,
  ): RouteRegistrationResult {
    return this.route({ method, path, handler, meta });
  }

  get(path: string, handler: Handler, meta?: RouteMeta): RouteRegistrationResult {
    return this.route({ method: "GET", path, handler, meta });
  }

  post(
    path: string,
    handler: Handler,
    meta?: RouteMeta,
  ): RouteRegistrationResult {
    return this.route({ method: "POST", path, handler, meta });
  }

  put(path: string, handler: Handler, meta?: RouteMeta): RouteRegistrationResult {
    return this.route({ method: "PUT", path, handler, meta });
  }

  patch(
    path: string,
    handler: Handler,
    meta?: RouteMeta,
  ): RouteRegistrationResult {
    return this.route({ method: "PATCH", path, handler, meta });
  }

  delete(
    path: string,
    handler: Handler,
    meta?: RouteMeta,
  ): RouteRegistrationResult {
    return this.route({ method: "DELETE", path, handler, meta });
  }

  options(
    path: string,
    handler: Handler,
    meta?: RouteMeta,
  ): RouteRegistrationResult {
    return this.route({ method: "OPTIONS", path, handler, meta });
  }

  head(
    path: string,
    handler: Handler,
    meta?: RouteMeta,
  ): RouteRegistrationResult {
    return this.route({ method: "HEAD", path, handler, meta });
  }

  async handle(request: SkyRequest, context: SkyContext): Promise<SkyResponse> {
    const routeMatch = this.router.match(request.method, request.path);
    context.httpMethod = request.method;
    context.httpPath = request.path;
    context.requestStartedAt = Date.now();
    if (routeMatch) {
      request.params = routeMatch.params;
      context.routePattern = routeMatch.routePattern;
    }

    try {
      await this.runOnRequest(request, context);

      if (!routeMatch) {
        const notFound = httpNotFound("Route not found", {
          method: request.method,
          path: request.path,
        });
        await this.runOnResponse(request, notFound, context);
        return notFound;
      }

      const handlerResult: HandlerResult = await routeMatch.route.handler(
        request,
        context,
      );
      const response = normalizeHandlerResult(handlerResult);
      await this.runOnResponse(request, response, context);
      return response;
    } catch (error) {
      await this.runOnError(error, context);
      return this.buildInternalErrorResponse(error);
    } finally {
      context.requestEndedAt = Date.now();
    }
  }

  private async runOnRequest(
    request: SkyRequest,
    context: SkyContext,
  ): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.onRequest?.(request, context);
    }
  }

  private async runOnResponse(
    request: SkyRequest,
    response: SkyResponse,
    context: SkyContext,
  ): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.onResponse?.(request, response, context);
    }
  }

  private async runOnError(error: unknown, context: SkyContext): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.onError?.(error, context);
    }
  }

  private buildInternalErrorResponse(error: unknown): SkyResponse {
    const exposeDetails = this.environment !== "production";
    return httpError({
      details: exposeDetails ? serializeError(error) : undefined,
    });
  }
}

export interface RouteRegistrationResult {
  method: string;
  path: string;
  pathPattern: string;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return { detail: error };
}
