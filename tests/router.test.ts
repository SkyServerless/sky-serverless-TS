import { describe, expect, it } from "vitest";
import { Router } from "../src/core/router";

describe("Router", () => {
  it("it registers routes and finds them by method+path.", () => {
    const router = new Router();
    const handler = () => ({ statusCode: 200 });

    router.register("GET", "/health", handler);

    const matched = router.match("get", "/health");
    expect(matched).not.toBeNull();
    expect(matched?.handler).toBe(handler);
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
    expect(match).toMatchObject({
      method: "POST",
      meta: { scope: "test" },
    });
    expect(match?.handler).toBe(handler);
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

    expect(router.match("GET", "/resource")?.handler).toBe(getHandler);
    expect(router.match("POST", "/resource")?.handler).toBe(postHandler);
    expect(router.match("DELETE", "/resource")).toBeNull();
  });

  it("uses default path when omitted (internal fallback)", () => {
    const router = new Router();
    const handler = () => ({ statusCode: 204 });

    router.register("GET", undefined as unknown as string, handler);

    const match = router.match("GET", "/");
    expect(match?.path).toBe("/");
    expect(match?.handler).toBe(handler);
  });
});
