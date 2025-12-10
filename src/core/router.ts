import { Handler } from "./context";
import { SkyHttpMethod } from "./http";

export interface RouteMeta extends Record<string, unknown> {}

export interface RouteDefinition<
  THandler extends Handler = Handler,
  TMeta extends RouteMeta = RouteMeta,
> {
  method: SkyHttpMethod | string;
  path: string;
  handler: THandler;
  meta?: TMeta;
}

export class Router {
  private readonly routes: RouteDefinition[] = [];

  register(definition: RouteDefinition): this;
  register(
    method: SkyHttpMethod | string,
    path: string,
    handler: Handler,
    meta?: RouteMeta,
  ): this;
  register(
    methodOrDefinition: SkyHttpMethod | string | RouteDefinition,
    path?: string,
    handler?: Handler,
    meta?: RouteMeta,
  ): this {
    const definition =
      typeof methodOrDefinition === "string"
        ? {
            method: methodOrDefinition.toUpperCase(),
            path: path ?? "/",
            handler: handler as Handler,
            meta,
          }
        : {
            ...methodOrDefinition,
            method: methodOrDefinition.method.toUpperCase(),
          };

    this.routes.push(definition);
    return this;
  }

  match(method: SkyHttpMethod | string, path: string): RouteDefinition | null {
    const normalizedMethod = method.toUpperCase();
    return (
      this.routes.find(
        (route) => route.method === normalizedMethod && route.path === path,
      ) ?? null
    );
  }

  getRoutes(): RouteDefinition[] {
    return [...this.routes];
  }
}
