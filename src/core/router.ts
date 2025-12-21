import { Handler } from "./context";
import { SkyHttpMethod } from "./http";

export interface RouteMetaExtensions {}

export interface RouteMeta
  extends Record<string, unknown>,
    RouteMetaExtensions {}

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
}

const MAX_MATCH_CACHE = 1000;

interface RouteTrieParam {
  name: string;
  node: RouteTrieNode;
}

interface RouteTrieNode {
  staticChildren: Map<string, RouteTrieNode>;
  paramChild?: RouteTrieParam;
  wildcardChild?: RouteTrieParam;
  routes: InternalRoute[];
}

export class Router {
  private readonly routes: InternalRoute[] = [];
  private readonly triesByMethod = new Map<string, RouteTrieNode>();
  private readonly matchCache = new Map<string, RouteMatch | null>();
  private matchCacheEnabled = true;
  private version = 0;

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

    const internalRoute: InternalRoute = { definition };
    this.routes.push(internalRoute);
    this.registerInTrie(internalRoute);
    this.version += 1;
    this.matchCache.clear();
    return this;
  }

  match(method: SkyHttpMethod | string, path: string): RouteMatch | null {
    const normalizedMethod = method.toUpperCase();
    const cacheKey = this.matchCacheEnabled
      ? `${normalizedMethod} ${path}`
      : null;

    if (cacheKey) {
      const cached = this.getCachedMatch(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    const trie = this.triesByMethod.get(normalizedMethod);
    const segments = parsePathSegments(path);
    const match = trie ? matchTrie(trie, segments, 0, undefined) : null;

    if (cacheKey) {
      this.setCachedMatch(cacheKey, match);
    }
    return match;
  }

  getRoutes(): RouteDefinition[] {
    return this.routes.map((route) => route.definition);
  }

  getVersion(): number {
    return this.version;
  }

  setMatchCacheEnabled(enabled: boolean): void {
    this.matchCacheEnabled = enabled;
    if (!enabled) {
      this.matchCache.clear();
    }
  }

  private getCachedMatch(cacheKey: string): RouteMatch | null | undefined {
    const cached = this.matchCache.get(cacheKey);
    if (cached === undefined) {
      return undefined;
    }
    this.matchCache.delete(cacheKey);
    this.matchCache.set(cacheKey, cached);
    return cached;
  }

  private setCachedMatch(cacheKey: string, value: RouteMatch | null): void {
    if (this.matchCache.has(cacheKey)) {
      this.matchCache.delete(cacheKey);
    }
    this.matchCache.set(cacheKey, value);
    if (this.matchCache.size > MAX_MATCH_CACHE) {
      const iterator = this.matchCache.keys();
      let firstKey = iterator.next().value;
      if (firstKey === undefined) {
        firstKey = iterator.next().value;
      }
      if (firstKey !== undefined) {
        this.matchCache.delete(firstKey);
      }
    }
  }

  private registerInTrie(route: InternalRoute): void {
    const methodKey = route.definition.method;
    let root = this.triesByMethod.get(methodKey);
    if (!root) {
      root = createTrieNode();
      this.triesByMethod.set(methodKey, root);
    }

    const segments = parsePathSegments(route.definition.pathPattern);
    let node = root;
    for (const segment of segments) {
      if (segment.startsWith(":")) {
        const name = segment.slice(1);
        if (!node.paramChild) {
          node.paramChild = { name, node: createTrieNode() };
        }
        node = node.paramChild.node;
        continue;
      }
      if (segment.startsWith("*")) {
        const name = segment.slice(1) || "wildcard";
        if (!node.wildcardChild) {
          node.wildcardChild = { name, node: createTrieNode() };
        }
        node = node.wildcardChild.node;
        continue;
      }

      let child = node.staticChildren.get(segment);
      if (!child) {
        child = createTrieNode();
        node.staticChildren.set(segment, child);
      }
      node = child;
    }
    node.routes.push(route);
  }
}

function createTrieNode(): RouteTrieNode {
  return {
    staticChildren: new Map(),
    routes: [],
  };
}

function matchTrie(
  node: RouteTrieNode,
  segments: string[],
  index: number,
  params: Record<string, string> | undefined,
): RouteMatch | null {
  if (index === segments.length) {
    if (node.routes.length > 0) {
      return buildMatch(node.routes[0], params);
    }
    return null;
  }

  const segment = segments[index];
  const staticChild = node.staticChildren.get(segment);
  if (staticChild) {
    const result = matchTrie(staticChild, segments, index + 1, params);
    if (result) {
      return result;
    }
  }

  if (node.paramChild) {
    const value = decodeURIComponent(segment);
    const nextParams = addParam(params, node.paramChild.name, value);
    const result = matchTrie(node.paramChild.node, segments, index + 1, nextParams);
    if (result) {
      return result;
    }
  }

  if (node.wildcardChild) {
    const name = node.wildcardChild.name;
    for (let end = segments.length; end > index; end -= 1) {
      const rawValue = segments.slice(index, end).join("/");
      const value = decodeURIComponent(rawValue);
      const nextParams = addParam(params, name, value);
      const result = matchTrie(node.wildcardChild.node, segments, end, nextParams);
      if (result) {
        return result;
      }
    }
  }

  return null;
}

function buildMatch(
  route: InternalRoute,
  params: Record<string, string> | undefined,
): RouteMatch {
  return {
    route: route.definition,
    params: params ?? {},
    routePattern: route.definition.pathPattern,
  };
}

function addParam(
  params: Record<string, string> | undefined,
  key: string,
  value: string,
): Record<string, string> {
  if (!params) {
    return { [key]: value };
  }
  return { ...params, [key]: value };
}

function parsePathSegments(path: string): string[] {
  const normalized = normalizePath(path);
  if (normalized === "/") {
    return [];
  }
  return normalized.split("/").filter((segment) => segment.length > 0);
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

type RouteMatcher = (path: string) => Record<string, string> | null;

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

  segments.forEach((segment) => {
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
  buildRouteMatcher,
};
