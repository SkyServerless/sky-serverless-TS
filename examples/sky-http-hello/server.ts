import { startNodeHttpServer } from "../../src/providers/node-http-adapter";
import { createDemoApp } from "../shared/demo-app";

const app = createDemoApp();

startNodeHttpServer(app, {
  port: Number(process.env.PORT ?? 3000),
  logger: (message) => console.log(message),
});
