import { App, Handler, httpOk } from "../../src";
import { startNodeHttpServer } from "../../src/providers/node-http-adapter";
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

startNodeHttpServer(app, {
  port: Number(process.env.PORT ?? 3000),
  logger: (message) => console.log(message),
});
