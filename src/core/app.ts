import { Handler, SkyContext } from "./context";
import { SkyPlugin } from "./plugin";
import { Router } from "./router";
import { SkyRequest, SkyResponse } from "./http";

export interface AppConfig {
  plugins?: SkyPlugin[];
}

export class App {
  private readonly router: Router;
  private readonly plugins: SkyPlugin[];

  constructor(config: AppConfig = {}) {
    this.router = new Router();
    this.plugins = [...(config.plugins ?? [])];
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

  registerRoute(
    method: string,
    path: string,
    handler: Handler,
  ): RouteRegistrationResult {
    this.router.register(method, path, handler);
    return { method, path };
  }

  async handle(request: SkyRequest, context: SkyContext): Promise<SkyResponse> {
    const route = this.router.match(request.method, request.path);

    try {
      await this.runOnRequest(request, context);

      if (!route) {
        const notFound = this.buildNotFoundResponse(request);
        await this.runOnResponse(request, notFound, context);
        return notFound;
      }

      const response = await route.handler(request, context);
      await this.runOnResponse(request, response, context);
      return response;
    } catch (error) {
      await this.runOnError(error, context);
      return this.buildInternalErrorResponse();
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

  private buildNotFoundResponse(request: SkyRequest): SkyResponse {
    return {
      statusCode: 404,
      body: {
        message: "Route not found",
        method: request.method,
        path: request.path,
      },
    };
  }

  private buildInternalErrorResponse(): SkyResponse {
    return {
      statusCode: 500,
      body: {
        message: "Internal Server Error",
      },
    };
  }
}

export interface RouteRegistrationResult {
  method: string;
  path: string;
}
