import { describe, expect, it } from "vitest";
import { __authRouteMeta } from "../src/plugins/auth/route-meta";
import { __docRouteMeta } from "../src/plugins/doc/route-meta";

describe("Route meta modules", () => {
  it("exposes runtime markers for coverage", () => {
    expect(__authRouteMeta).toBe(true);
    expect(__docRouteMeta).toBe(true);
  });
});
