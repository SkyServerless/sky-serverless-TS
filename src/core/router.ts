import { Handler } from "./context";
import { SkyHttpMethod } from "./http";

export interface RouteMeta extends Record<string, unknown> {}

export interface RouteDefinition<
  THandler extends Handler = Handler,
  TMeta extends RouteMeta = RouteMeta,
> {
  method: SkyHttpMethod | string;
  path: string;
  pathPattern?: string;
  handler: THandler;
  meta?: TMeta;
}

export interface RouteMatch<
  THandler extends Handler = Handler,
  TMeta extends RouteMeta = RouteMeta,
> {
  route: RouteDefinition<THandler, TMeta>;
  params: Record<string, string>;
  routePattern: string;
}

type RouteMatcher = (path: string) => Record<string, string> | null;

type NormalizedRouteDefinition<
  THandler extends Handler = Handler,
  TMeta extends RouteMeta = RouteMeta,
> = RouteDefinition<THandler, TMeta> & {
  pathPattern: string;
  method: string;
};

interface InternalRoute<
  THandler extends Handler = Handler,
  TMeta extends RouteMeta = RouteMeta,
> {
  definition: NormalizedRouteDefinition<THandler, TMeta>;
  matchPath: RouteMatcher;
}

export class Router {
  private readonly routes: InternalRoute[] = [];

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
    const definition: NormalizedRouteDefinition =
      typeof methodOrDefinition === "string"
        ? createRouteDefinition(methodOrDefinition, path ?? "/", handler as Handler, meta)
        : normalizeRouteDefinition(methodOrDefinition);

    this.routes.push({
      definition,
      matchPath: buildRouteMatcher(definition.pathPattern),
    });
    return this;
  }

  match(method: SkyHttpMethod | string, path: string): RouteMatch | null {
    const normalizedMethod = method.toUpperCase();
    for (const route of this.routes) {
      if (route.definition.method !== normalizedMethod) {
        continue;
      }

      const params = route.matchPath(path);
      if (params) {
        return {
          route: route.definition,
          params,
          routePattern: route.definition.pathPattern,
        };
      }
    }
    return null;
  }

  getRoutes(): RouteDefinition[] {
    return this.routes.map((route) => route.definition);
  }
}

function createRouteDefinition(
  method: SkyHttpMethod | string,
  path: string,
  handler: Handler,
  meta?: RouteMeta,
): NormalizedRouteDefinition {
  return normalizeRouteDefinition({
    method,
    path,
    handler,
    meta,
  });
}

function normalizeRouteDefinition(definition: RouteDefinition): NormalizedRouteDefinition {
  return {
    ...definition,
    method: definition.method.toUpperCase(),
    pathPattern: definition.pathPattern ?? definition.path,
  };
}

function buildRouteMatcher(routePattern: string): RouteMatcher {
  const compiled = compileRoutePattern(routePattern);
  return createRouteMatcherFromCompiled(compiled);
}

interface CompiledPattern {
  regex: RegExp;
  paramNames: string[];
  wildcardName?: string;
}

function createRouteMatcherFromCompiled(compiled: CompiledPattern): RouteMatcher {
  return (path: string) => {
    const normalizedPath = normalizePath(path);
    const match = compiled.regex.exec(normalizedPath);
    if (!match) {
      return null;
    }

    const params: Record<string, string> = {};
    compiled.paramNames.forEach((name, index) => {
      const value = match[index + 1];
      params[name] = decodeURIComponent(value ?? "");
    });

    if (compiled.wildcardName) {
      const wildcardValue = match[compiled.paramNames.length + 1];
      params[compiled.wildcardName] = decodeURIComponent(wildcardValue ?? "");
    }

    return params;
  };
}

function compileRoutePattern(pattern: string): CompiledPattern {
  const normalized = normalizePath(pattern);
  if (normalized === "/") {
    return {
      regex: /^\/$/,
      paramNames: [],
    };
  }

  const segments = normalized
    .split("/")
    .filter((segment) => segment.length > 0);
  const paramNames: string[] = [];
  let wildcardName: string | undefined;
  let regexSource = "^";

  segments.forEach((segment, index) => {
    regexSource += "\\/";
    if (segment.startsWith(":")) {
      const paramName = segment.slice(1);
      paramNames.push(paramName);
      regexSource += "([^\\/]+)";
      return;
    }

    if (segment.startsWith("*")) {
      wildcardName = segment.slice(1) || "wildcard";
      regexSource += "(.+)";
      return;
    }

    regexSource += escapeRegex(segment);
  });

  regexSource += "/?$";
  return {
    regex: new RegExp(regexSource),
    paramNames,
    wildcardName,
  };
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) {
    return normalizePath(`/${path}`);
  }

  let normalized = path;
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.replace(/\/+$/, "");
  }

  return normalized || "/";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Internal helpers exposed for testing edge cases.
 */
export const __routerInternals = {
  createRouteMatcherFromCompiled,
};
