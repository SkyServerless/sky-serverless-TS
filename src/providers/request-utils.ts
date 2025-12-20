import { IncomingHttpHeaders, IncomingMessage } from "http";
import { Readable } from "stream";
import { isIP } from "node:net";
import { PayloadTooLargeError, SkyRequest } from "../core/http";

export type TrustProxyConfig =
  | boolean
  | {
      mode?: "off" | "on";
      allowCidrs?: string[];
    };

export function getHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const antdName = name.toLowerCase();
  const realName = Object.keys(headers).find((k) => k.toLowerCase() === antdName);
  return realName ? headers[realName]?.toString() : undefined;
}

export function readIncomingMessage(
  req: Readable,
  options?: { maxBytes: number }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const maxBytes = options?.maxBytes;
    let received = 0;
    const chunks: Buffer[] = [];

    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAborted);
      req.removeListener("close", onClose);
    };

    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onError = (err: Error) => {
      fail(err);
    };

    const onAborted = () => {
      const error = new Error("Request aborted");
      error.name = "RequestAbortedError";
      fail(error);
    };

    const onClose = () => {
      const error = new Error("Request closed before completing");
      error.name = "RequestClosedError";
      fail(error);
    };

    const onData = (chunk: Buffer | string) => {
      if (maxBytes) {
        const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        received += size;
        if (received > maxBytes) {
          const error = new PayloadTooLargeError("Request body too large", maxBytes);
          fail(error);
          if (typeof (req as Readable & { destroy?: () => void }).destroy === "function") {
            (req as Readable & { destroy?: () => void }).destroy();
          }
          return;
        }
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };

    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    req.on("error", onError);
    req.on("data", onData);
    req.on("end", onEnd);
    req.once("aborted", onAborted);
    req.once("close", onClose);
  });
}

export function getRequestHost(req: SkyRequest, trustProxy = false): string {
  const xHost = getHeader(req.headers, 'x-forwarded-host');
  if (trustProxy && xHost) return xHost;

  const host = getHeader(req.headers, 'host');
  if (host) return host;

  if (req.raw) {
    const nodeReq = (req.raw as { req: IncomingMessage }).req;
    const referer = getHeader(nodeReq.headers, 'referer');
    if (referer) {
      const url = new URL(referer);
      return url.host;
    }
  }

  return 'localhost';
}

export function getRequestProtocol(req: SkyRequest, trustProxy = false): 'http' | 'https' {
  if (trustProxy && getHeader(req.headers, 'x-forwarded-proto') === 'https') return 'https';

  if (req.raw) {
    const nodeReq = (req.raw as { req: IncomingMessage }).req;
    if (nodeReq.socket instanceof Readable) {
      // this is not a socket, but a stream
      // we need a better way to do this
      if ((nodeReq.socket as any).encrypted) return 'https';
    }
  }
  return 'http';
}

export function getClientIp(
  headers: IncomingHttpHeaders,
  trustProxy?: TrustProxyConfig,
  remoteAddress?: string,
): string | undefined {
  const remote = parseIp(remoteAddress);
  const shouldTrust = resolveTrustProxy(trustProxy, remote);

  if (shouldTrust) {
    const forwardedFor = getHeader(headers, "x-forwarded-for");
    if (forwardedFor) {
      let start = 0;
      for (let index = 0; index <= forwardedFor.length; index += 1) {
        if (index === forwardedFor.length || forwardedFor[index] === ",") {
          const entry = forwardedFor.slice(start, index).trim();
          if (entry) {
            const parsed = parseIp(entry);
            if (parsed) {
              return parsed.normalized;
            }
          }
          start = index + 1;
        }
      }
    }
    const realIp = parseIp(getHeader(headers, "x-real-ip"));
    if (realIp) {
      return realIp.normalized;
    }
  }

  return remote?.normalized;
}

interface ParsedIp {
  normalized: string;
  bits: number;
  value: bigint;
}

function parseIp(value?: string | null): ParsedIp | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const mappedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  if (mappedMatch) {
    return parseIpv4(mappedMatch[1]);
  }
  const version = isIP(trimmed);
  if (version === 4) {
    return parseIpv4(trimmed);
  }
  if (version === 6) {
    return parseIpv6(trimmed.toLowerCase());
  }
  if (trimmed.includes(":")) {
    return parseIpv6(trimmed.toLowerCase());
  }
  if (trimmed.includes(".")) {
    return parseIpv4(trimmed);
  }
  return undefined;
}

function parseIpv4(value: string): ParsedIp | undefined {
  const segments = value.split(".");
  if (segments.length !== 4) {
    return undefined;
  }
  const normalizedSegments: string[] = [];
  let total = 0n;
  for (const segment of segments) {
    if (!segment.length) {
      return undefined;
    }
    const parsed = Number(segment);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
      return undefined;
    }
    normalizedSegments.push(String(parsed));
    total = (total << 8n) | BigInt(parsed);
  }
  return {
    normalized: normalizedSegments.join("."),
    bits: 32,
    value: total,
  };
}

function parseIpv6(value: string): ParsedIp | undefined {
  const segments = expandIpv6(value);
  if (!segments) {
    return undefined;
  }
  let total = 0n;
  for (const segment of segments) {
    total = (total << 16n) | BigInt(segment);
  }
  const normalized = segments
    .map((segment) => segment.toString(16).padStart(4, "0"))
    .join(":");
  return {
    normalized,
    bits: 128,
    value: total,
  };
}

function expandIpv6(value: string): number[] | undefined {
  const parts = value.split("::");
  if (parts.length > 2) {
    return undefined;
  }
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts[1] ? parts[1].split(":") : [];

  const headValues = parseIpv6Segments(head);
  const tailValues = parseIpv6Segments(tail);
  if (!headValues || !tailValues) {
    return undefined;
  }

  const missing = 8 - (headValues.length + tailValues.length);
  if (missing < 0) {
    return undefined;
  }
  const zeros = new Array(missing).fill(0);
  return [...headValues, ...zeros, ...tailValues];
}

function parseIpv6Segments(segments: string[]): number[] | undefined {
  const values: number[] = [];
  for (const raw of segments) {
    if (!raw.length) {
      continue;
    }
    if (raw.includes(".")) {
      const ipv4 = parseIpv4(raw);
      if (!ipv4) {
        return undefined;
      }
      const high = Number((ipv4.value >> 16n) & 0xffffn);
      const low = Number(ipv4.value & 0xffffn);
      values.push(high, low);
      continue;
    }
    const parsed = Number.parseInt(raw, 16);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff) {
      return undefined;
    }
    values.push(parsed);
  }
  return values;
}

function resolveTrustProxy(
  trustProxy?: TrustProxyConfig,
  remote?: ParsedIp,
): boolean {
  if (trustProxy === undefined) {
    return false;
  }
  if (trustProxy === true) {
    return true;
  }
  if (trustProxy === false) {
    return false;
  }
  if (trustProxy.mode === "off") {
    return false;
  }
  if (!trustProxy.allowCidrs || trustProxy.allowCidrs.length === 0) {
    return true;
  }
  if (!remote) {
    return false;
  }
  return trustProxy.allowCidrs.some((cidr) => cidrContainsIp(cidr, remote));
}

function cidrContainsIp(cidr: string, ip: ParsedIp): boolean {
  const parsed = parseCidr(cidr);
  if (!parsed || parsed.bits !== ip.bits) {
    return false;
  }
  const hostBits = parsed.bits - parsed.prefix;
  if (hostBits <= 0) {
    return parsed.value === ip.value;
  }
  const shift = BigInt(hostBits);
  const cidrNetwork = parsed.value >> shift;
  const ipNetwork = ip.value >> shift;
  return cidrNetwork === ipNetwork;
}

function parseCidr(value: string): { value: bigint; prefix: number; bits: number } | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const [base, prefixRaw] = trimmed.split("/");
  const parsedBase = parseIp(base);
  if (!parsedBase) {
    return undefined;
  }
  const prefix = prefixRaw !== undefined ? Number(prefixRaw) : parsedBase.bits;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsedBase.bits) {
    return undefined;
  }
  return {
    value: parsedBase.value,
    prefix,
    bits: parsedBase.bits,
  };
}
