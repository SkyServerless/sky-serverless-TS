import { SkyPlugin } from "../../core/plugin";
import { RouteDefinition, RouteMeta, Router } from "../../core/router";

export interface RouteDocResponseContent extends Record<string, unknown> {
  schema?: unknown;
  example?: unknown;
  examples?: Record<string, unknown>;
}

export interface RouteDocResponse extends Record<string, unknown> {
  description?: string;
  content?: Record<string, RouteDocResponseContent>;
  headers?: Record<string, unknown>;
}

export type RouteDocResponses = Record<string, RouteDocResponse | string>;

export interface RouteDocBodyContent extends Record<string, unknown> {
  schema?: unknown;
  example?: unknown;
  examples?: Record<string, unknown>;
}

export interface RouteDocRequestBody extends Record<string, unknown> {
  description?: string;
  required?: boolean;
  content?: Record<string, RouteDocBodyContent>;
}

export type RouteDocParameterLocation =
  | "query"
  | "header"
  | "path"
  | "cookie";

export interface RouteDocParameter extends Record<string, unknown> {
  name: string;
  in: RouteDocParameterLocation;
  description?: string;
  required?: boolean;
  schema?: Record<string, unknown>;
  deprecated?: boolean;
  allowEmptyValue?: boolean;
  example?: unknown;
}

interface RouteDocRouteMeta {
  summary?: string;
  description?: string;
  tags?: string[];
  responses?: RouteDocResponses;
  requestBody?: RouteDocRequestBody;
  parameters?: RouteDocParameter[];
}

export interface SwaggerPluginOptions {
  jsonPath?: string;
  uiPath?: string;
  uiTitle?: string;
  openapi?: string;
  info?: {
    title?: string;
    version?: string;
    description?: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  components?: Record<string, unknown>;
  includeDocsEndpoints?: boolean;
  security?: Array<Record<string, unknown>>;
}

export interface SwaggerDocument extends Record<string, unknown> {
  openapi: string;
  info: Record<string, unknown>;
  paths: Record<string, unknown>;
}

export function swaggerPlugin(options: SwaggerPluginOptions = {}): SkyPlugin {
  const jsonPath = options.jsonPath ?? "/docs.json";
  const uiPath = options.uiPath ?? "/docs";
  const htmlTitle = options.uiTitle ?? "SkyServerless Docs";
  const openapiVersion = options.openapi ?? "3.1.0";
  let cachedDocument: SwaggerDocument | undefined;
  let cachedRouterVersion = -1;
  let cachedHtml: string | undefined;

  return {
    name: "@sky/swagger",
    version: "0.1.0",
    setup({ router }) {
      const getDocument = () => {
        const version = router.getVersion();
        if (!cachedDocument || cachedRouterVersion !== version) {
          cachedDocument = buildOpenApiDocument(router, {
            openapi: openapiVersion,
            info: options.info,
            servers: options.servers,
            tags: options.tags,
            components: options.components,
            includeDocsEndpoints: options.includeDocsEndpoints ?? false,
            security: options.security,
            jsonPath,
            uiPath,
          });
          cachedRouterVersion = version;
        }
        return cachedDocument;
      };
      const getHtml = () => {
        if (!cachedHtml) {
          cachedHtml = renderSwaggerUi({
            title: htmlTitle,
            documentUrl: jsonPath,
          });
        }
        return cachedHtml;
      };

      router.register("GET", jsonPath, () => ({
        statusCode: 200,
        headers: {
          "content-type": "application/json",
        },
        body: getDocument(),
      }));
      router.register("GET", uiPath, () => ({
        statusCode: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
        body: getHtml(),
      }));
    },
  };
}

interface BuildDocumentOptions {
  openapi: string;
  info?: SwaggerPluginOptions["info"];
  servers?: SwaggerPluginOptions["servers"];
  tags?: SwaggerPluginOptions["tags"];
  components?: SwaggerPluginOptions["components"];
  includeDocsEndpoints: boolean;
  jsonPath: string;
  uiPath: string;
  security?: SwaggerPluginOptions["security"];
}

export function buildOpenApiDocument(
  router: Router,
  options: BuildDocumentOptions,
): SwaggerDocument {
  const routes = router.getRoutes();
  const paths: Record<string, Record<string, unknown>> = {};

  routes.forEach((route) => {
    if (!options.includeDocsEndpoints && isDocsRoute(route, options)) {
      return;
    }

    const pathKey = convertRouterPathToOpenApi(route.pathPattern ?? route.path);
    const methodKey = route.method.toLowerCase();
    const operation = createOperationObject(route.meta);

    if (!paths[pathKey]) {
      paths[pathKey] = {};
    }
    paths[pathKey][methodKey] = operation;
  });

  const baseInfo = {
    title: options.info?.title ?? "SkyServerless API",
    version: options.info?.version ?? "1.0.0",
    description: options.info?.description ?? "Generated documentation",
  };

  const document: SwaggerDocument = {
    openapi: options.openapi,
    info: baseInfo,
    paths,
  };

  if (options.servers?.length) {
    document.servers = options.servers;
  }
  if (options.tags?.length) {
    document.tags = options.tags;
  }
  if (options.components) {
    document.components = options.components;
  }
  if (options.security?.length) {
    document.security = options.security;
  }

  return document;
}

function createOperationObject(meta?: RouteMeta): Record<string, unknown> {
  const routeMeta = meta as RouteDocRouteMeta | undefined;
  const responses = buildResponses(routeMeta?.responses);
  const operation: Record<string, unknown> = { responses };
  const requestBody = buildRequestBody(routeMeta?.requestBody);
  const parameters = buildParameters(routeMeta?.parameters);

  if (routeMeta?.summary) {
    operation.summary = routeMeta.summary;
  }
  if (routeMeta?.description) {
    operation.description = routeMeta.description;
  }
  if (routeMeta?.tags) {
    operation.tags = routeMeta.tags;
  }
  if (requestBody) {
    operation.requestBody = requestBody;
  }
  if (parameters.length) {
    operation.parameters = parameters;
  }

  return operation;
}

function buildResponses(responses?: RouteDocResponses): Record<string, unknown> {
  if (!responses || Object.keys(responses).length === 0) {
    return {
      "200": { description: "Successful response" },
    };
  }

  const normalized: Record<string, unknown> = {};
  for (const [statusCode, definition] of Object.entries(responses)) {
    const key = String(statusCode);
    if (typeof definition === "string") {
      normalized[key] = { description: definition };
      continue;
    }

    normalized[key] = {
      description: definition.description ?? "Response",
      ...(definition.content ? { content: definition.content } : {}),
      ...(definition.headers ? { headers: definition.headers } : {}),
    };
  }

  return normalized;
}

function buildRequestBody(
  requestBody?: RouteDocRequestBody,
): Record<string, unknown> | undefined {
  if (!requestBody?.content || Object.keys(requestBody.content).length === 0) {
    return undefined;
  }

  const content: Record<string, Record<string, unknown>> = {};
  for (const [mediaType, definition] of Object.entries(requestBody.content)) {
    content[mediaType] = { ...definition };
  }

  const normalized: Record<string, unknown> = {
    content,
  };

  if (requestBody.description) {
    normalized.description = requestBody.description;
  }
  if (typeof requestBody.required === "boolean") {
    normalized.required = requestBody.required;
  }

  return normalized;
}

function buildParameters(
  parameters?: RouteDocParameter[],
): Array<Record<string, unknown>> {
  if (!parameters?.length) {
    return [];
  }

  return parameters.map((parameter) => ({
    ...parameter,
  }));
}

function convertRouterPathToOpenApi(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        return `{${segment.slice(1)}}`;
      }
      if (segment.startsWith("*")) {
        const name = segment.slice(1) || "wildcard";
        return `{${name}}`;
      }
      return segment;
    })
    .join("/")
    .replace(/\/\/+/g, "/") || "/";
}

interface SwaggerUiTemplateOptions {
  documentUrl: string;
  title: string;
}

function renderSwaggerUi(options: SwaggerUiTemplateOptions): string {
  const escapedTitle = escapeHtml(options.title);
  const documentUrl = JSON.stringify(options.documentUrl);
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapedTitle}</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.addEventListener("load", () => {
        window.ui = SwaggerUIBundle({
          url: ${documentUrl},
          dom_id: "#swagger-ui",
        });
      });
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isDocsRoute(route: RouteDefinition, options: BuildDocumentOptions): boolean {
  const pathCandidates = new Set([options.jsonPath, options.uiPath]);
  return pathCandidates.has(route.path);
}

/** @internal */
export const __swaggerInternals = {
  buildResponses,
  buildRequestBody,
  buildParameters,
  convertRouterPathToOpenApi,
  renderSwaggerUi,
  escapeHtml,
};
