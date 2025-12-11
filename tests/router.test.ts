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
});
