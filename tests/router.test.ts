import { describe, expect, it } from "vitest";
import { Router, __routerInternals } from "../src/core/router";

describe("Router", () => {
  it("it registers routes and finds them by method+path.", () => {
    const router = new Router();
    const handler = () => ({ statusCode: 200 });

    router.register("GET", "/health", handler);

    const matched = router.match("get", "/health");
    expect(matched).not.toBeNull();
    expect(matched?.route.handler).toBe(handler);
    expect(matched?.routePattern).toBe("/health");
    expect(matched?.params).toEqual({});
  });

  it("retorna null quando rota não existe", () => {
    const router = new Router();

    const matched = router.match("POST", "/missing");
    expect(matched).toBeNull();
  });

  it("exposes a copy of the routes list", () => {
    const router = new Router();
    router.register("GET", "/one", () => ({ statusCode: 200 }));

    const routes = router.getRoutes();
    expect(routes).toHaveLength(1);

    routes.push({
      method: "POST",
      path: "/hacked",
      handler: () => ({ statusCode: 201 }),
    });

    expect(router.getRoutes()).toHaveLength(1);
  });

  it("accepts registration via RouteDefinition object and normalizes method", () => {
    const router = new Router();
    const handler = () => ({ statusCode: 204 });

    router.register({
      method: "post",
      path: "/submit",
      handler,
      meta: { scope: "test" },
    });

    const match = router.match("POST", "/submit");
    expect(match?.route).toMatchObject({
      method: "POST",
      meta: { scope: "test" },
    });
    expect(match?.route.handler).toBe(handler);
  });

  it("allows chaining registrations and differentiates routes by method", () => {
    const router = new Router();
    const getHandler = () => ({ statusCode: 200 });
    const postHandler = () => ({ statusCode: 201 });

    router.register("GET", "/resource", getHandler).register(
      "POST",
      "/resource",
      postHandler,
    );

    expect(router.match("GET", "/resource")?.route.handler).toBe(getHandler);
    expect(router.match("POST", "/resource")?.route.handler).toBe(postHandler);
    expect(router.match("DELETE", "/resource")).toBeNull();
  });

  it("uses default path when omitted (internal fallback)", () => {
    const router = new Router();
    const handler = () => ({ statusCode: 204 });

    router.register("GET", undefined as unknown as string, handler);

    const match = router.match("GET", "/");
    expect(match?.route.path).toBe("/");
    expect(match?.route.handler).toBe(handler);
  });

  it("matches params and exposes them in RouteMatch", () => {
    const router = new Router();
    router.register("GET", "/users/:id/books/:bookId", () => ({ statusCode: 200 }));

    const match = router.match("GET", "/users/42/books/7");
    expect(match?.params).toEqual({ id: "42", bookId: "7" });
  });

  it("supports wildcard routes and routePattern metadata", () => {
    const router = new Router();
    router.register({
      method: "get",
      path: "/files/*path",
      handler: () => ({ statusCode: 200 }),
      pathPattern: "/files/*path",
    });

    const match = router.match("GET", "/files/a/b/c.txt");
    expect(match?.params).toEqual({ path: "a/b/c.txt" });
    expect(match?.routePattern).toBe("/files/*path");
  });

  it("normalizes trailing slashes when matching paths", () => {
    const router = new Router();
    const handler = () => ({ statusCode: 200 });
    router.register("GET", "/team/", handler);

    const match = router.match("GET", "/team");
    expect(match?.route.handler).toBe(handler);
  });

  it("accepts route definitions without leading slash", () => {
    const router = new Router();
    router.register("GET", "projects/:id", () => ({ statusCode: 200 }));

    const match = router.match("GET", "/projects/xyz");
    expect(match).not.toBeNull();
    expect(match?.params).toEqual({ id: "xyz" });
  });

  it("retorna null quando path não casa o padrão mesmo com método correto", () => {
    const router = new Router();
    router.register("GET", "/users/:id", () => ({ statusCode: 200 }));

    const match = router.match("GET", "/projects/1");
    expect(match).toBeNull();
  });

  it("normaliza caminhos vazios para a raiz", () => {
    const router = new Router();
    const handler = () => ({ statusCode: 200 });
    router.register("GET", "//", handler);

    const match = router.match("GET", "/");
    expect(match?.route.handler).toBe(handler);
  });

  it("atribui nome padrão ao wildcard quando não há alias", () => {
    const router = new Router();
    router.register("GET", "/files/*", () => ({ statusCode: 200 }));

    const match = router.match("GET", "/files/report.pdf");
    expect(match?.params).toEqual({ wildcard: "report.pdf" });
  });

  it("preenche params sem captura com string vazia (branch fallback)", () => {
    const matcher = __routerInternals.createRouteMatcherFromCompiled({
      regex: {
        exec: () => ["", undefined] as unknown as RegExpExecArray,
      } as unknown as RegExp,
      paramNames: ["id"],
    } as unknown as Parameters<typeof __routerInternals.createRouteMatcherFromCompiled>[0]);

    const match = matcher("/shadow");
    expect(match).toEqual({ id: "" });
  });

  it("preenche wildcard ausente com string vazia", () => {
    const matcher = __routerInternals.createRouteMatcherFromCompiled({
      regex: {
        exec: () => ["", undefined] as unknown as RegExpExecArray,
      } as unknown as RegExp,
      paramNames: [],
      wildcardName: "rest",
    } as unknown as Parameters<typeof __routerInternals.createRouteMatcherFromCompiled>[0]);

    const match = matcher("/shadow");
    expect(match).toEqual({ rest: "" });
  });

  it("retorna null quando raiz nao tem rotas registradas", () => {
    const router = new Router();
    router.register("GET", "/child", () => ({ statusCode: 200 }));

    const match = router.match("GET", "/");
    expect(match).toBeNull();
  });

  it("prioriza fallback de params quando ramo estatico falha", () => {
    const router = new Router();
    const paramHandler = () => ({ statusCode: 200 });

    router.register({
      method: "GET",
      path: "/:group/admin",
      pathPattern: "/:group/admin",
      handler: paramHandler,
    });
    router.register("GET", "/users/profile", () => ({ statusCode: 200 }));

    const match = router.match("GET", "/users/admin");
    expect(match?.route.handler).toBe(paramHandler);
    expect(match?.params).toEqual({ group: "users" });
  });

  it("resolve wildcard no meio do caminho com tentativa progressiva", () => {
    const router = new Router();
    const handler = () => ({ statusCode: 200 });

    router.register({
      method: "GET",
      path: "/files/*path/details",
      pathPattern: "/files/*path/details",
      handler,
    });

    const match = router.match("GET", "/files/a/b/details");
    expect(match?.params).toEqual({ path: "a/b" });
  });

  it("reusa nos internos do trie para params, wildcards e segmentos estaticos", () => {
    const router = new Router();
    const handler = () => ({ statusCode: 200 });

    router.register("GET", "/teams/:id", handler);
    router.register("GET", "/teams/:name/details", handler);

    router.register("GET", "/assets/*path", handler);
    router.register("GET", "/assets/*rest/extra", handler);

    router.register("GET", "/projects/list", handler);
    router.register("GET", "/projects/list/all", handler);

    expect(router.match("GET", "/projects/list/all")).not.toBeNull();
  });

  it("permite fallback do wildcard quando param nao cobre o caminho", () => {
    const router = new Router();
    const paramHandler = () => ({ statusCode: 200 });
    const wildcardHandler = () => ({ statusCode: 200 });

    router.register("GET", "/items/:id", paramHandler);
    router.register("GET", "/items/*rest", wildcardHandler);

    const match = router.match("GET", "/items/123/extra");
    expect(match?.route.handler).toBe(wildcardHandler);
    expect(match?.params).toEqual({ rest: "123/extra" });
  });

  it("usa cache quando habilitado e respeita a chave do match", () => {
    const router = new Router();
    router.register("GET", "/ping", () => ({ statusCode: 200 }));

    const first = router.match("GET", "/ping");
    const second = router.match("GET", "/ping");

    expect(second).toBe(first);
  });

  it("prioriza static > param > wildcard", () => {
    const router = new Router();
    const staticHandler = () => ({ statusCode: 200 });
    const paramHandler = () => ({ statusCode: 201 });
    const wildcardHandler = () => ({ statusCode: 202 });

    router.register("GET", "/items/:id", paramHandler);
    router.register("GET", "/items/*rest", wildcardHandler);
    router.register("GET", "/items/list", staticHandler);

    const staticMatch = router.match("GET", "/items/list");
    expect(staticMatch?.route.handler).toBe(staticHandler);
    expect(staticMatch?.params).toEqual({});

    const paramMatch = router.match("GET", "/items/42");
    expect(paramMatch?.route.handler).toBe(paramHandler);
    expect(paramMatch?.params).toEqual({ id: "42" });

    const wildcardMatch = router.match("GET", "/items/42/extra");
    expect(wildcardMatch?.route.handler).toBe(wildcardHandler);
    expect(wildcardMatch?.params).toEqual({ rest: "42/extra" });
  });

  it("prioriza static/param sobre wildcard no meio do caminho", () => {
    const router = new Router();
    const staticHandler = () => ({ statusCode: 200 });
    const paramHandler = () => ({ statusCode: 201 });
    const wildcardHandler = () => ({ statusCode: 202 });

    router.register("GET", "/files/*rest/details", wildcardHandler);
    router.register("GET", "/files/:id/details", paramHandler);
    router.register("GET", "/files/static/details", staticHandler);

    const staticMatch = router.match("GET", "/files/static/details");
    expect(staticMatch?.route.handler).toBe(staticHandler);
    expect(staticMatch?.params).toEqual({});

    const paramMatch = router.match("GET", "/files/123/details");
    expect(paramMatch?.route.handler).toBe(paramHandler);
    expect(paramMatch?.params).toEqual({ id: "123" });

    const wildcardMatch = router.match("GET", "/files/a/b/details");
    expect(wildcardMatch?.route.handler).toBe(wildcardHandler);
    expect(wildcardMatch?.params).toEqual({ rest: "a/b" });
  });

  it("prioriza param sobre wildcard quando ambos podem casar o mesmo segmento", () => {
    const router = new Router();
    const paramHandler = () => ({ statusCode: 200 });
    const wildcardHandler = () => ({ statusCode: 201 });

    router.register("GET", "/catalog/:id", paramHandler);
    router.register("GET", "/catalog/*rest", wildcardHandler);

    const match = router.match("GET", "/catalog/123");
    expect(match?.route.handler).toBe(paramHandler);
    expect(match?.params).toEqual({ id: "123" });
  });

  it("desliga cache e limpa entradas existentes", () => {
    const router = new Router();
    router.register("GET", "/status", () => ({ statusCode: 200 }));

    router.match("GET", "/status");
    const routerAny = router as unknown as { matchCache: Map<string, unknown> };
    expect(routerAny.matchCache.size).toBeGreaterThan(0);

    router.setMatchCacheEnabled(false);
    expect(routerAny.matchCache.size).toBe(0);

    const match = router.match("GET", "/status");
    expect(match).not.toBeNull();

    router.setMatchCacheEnabled(true);
  });

  it("atualiza ordem do cache ao acessar entradas existentes", () => {
    const router = new Router();
    const routerAny = router as unknown as {
      matchCache: Map<string, unknown>;
      setCachedMatch: (key: string, value: unknown) => void;
      getCachedMatch: (key: string) => unknown;
    };

    routerAny.setCachedMatch("A", null);
    routerAny.setCachedMatch("B", null);

    expect(routerAny.getCachedMatch("missing")).toBeUndefined();
    expect(routerAny.getCachedMatch("A")).toBeNull();

    const firstKey = routerAny.matchCache.keys().next().value;
    expect(firstKey).toBe("B");
  });

  it("substitui entradas com mesma chave no cache", () => {
    const router = new Router();
    const routerAny = router as unknown as {
      matchCache: Map<string, unknown>;
      setCachedMatch: (key: string, value: unknown) => void;
    };

    routerAny.setCachedMatch("GET /item", null);
    routerAny.setCachedMatch("GET /item", { hit: true });

    expect(routerAny.matchCache.size).toBe(1);
  });

  it("evita crescimento do cache acima do limite", () => {
    const router = new Router();
    const routerAny = router as unknown as {
      matchCache: Map<string, unknown>;
      setCachedMatch: (key: string, value: unknown) => void;
    };

    for (let i = 0; i < 1001; i += 1) {
      routerAny.setCachedMatch(`key-${i}`, null);
    }

    expect(routerAny.matchCache.size).toBe(1000);
    expect(routerAny.matchCache.has("key-0")).toBe(false);
  });

  it("mantem primeiro item indefinido quando chave invalida domina o cache", () => {
    const router = new Router();
    const routerAny = router as unknown as {
      matchCache: Map<unknown, unknown>;
      setCachedMatch: (key: string, value: unknown) => void;
    };

    routerAny.matchCache.set(undefined, null);
    for (let i = 0; i < 1000; i += 1) {
      routerAny.matchCache.set(`seed-${i}`, null);
    }

    routerAny.setCachedMatch("extra", null);
    expect(routerAny.matchCache.has(undefined)).toBe(true);
  });

  it("cobre fallback quando iterador do cache devolve undefined", () => {
    const router = new Router();
    const routerAny = router as unknown as {
      matchCache: Map<string, unknown>;
      setCachedMatch: (key: string, value: unknown) => void;
    };

    for (let i = 0; i < 1000; i += 1) {
      routerAny.matchCache.set(`seed-${i}`, null);
    }

    routerAny.matchCache.keys = () =>
      ({
        next: () => ({ value: undefined }),
      }) as unknown as IterableIterator<string>;

    routerAny.setCachedMatch("extra", null);
    expect(routerAny.matchCache.has("extra")).toBe(true);
  });

  it("cria matchers com normalizacao, params, wildcard e escape", () => {
    const rootMatcher = __routerInternals.buildRouteMatcher("/");
    expect(rootMatcher("/")).toEqual({});
    expect(rootMatcher("/other")).toBeNull();

    const docMatcher = __routerInternals.buildRouteMatcher("docs/:id");
    expect(docMatcher("docs/123")).toEqual({ id: "123" });
    expect(docMatcher("/docs/123/")).toEqual({ id: "123" });
    expect(docMatcher("/docs")).toBeNull();

    const wildcardMatcher = __routerInternals.buildRouteMatcher("/files/*");
    expect(wildcardMatcher("/files/report%20final")).toEqual({
      wildcard: "report final",
    });

    const escapedMatcher = __routerInternals.buildRouteMatcher("/v1/users.+/:id");
    expect(escapedMatcher("/v1/users.+/42")).toEqual({ id: "42" });
    expect(escapedMatcher("/v1/usersAAA/42")).toBeNull();
  });
});
