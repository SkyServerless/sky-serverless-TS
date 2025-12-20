import { startNodeHttpServer } from "../../src/providers/node-http-adapter";
import { createDemoApp } from "../shared/demo-app";

const app = createDemoApp();

startNodeHttpServer(app, {
  port: Number(process.env.PORT ?? 3000),
  logger: (message) => console.log(message),
  maxBodySizeBytes: 1_048_576, // 1MB
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  keepAliveTimeoutMs: 5_000,
  trustProxy: true,
});
