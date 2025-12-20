import { describe, expect, it } from "vitest";
import { IncomingHttpHeaders, IncomingMessage } from "http";
import { Readable } from "stream";
import { EventEmitter } from "node:events";
import {
  getClientIp,
  getRequestHost,
  getRequestProtocol,
  readIncomingMessage,
} from "../src/providers/request-utils";
import { PayloadTooLargeError, SkyRequest } from "../src/core/http";

function createSkyRequest(overrides: Partial<SkyRequest> = {}): SkyRequest {
  return {
    path: "/",
    method: overrides.method ?? "GET",
    headers: overrides.headers ?? {},
    ...overrides,
  };
}

describe("Request Utils", () => {
  describe("getClientIp", () => {
    const headers: IncomingHttpHeaders = {
      "x-forwarded-for": "1.1.1.1, 2.2.2.2",
      "x-real-ip": "3.3.3.3",
    };
    const remoteAddress = "4.4.4.4";

    it("should return the first IP from x-forwarded-for when trustProxy is true", () => {
      expect(getClientIp(headers, true, remoteAddress)).toBe("1.1.1.1");
    });

    it("should return x-real-ip when x-forwarded-for is not present and trustProxy is true", () => {
      const headersWithoutForwardedFor = { ...headers };
      delete headersWithoutForwardedFor["x-forwarded-for"];
      expect(getClientIp(headersWithoutForwardedFor, true, remoteAddress)).toBe("3.3.3.3");
    });

    it("should return remoteAddress when trustProxy is false", () => {
      expect(getClientIp(headers, false, remoteAddress)).toBe("4.4.4.4");
    });

    it("should return remoteAddress when trustProxy is true but no proxy headers are present", () => {
      const headersWithoutProxy = { ...headers };
      delete headersWithoutProxy["x-forwarded-for"];
      delete headersWithoutProxy["x-real-ip"];
      expect(getClientIp(headersWithoutProxy, true, remoteAddress)).toBe("4.4.4.4");
    });

    it("normalizes IPv4-mapped remote addresses", () => {
      expect(getClientIp({}, false, "::ffff:10.1.2.3")).toBe("10.1.2.3");
    });

    it("ignores spoofed headers when proxy is not trusted", () => {
      const spoofedHeaders = { "x-forwarded-for": "9.9.9.9" } as IncomingHttpHeaders;
      expect(getClientIp(spoofedHeaders, false, "7.7.7.7")).toBe("7.7.7.7");
    });

    it("returns IPv6 addresses in normalized form", () => {
      const ipv6Headers = { "x-forwarded-for": "2001:db8::1" } as IncomingHttpHeaders;
      expect(getClientIp(ipv6Headers, true)).toBe("2001:0db8:0000:0000:0000:0000:0000:0001");
    });

    it("skips invalid entries inside x-forwarded-for", () => {
      const spoofedHeaders = {
        "x-forwarded-for": "invalid-ip, 203.0.113.7",
      } as IncomingHttpHeaders;
      expect(getClientIp(spoofedHeaders, true)).toBe("203.0.113.7");
    });

    it("ignores entradas vazias no x-forwarded-for", () => {
      const headersWithBlanks = {
        "x-forwarded-for": " , , 198.51.100.10",
      } as IncomingHttpHeaders;
      expect(getClientIp(headersWithBlanks, true)).toBe("198.51.100.10");
    });

    it("enforces trusted proxy allowlist when provided", () => {
      const forwarded = { "x-forwarded-for": "8.8.8.8" } as IncomingHttpHeaders;
      const notTrusted = getClientIp(forwarded, { mode: "on", allowCidrs: ["10.0.0.0/8"] }, "203.0.113.10");
      expect(notTrusted).toBe("203.0.113.10");

      const trusted = getClientIp(
        forwarded,
        { mode: "on", allowCidrs: ["203.0.113.0/24"] },
        "203.0.113.55",
      );
      expect(trusted).toBe("8.8.8.8");
    });

    it("trusts IPv6 proxies when allowlist matches", () => {
      const forwarded = { "x-forwarded-for": "2001:db8::1" } as IncomingHttpHeaders;
      const ip = getClientIp(
        forwarded,
        { mode: "on", allowCidrs: ["2001:db8::/64"] },
        "2001:db8::ffff",
      );
      expect(ip).toBe("2001:0db8:0000:0000:0000:0000:0000:0001");
    });

    it("skips IPv6 allowlist entries when remote is IPv4", () => {
      const forwarded = { "x-forwarded-for": "10.10.10.10" } as IncomingHttpHeaders;
      const ip = getClientIp(
        forwarded,
        { mode: "on", allowCidrs: ["2001:db8::/64"] },
        "4.4.4.4",
      );
      expect(ip).toBe("4.4.4.4");
    });

    it("returns undefined when no IP can be determined", () => {
      const headersWithoutProxy = { ...headers };
      delete headersWithoutProxy["x-forwarded-for"];
      delete headersWithoutProxy["x-real-ip"];
      expect(getClientIp(headersWithoutProxy, true, undefined)).toBeUndefined();
    });

    it("falls back when forwarded IP has empty segment", () => {
      const invalidHeaders = { "x-forwarded-for": "1..1.1" } as IncomingHttpHeaders;
      expect(getClientIp(invalidHeaders, true, "5.5.5.5")).toBe("5.5.5.5");
    });

    it("trusts any proxy when allowlist is empty", () => {
      const forwarded = { "x-forwarded-for": "9.9.9.9" } as IncomingHttpHeaders;
      expect(getClientIp(forwarded, { mode: "on", allowCidrs: [] }, undefined)).toBe("9.9.9.9");
    });

    it("does not trust allowlist when remote is missing", () => {
      const forwarded = { "x-forwarded-for": "9.9.9.9" } as IncomingHttpHeaders;
      expect(getClientIp(forwarded, { mode: "on", allowCidrs: ["10.0.0.0/8"] }, undefined)).toBeUndefined();
    });

    it("honors single-IP CIDR entries", () => {
      const forwarded = { "x-forwarded-for": "203.0.113.5" } as IncomingHttpHeaders;
      const result = getClientIp(
        forwarded,
        { mode: "on", allowCidrs: ["203.0.113.5/32"] },
        "203.0.113.5",
      );
      expect(result).toBe("203.0.113.5");
    });

    it("trusts allowlist entries without explicit prefix", () => {
      const forwarded = { "x-forwarded-for": "203.0.113.6" } as IncomingHttpHeaders;
      const result = getClientIp(
        forwarded,
        { mode: "on", allowCidrs: ["203.0.113.6"] },
        "203.0.113.6",
      );
      expect(result).toBe("203.0.113.6");
    });

    it("ignores empty CIDR entries in allowlist", () => {
      const forwarded = { "x-forwarded-for": "8.8.8.8" } as IncomingHttpHeaders;
      const result = getClientIp(forwarded, { mode: "on", allowCidrs: ["   "] }, "10.0.0.2");
      expect(result).toBe("10.0.0.2");
    });

    it("ignores allowlist entries with invalid IP base", () => {
      const forwarded = { "x-forwarded-for": "8.8.8.8" } as IncomingHttpHeaders;
      const result = getClientIp(
        forwarded,
        { mode: "on", allowCidrs: ["not-an-ip/24"] },
        "10.0.0.3",
      );
      expect(result).toBe("10.0.0.3");
    });

    it("ignores allowlist entries with invalid prefix", () => {
      const forwarded = { "x-forwarded-for": "8.8.8.8" } as IncomingHttpHeaders;
      const result = getClientIp(
        forwarded,
        { mode: "on", allowCidrs: ["203.0.113.0/999"] },
        "10.0.0.4",
      );
      expect(result).toBe("10.0.0.4");
    });

    it("ignores forwarded IPv6 with repeated double-colon", () => {
      const forwarded = { "x-forwarded-for": "2001::1::1" } as IncomingHttpHeaders;
      expect(getClientIp(forwarded, true, "192.0.2.1")).toBe("192.0.2.1");
    });

    it("parses IPv6 addresses with embedded IPv4 segments", () => {
      const forwarded = { "x-forwarded-for": "2001:db8::ffff:192.0.2.33" } as IncomingHttpHeaders;
      const ip = getClientIp(forwarded, true);
      expect(ip).toBe("2001:0db8:0000:0000:0000:ffff:c000:0221");
    });

    it("normalizes shorthand IPv6 loopback (::1)", () => {
      const forwarded = { "x-forwarded-for": "::1" } as IncomingHttpHeaders;
      const ip = getClientIp(forwarded, true);
      expect(ip).toBe("0000:0000:0000:0000:0000:0000:0000:0001");
    });

    it("returns undefined when both headers and remote address are invalid", () => {
      const header = { "x-forwarded-for": "invalid-ip" } as IncomingHttpHeaders;
      expect(getClientIp(header, true, "not-an-ip")).toBeUndefined();
    });

    it("ignores IPv6 entries with invalid IPv4 tail", () => {
      const forwarded = { "x-forwarded-for": "2001:db8::ffff:192.0.2.999" } as IncomingHttpHeaders;
      expect(getClientIp(forwarded, true, "203.0.113.9")).toBe("203.0.113.9");
    });

    it("ignores IPv6 entries with hex segments out of range", () => {
      const forwarded = { "x-forwarded-for": "2001:10000::1" } as IncomingHttpHeaders;
      expect(getClientIp(forwarded, true, "203.0.113.10")).toBe("203.0.113.10");
    });

    it("ignores forwarded IPs when trustProxy mode is off", () => {
      const forwarded = { "x-forwarded-for": "9.9.9.9" } as IncomingHttpHeaders;
      const ip = getClientIp(forwarded, { mode: "off", allowCidrs: ["9.9.9.0/24"] }, "1.1.1.1");
      expect(ip).toBe("1.1.1.1");
    });

    it("returns undefined when remote address is whitespace", () => {
      expect(getClientIp({}, false, "   ")).toBeUndefined();
    });

    it("ignores IPv4 entries missing octets", () => {
      const header = { "x-forwarded-for": "10.0.0" } as IncomingHttpHeaders;
      expect(getClientIp(header, true, "203.0.113.1")).toBe("203.0.113.1");
    });

    it("ignores IPv4 entries with empty segment", () => {
      const header = { "x-forwarded-for": "10..0.1" } as IncomingHttpHeaders;
      expect(getClientIp(header, true, "203.0.113.2")).toBe("203.0.113.2");
    });

    it("ignores IPv4 entries with octets above 255", () => {
      const header = { "x-forwarded-for": "10.0.0.300" } as IncomingHttpHeaders;
      expect(getClientIp(header, true, "203.0.113.3")).toBe("203.0.113.3");
    });

    it("ignores IPv4-mapped entries with invalid octets", () => {
      const header = { "x-forwarded-for": "::ffff:300.1.1.1" } as IncomingHttpHeaders;
      expect(getClientIp(header, true, "203.0.113.4")).toBe("203.0.113.4");
    });

    it("ignores IPv6 entries with repeated :: sequences", () => {
      const header = { "x-forwarded-for": "2001::1::2" } as IncomingHttpHeaders;
      expect(getClientIp(header, true, "203.0.113.5")).toBe("203.0.113.5");
    });

    it("ignores IPv6 entries with more than eight segments", () => {
      const header = { "x-forwarded-for": "1:2:3:4:5:6:7:8:9" } as IncomingHttpHeaders;
      expect(getClientIp(header, true, "203.0.113.6")).toBe("203.0.113.6");
    });

    it("ignores IPv6 entries with IPv4 tail missing octets", () => {
      const header = { "x-forwarded-for": "2001:db8::ffff:192.0.2" } as IncomingHttpHeaders;
      expect(getClientIp(header, true, "203.0.113.7")).toBe("203.0.113.7");
    });

    it("normalizes IPv6 entries that include stray empty segments", () => {
      const header = { "x-forwarded-for": "2001:db8::0:" } as IncomingHttpHeaders;
      expect(getClientIp(header, true, "203.0.113.8")).toBe("2001:0db8:0000:0000:0000:0000:0000:0000");
    });
  });

  describe("getRequestHost", () => {
    it("should return host from x-forwarded-host when trustProxy is true", () => {
      const req = createSkyRequest({ headers: { "x-forwarded-host": "proxy.host" } });
      expect(getRequestHost(req, true)).toBe("proxy.host");
    });

    it("should return host from host header", () => {
      const req = createSkyRequest({ headers: { host: "request.host" } });
      expect(getRequestHost(req, false)).toBe("request.host");
    });

    it("should return host from referer header", () => {
      const req = createSkyRequest({
        raw: { req: { headers: { referer: "http://referer.host/path" } } as IncomingMessage },
      });
      expect(getRequestHost(req, false)).toBe("referer.host");
    });

    it("should return localhost as fallback", () => {
      const req = createSkyRequest({ raw: { req: { headers: {} } } });
      expect(getRequestHost(req, false)).toBe("localhost");
    });

    it("should return localhost when raw request is missing", () => {
      const req = createSkyRequest();
      expect(getRequestHost(req, false)).toBe("localhost");
    });
  });

  describe("getRequestProtocol", () => {
    it("should return https from x-forwarded-proto when trustProxy is true", () => {
      const req = createSkyRequest({ headers: { "x-forwarded-proto": "https" } });
      expect(getRequestProtocol(req, true)).toBe("https");
    });

    it("should return https if socket is encrypted", () => {
      const socket = new Readable();
      (socket as any).encrypted = true;
      const req = createSkyRequest({ raw: { req: { socket } } });
      expect(getRequestProtocol(req, false)).toBe("https");
    });

    it("should return http as fallback", () => {
      const req = createSkyRequest({ raw: { req: { socket: new Readable() } } });
      expect(getRequestProtocol(req, false)).toBe("http");
    });

    it("should return http when raw socket is not a Readable instance", () => {
      const req = createSkyRequest({ raw: { req: { socket: {} } } });
      expect(getRequestProtocol(req, false)).toBe("http");
    });

    it("should return http when raw request is missing", () => {
      const req = createSkyRequest({ raw: undefined });
      expect(getRequestProtocol(req, false)).toBe("http");
    });
  });

  describe("readIncomingMessage", () => {
    it("should reject on stream error", async () => {
      const error = new Error("stream error");
      const stream = new Readable({
        read() {
          this.emit("error", error);
        },
      });
      await expect(readIncomingMessage(stream)).rejects.toThrow(error);
    });

    it("resolves concatenated payloads respecting the limit", async () => {
      const stream = new Readable({
        read() {
          this.push(Buffer.from("he"));
          this.push(Buffer.from("llo"));
          this.push(null);
        },
      });
      const buffer = await readIncomingMessage(stream, { maxBytes: 10 });
      expect(buffer.toString()).toBe("hello");
    });

    it("throws PayloadTooLargeError when the body exceeds the limit", async () => {
      const createStream = () =>
        new Readable({
          read() {
            this.push(Buffer.alloc(6));
            this.push(null);
          },
        });

      await expect(readIncomingMessage(createStream(), { maxBytes: 4 })).rejects.toBeInstanceOf(
        PayloadTooLargeError,
      );
      await expect(readIncomingMessage(createStream(), { maxBytes: 4 })).rejects.toHaveProperty(
        "limitBytes",
        4,
      );
    });

    it("reads payloads when no size limit is provided", async () => {
      const stream = new Readable({
        read() {
          this.push(Buffer.from("payload"));
          this.push(null);
        },
      });
      const buffer = await readIncomingMessage(stream);
      expect(buffer.toString()).toBe("payload");
    });

    it("converts string chunks into buffers when accumulating", async () => {
      const emitter = new EventEmitter() as unknown as Readable;

      setTimeout(() => {
        emitter.emit("data", "string-chunk");
        emitter.emit("end");
      }, 0);

      const buffer = await readIncomingMessage(emitter, { maxBytes: 64 });
      expect(buffer.toString()).toBe("string-chunk");
    });

    it("rejects when the request stream is aborted", async () => {
      let pushed = false;
      const stream = new Readable({
        read() {
          if (pushed) {
            return;
          }
          pushed = true;
          this.push(Buffer.from("chunk"));
        },
      });

      setTimeout(() => {
        stream.emit("aborted");
        stream.emit("close");
      }, 0);

      await expect(readIncomingMessage(stream)).rejects.toThrow("Request aborted");
    });

    it("rejects when the stream closes before ending", async () => {
      let pushed = false;
      const stream = new Readable({
        read() {
          if (pushed) {
            return;
          }
          pushed = true;
          this.push(Buffer.from("partial"));
        },
      });

      setTimeout(() => {
        stream.emit("close");
      }, 0);

      await expect(readIncomingMessage(stream)).rejects.toThrow(
        "Request closed before completing",
      );
    });

    it("handles streams without destroy when enforcing limits", async () => {
      const emitter = new EventEmitter() as unknown as Readable;

      setTimeout(() => {
        emitter.emit("data", Buffer.alloc(6));
      }, 0);

      await expect(readIncomingMessage(emitter, { maxBytes: 4 })).rejects.toBeInstanceOf(
        PayloadTooLargeError,
      );
    });
  });
});
