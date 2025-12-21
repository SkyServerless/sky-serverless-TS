import type { AuthRouteSecurityMeta } from "./jwt";

declare module "../../core/router" {
  interface RouteMetaExtensions {
    auth?: AuthRouteSecurityMeta;
  }
}

export const __authRouteMeta = true;
