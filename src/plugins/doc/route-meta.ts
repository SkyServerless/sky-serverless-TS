import type { RouteDocParameter, RouteDocRequestBody, RouteDocResponses } from "./swagger";

declare module "../../core/router" {
  interface RouteMetaExtensions {
    summary?: string;
    description?: string;
    tags?: string[];
    responses?: RouteDocResponses;
    requestBody?: RouteDocRequestBody;
    parameters?: RouteDocParameter[];
  }
}

export const __docRouteMeta = true;
