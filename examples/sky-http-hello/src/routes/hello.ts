import { App, httpOk } from "../../../../src";

export function registerHelloRoutes(app: App): void {
  app.get(
    "/hello/:name",
    (request, ctx) => {
      const name = request.params?.name ?? "world";
      const langValue = request.query?.lang;
      const lang =
        typeof langValue === "string" ? langValue.toLowerCase() : undefined;
      const message =
        lang === "pt"
          ? `Ola, ${name}!`
          : lang === "es"
            ? `Hola, ${name}!`
            : `Hello, ${name}!`;
      const clientHeader = request.headers["x-demo-client"];
      const clientId = Array.isArray(clientHeader)
        ? clientHeader[0]
        : clientHeader;
      return httpOk({
        provider: ctx.provider,
        message,
        ...(clientId ? { clientId } : {}),
      });
    },
    {
      summary: "Say hello",
      description: "Echo the path parameter and show provider metadata.",
      tags: ["demo"],
      parameters: [
        {
          name: "lang",
          in: "query",
          description: "Optional language code (en, pt, es).",
          schema: { type: "string", enum: ["en", "pt", "es"] },
        },
        {
          name: "x-demo-client",
          in: "header",
          description: "Client identifier for demo tracking.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: { description: "Greeting payload" },
      },
    },
  );
}
