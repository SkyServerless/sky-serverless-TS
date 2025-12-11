import { describe, expect, it } from "vitest";
import {
  httpBadRequest,
  httpError,
  httpNotFound,
  httpOk,
  normalizeHandlerResult,
} from "../src/core/http/responses";
import {
  BodyParserError,
  normalizeHeaders,
  parseBody,
  parseQueryString,
} from "../src/core/http/parsers";

describe("HTTP helpers", () => {
  it("builds helpers with expected structure", () => {
    expect(httpOk({ ok: true })).toMatchObject({
      statusCode: 200,
      body: { ok: true },
    });

    expect(httpBadRequest("Invalid", { field: "name" })).toMatchObject({
      statusCode: 400,
      body: { message: "Invalid", details: { field: "name" } },
    });

    expect(httpNotFound("Missing", { path: "/x" })).toMatchObject({
      statusCode: 404,
      body: { message: "Missing", details: { path: "/x" } },
    });

    expect(
      httpError({ message: "Custom", statusCode: 502, details: { code: "BAD" } }),
    ).toMatchObject({
      statusCode: 502,
      body: { message: "Custom", details: { code: "BAD" } },
    });
  });

  it("normalizes handler results", () => {
    expect(normalizeHandlerResult(undefined)).toMatchObject({ statusCode: 200 });
    expect(normalizeHandlerResult("hello")).toMatchObject({
      statusCode: 200,
      body: "hello",
    });
    expect(normalizeHandlerResult({ statusCode: 204 })).toMatchObject({
      statusCode: 204,
    });
  });
});

describe("HTTP parsers", () => {
  it("normalizes headers to lowercase keys", () => {
    const headers = normalizeHeaders({ "Content-Type": "text/plain", Accept: "json" });
    expect(headers).toEqual({
      "content-type": "text/plain",
      accept: "json",
    });
  });

  it("ignores headers com chave vazia ou valor undefined", () => {
    const headers = normalizeHeaders({
      "": "noop",
      Host: undefined,
      Accept: "json",
    });
    expect(headers).toEqual({ accept: "json" });
  });

  it("parses query strings with repeated params", () => {
    const query = parseQueryString("?tags=a&tags=b&search=Sky");
    expect(query).toEqual({
      tags: ["a", "b"],
      search: "Sky",
    });
  });

  it("acumula mais de dois valores repetidos em arrays", () => {
    const query = parseQueryString("?tag=a&tag=b&tag=c");
    expect(query).toEqual({ tag: ["a", "b", "c"] });
  });

  it("lida com query strings sem prefixo ?", () => {
    const query = parseQueryString("page=1&filter=all");
    expect(query).toEqual({ page: "1", filter: "all" });
  });

  it("parses body according to content-type and throws on invalid JSON", () => {
    const jsonResult = parseBody(Buffer.from('{"foo":true}'), "application/json");
    expect(jsonResult.body).toEqual({ foo: true });
    const jsonFromString = parseBody('{"bar":true}', "application/json");
    expect(jsonFromString.body).toEqual({ bar: true });

    const textResult = parseBody(Buffer.from("hello"), "text/plain");
    expect(textResult.body).toBe("hello");
    const textFromString = parseBody("inline-text", "text/plain");
    expect(textFromString.body).toBe("inline-text");

    const binResult = parseBody(Buffer.from("0101"), "application/octet-stream");
    expect(Buffer.isBuffer(binResult.body)).toBe(true);
    const binFromString = parseBody("0101", "application/octet-stream");
    expect(Buffer.isBuffer(binFromString.body)).toBe(true);

    expect(() => parseBody(Buffer.from("oops"), "application/json")).toThrow(
      BodyParserError,
    );
  });

  it("retorna body undefined quando payload é vazio", () => {
    const result = parseBody(undefined, "application/json");
    expect(result.body).toBeUndefined();
  });

  it("retorna payload bruto quando não há content-type", () => {
    const result = parseBody("raw-body", undefined);
    expect(result.body).toBe("raw-body");
  });
});
