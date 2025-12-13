import {
  createHmac,
  createSign,
  createVerify,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { SkyPlugin } from "../../core/plugin";
import { SkyContext } from "../../core/context";
import { SkyRequest } from "../../core/http";

const DEFAULT_ACCESS_TTL = 15 * 60;
const DEFAULT_REFRESH_TTL = 7 * 24 * 60 * 60;
const DEFAULT_ENV_SECRET_KEY = "SKY_AUTH_JWT_SECRET";
const DEFAULT_ENV_PRIVATE_KEY = "SKY_AUTH_JWT_PRIVATE_KEY";
const DEFAULT_ENV_PUBLIC_KEY = "SKY_AUTH_JWT_PUBLIC_KEY";

export type JwtAlgorithm = "HS256" | "RS256";

export interface AuthUser extends Record<string, unknown> {
  id: string;
}

export interface TokenSignOptions {
  ttlSeconds?: number;
  claims?: Record<string, unknown>;
}

export interface AuthConfig {
  jwtSecret?: string;
  privateKey?: string;
  publicKey?: string;
  algorithm?: JwtAlgorithm;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  cookieName?: string;
}

export interface AuthHelpers {
  signAccessToken(user: AuthUser, options?: TokenSignOptions): string;
  signRefreshToken(user: AuthUser, options?: TokenSignOptions): string;
  issueTokens(user: AuthUser): { accessToken: string; refreshToken: string };
  verifyToken<TPayload extends Record<string, unknown>>(token: string): TPayload | null;
}

export interface AuthPluginOptions {
  config?: Partial<AuthConfig>;
  envSecretKey?: string;
  envPrivateKeyKey?: string;
  envPublicKeyKey?: string;
  userServiceKey?: string;
  authServiceKey?: string;
  tokenResolver?: (request: SkyRequest, context: SkyContext) => string | undefined;
  resolveUser?: (
    payload: AccessTokenPayload,
    context: SkyContext,
  ) => Promise<AuthUser | null> | AuthUser | null;
}

interface AccessTokenPayload extends Record<string, unknown> {
  sub: string;
  type: "access" | "refresh";
  user: AuthUser;
  jti?: string;
  iat: number;
  exp: number;
}

export function authPlugin(options: AuthPluginOptions): SkyPlugin {
  const envSecret =
    process.env[options.envSecretKey ?? DEFAULT_ENV_SECRET_KEY] ?? undefined;
  const envPrivateKey =
    process.env[options.envPrivateKeyKey ?? DEFAULT_ENV_PRIVATE_KEY] ?? undefined;
  const envPublicKey =
    process.env[options.envPublicKeyKey ?? DEFAULT_ENV_PUBLIC_KEY] ?? undefined;
  const config = resolveAuthConfig(options.config, {
    secret: envSecret,
    privateKey: envPrivateKey,
    publicKey: envPublicKey,
  });
  const userServiceKey = options.userServiceKey ?? "user";
  const authServiceKey = options.authServiceKey ?? "auth";
  const resolveUser =
    options.resolveUser ?? (async (payload: AccessTokenPayload) => payload.user);
  const authHelpers = createAuthHelpers(config);
  const tokenResolver =
    options.tokenResolver ??
    ((request: SkyRequest) => defaultTokenResolver(request, config));

  return {
    name: "@sky/auth-jwt",
    version: "0.1.0",
    async onRequest(request, context) {
      attachAuthHelpers(context, authServiceKey, authHelpers);
      clearExistingUser(context, request, userServiceKey);

      const token = tokenResolver(request, context);
      if (!token) {
        return;
      }

      const payload = authHelpers.verifyToken<AccessTokenPayload>(token);
      if (!payload || payload.type !== "access") {
        return;
      }

      const user = await resolveUser(payload, context);
      if (!user) {
        return;
      }

      context.services[userServiceKey] = user;
      if (context.meta && typeof context.meta === "object") {
        (context.meta as Record<string, unknown>).user = user;
      } else {
        context.meta = { user } as SkyContext["meta"];
      }
      request.user = user;
    },
  };
}

function resolveAuthConfig(
  config: Partial<AuthConfig> | undefined,
  envValues: {
    secret?: string;
    privateKey?: string;
    publicKey?: string;
  },
): ResolvedAuthConfig {
  const algorithm: JwtAlgorithm = (config?.algorithm ?? "HS256") as JwtAlgorithm;

  const jwt =
    algorithm === "RS256"
      ? resolveAsymmetricKeys(config, envValues)
      : resolveSymmetricSecret(config, envValues.secret);

  return {
    jwt,
    accessTokenTtlSeconds:
      config?.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TTL,
    refreshTokenTtlSeconds:
      config?.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TTL,
    cookieName: config?.cookieName,
  };
}

function resolveSymmetricSecret(
  config: Partial<AuthConfig> | undefined,
  envSecret?: string,
): JwtKeyMaterial {
  const secret = config?.jwtSecret ?? envSecret;
  if (!secret) {
    throw new Error(
      "authPlugin requires jwtSecret via config/env when algorithm is HS256.",
    );
  }
  return {
    algorithm: "HS256",
    signingKey: secret,
    verificationKey: secret,
  };
}

function resolveAsymmetricKeys(
  config: Partial<AuthConfig> | undefined,
  envValues: {
    privateKey?: string;
    publicKey?: string;
  },
): JwtKeyMaterial {
  const privateKey = config?.privateKey ?? envValues.privateKey;
  if (!privateKey) {
    throw new Error(
      "authPlugin requires privateKey via config/env when algorithm is RS256.",
    );
  }
  const publicKey =
    config?.publicKey ?? envValues.publicKey ?? privateKey;
  return {
    algorithm: "RS256",
    signingKey: privateKey,
    verificationKey: publicKey,
  };
}

function attachAuthHelpers(
  context: SkyContext,
  serviceKey: string,
  helpers: AuthHelpers,
): void {
  if (!context.services[serviceKey]) {
    context.services[serviceKey] = helpers;
  }
}

function createAuthHelpers(config: ResolvedAuthConfig): AuthHelpers {
  return {
    signAccessToken(user, options) {
      return signToken(
        { user, type: "access" },
        config.jwt,
        options?.ttlSeconds ?? config.accessTokenTtlSeconds,
        options?.claims,
      );
    },
    signRefreshToken(user, options) {
      return signToken(
        { user, type: "refresh" },
        config.jwt,
        options?.ttlSeconds ?? config.refreshTokenTtlSeconds,
        options?.claims,
      );
    },
    issueTokens(user) {
      return issueTokens(user, config);
    },
    verifyToken(token) {
      return verifyJwt(token, config.jwt);
    },
  };
}

function defaultTokenResolver(
  request: SkyRequest,
  config: ResolvedAuthConfig,
): string | undefined {
  const fromHeader = extractBearerToken(request);
  if (fromHeader) {
    return fromHeader;
  }

  if (config.cookieName) {
    return extractCookie(request, config.cookieName);
  }

  return undefined;
}

function issueTokens(
  user: AuthUser,
  config: ResolvedAuthConfig,
): { accessToken: string; refreshToken: string } {
  const basePayload = {
    sub: user.id,
    user,
  };

  const accessToken = signToken(
    { ...basePayload, type: "access", jti: randomUUID() },
    config.jwt,
    config.accessTokenTtlSeconds,
  );
  const refreshToken = signToken(
    { ...basePayload, type: "refresh", jti: randomUUID() },
    config.jwt,
    config.refreshTokenTtlSeconds,
  );

  return { accessToken, refreshToken };
}

function signToken(
  payload: Record<string, unknown>,
  jwt: JwtKeyMaterial,
  ttlSeconds: number,
  extraClaims?: Record<string, unknown>,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: jwt.algorithm,
    typ: "JWT",
  };
  const fullPayload = {
    ...payload,
    ...extraClaims,
    iat: now,
    exp: now + ttlSeconds,
  };
  const encodedHeader = encodeSegment(header);
  const encodedPayload = encodeSegment(fullPayload);
  const signature = createSignature(
    `${encodedHeader}.${encodedPayload}`,
    jwt,
  );
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifyJwt<TPayload extends Record<string, unknown>>(
  token: string,
  jwt: JwtKeyMaterial,
): TPayload | null {
  try {
    const [encodedHeader, encodedPayload, signature] = token.split(".");
    if (!encodedHeader || !encodedPayload || !signature) {
      return null;
    }

    const isValid = verifySignature(
      `${encodedHeader}.${encodedPayload}`,
      signature,
      jwt,
    );
    if (!isValid) {
      return null;
    }

    const payload: TPayload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );
    if (
      typeof payload.exp === "number" &&
      payload.exp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function encodeSegment(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createSignature(payload: string, jwt: JwtKeyMaterial): string {
  if (jwt.algorithm === "RS256") {
    return createSign("RSA-SHA256").update(payload).sign(jwt.signingKey, "base64url");
  }
  return createHmac("sha256", jwt.signingKey).update(payload).digest("base64url");
}

function verifySignature(
  payload: string,
  signature: string,
  jwt: JwtKeyMaterial,
): boolean {
  if (jwt.algorithm === "RS256") {
    return createVerify("RSA-SHA256")
      .update(payload)
      .verify(jwt.verificationKey, signature, "base64url");
  }

  const expectedSignature = createHmac("sha256", jwt.verificationKey)
    .update(payload)
    .digest("base64url");
  return timingSafeEqualBase64(signature, expectedSignature);
}

function timingSafeEqualBase64(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "base64url");
  const bufferB = Buffer.from(b, "base64url");
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

function extractBearerToken(request: SkyRequest): string | undefined {
  const headerValue =
    getHeader(request.headers, "authorization") ??
    getHeader(request.headers, "Authorization");
  if (!headerValue || typeof headerValue !== "string") {
    return undefined;
  }

  const [scheme, token] = headerValue.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return undefined;
  }
  return token;
}

function getHeader(
  headers: SkyRequest["headers"],
  key: string,
): string | string[] | undefined {
  return headers[key];
}

function extractCookie(request: SkyRequest, name: string): string | undefined {
  const value =
    getHeader(request.headers, "cookie") ??
    getHeader(request.headers, "Cookie");
  if (!value) {
    return undefined;
  }

  const cookies = Array.isArray(value) ? value : [value];
  for (const cookie of cookies) {
    const parts = cookie.split(";");
    for (const part of parts) {
      const [rawKey, ...rawValue] = part.trim().split("=");
      if (rawKey === name) {
        return rawValue.join("=");
      }
    }
  }
  return undefined;
}

function clearExistingUser(
  context: SkyContext,
  request: SkyRequest,
  key: string,
): void {
  delete context.services[key];
  if (context.meta && typeof context.meta === "object") {
    delete (context.meta as Record<string, unknown>).user;
  }
  request.user = undefined;
}

/** @internal */
export const __authInternals = {
  resolveAuthConfig,
  defaultTokenResolver,
  createAuthHelpers,
  issueTokens,
  verifyJwt,
  extractCookie,
  extractBearerToken,
};

interface JwtKeyMaterial {
  algorithm: JwtAlgorithm;
  signingKey: string;
  verificationKey: string;
}

interface ResolvedAuthConfig {
  jwt: JwtKeyMaterial;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  cookieName?: string;
}
