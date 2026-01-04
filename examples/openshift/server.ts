import http from "node:http";
import { createHttpHandler } from "../../src/core/provider-adapter";
import { OpenShiftProviderAdapter } from "../../src/providers/openshift/openShiftProviderAdapter";
import { createApp } from "../sky-http-hello/src/app";

const app = createApp();

const adapter = new OpenShiftProviderAdapter();
const handler = createHttpHandler(adapter, app);

const port = Number(process.env.PORT ?? 8080);
const host = process.env.BIND_HOST ?? "0.0.0.0";

const server = http.createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((error) => {
    console.error("[OpenShift] handler failed", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });
});

server.listen(port, host, () => {
  console.log(`[OpenShift] HTTP server listening on ${host}:${port}`);
});

export { server };
