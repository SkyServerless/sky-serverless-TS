import {
  createHttpHandler,
  createNodeHttpAdapter,
  startNodeHttpServer,
} from "../../../../src";
import { createApp } from "../app";

const app = createApp();
const adapter = createNodeHttpAdapter({ providerName: "local-dev" });
export const handler = createHttpHandler(adapter, app);

export function startLocalServer() {
  const port = Number(process.env.PORT ?? process.env.SKY_DEV_PORT ?? 3000);
  return startNodeHttpServer(app, {
    port,
    logger: (message) => console.log(message),
    maxBodySizeBytes: 1_048_576,
    headersTimeoutMs: 10_000,
    requestTimeoutMs: 30_000,
    keepAliveTimeoutMs: 5_000,
    trustProxy: true,
  });
}

if (require.main === module) {
  startLocalServer();
}
