import { App, Handler, httpOk } from "../../src";
import { startNodeHttpServer } from "../../src/providers/node-http-adapter";

const app = new App({ environment: "development" });

const helloHandler: Handler = (request) => {
  const name = request.params?.name ?? "world";
  return httpOk({ message: `Hello, ${name}!`, query: request.query });
};

app.get("/hello/:name", helloHandler);

startNodeHttpServer(app, {
  port: Number(process.env.PORT ?? 3000),
  logger: (message) => console.log(message),
});
