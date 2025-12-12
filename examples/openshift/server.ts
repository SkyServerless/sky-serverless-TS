import http from "node:http";
import { App, Handler, httpOk } from "../../src";
import { createHttpHandler } from "../../src/core/provider-adapter";
import { OpenShiftProviderAdapter } from "../../src/providers/openshift/openShiftProviderAdapter";
import { MysqlClient } from "../../src/plugins/data/mysql";
import {
  DemoUserRow,
  createDemoMysqlPlugin,
} from "../shared/demo-mysql";

const app = new App({
  environment: "development",
  plugins: [createDemoMysqlPlugin()],
});

const helloHandler: Handler = (request, ctx) => {
  const name = request.params?.name ?? "world";
  return httpOk({
    provider: ctx.provider,
    message: `Hello, ${name}!`,
    query: request.query,
  });
};

const usersHandler: Handler = async (_request, ctx) => {
  const mysql = ctx.services.mysql as MysqlClient;
  const users = await mysql.query<DemoUserRow>("select * from users");
  return httpOk({ provider: ctx.provider, users });
};

app.get("/hello/:name", helloHandler);
app.get("/users", usersHandler);

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
