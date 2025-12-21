import { SkyContext } from "./context";
import { SkyRequest, SkyResponse } from "./http";
import { Router } from "./router";

export interface PluginSetupContext {
  router: Router;
}

export interface OpenApiDocument extends Record<string, unknown> {}

export interface SkyPlugin {
  name: string;
  version: string;
  setup?(context: PluginSetupContext): void | Promise<void>;
  onRequest?(
    request: SkyRequest,
    context: SkyContext,
  ): SkyResponse | void | Promise<SkyResponse | void>;
  onResponse?(
    request: SkyRequest,
    response: SkyResponse,
    context: SkyContext,
  ): void | Promise<void>;
  onError?(error: unknown, context: SkyContext): void | Promise<void>;
  extendOpenApi?(document: OpenApiDocument): void | Promise<void>;
}

export const SKY_PLUGIN_HOOKS = [
  "setup",
  "onRequest",
  "onResponse",
  "onError",
  "extendOpenApi",
] as const;
