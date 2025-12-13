import { SkyPlugin } from "../../src/core/plugin";
import { authPlugin, AuthUser } from "../../src/plugins/auth";

export interface DemoAuthUser extends AuthUser {
  email: string;
  name: string;
  role: "admin" | "reader";
}

interface DemoAccount extends DemoAuthUser {
  password: string;
}

export interface DemoLoginRequest {
  email: string;
  password: string;
}

const demoAccounts: DemoAccount[] = [
  {
    id: "user-ada",
    email: "ada@example.com",
    name: "Ada Lovelace",
    role: "admin",
    password: "pass-ada",
  },
  {
    id: "user-linus",
    email: "linus@example.com",
    name: "Linus Torvalds",
    role: "reader",
    password: "pass-linus",
  },
];

export function createDemoAuthPlugin(): SkyPlugin {
  return authPlugin({
    config: {
      jwtSecret: process.env.SKY_AUTH_JWT_SECRET ?? "demo-secret",
      accessTokenTtlSeconds: 15 * 60,
      refreshTokenTtlSeconds: 7 * 24 * 60 * 60,
      cookieName: "demo.auth",
    },
    async resolveUser(payload) {
      return findDemoUserById(payload.sub);
    },
  });
}

export function parseDemoLoginRequest(body: unknown): DemoLoginRequest | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const value = body as Record<string, unknown>;
  const email = value.email;
  const password = value.password;
  if (typeof email !== "string" || typeof password !== "string") {
    return null;
  }
  return { email, password };
}

export function authenticateDemoUser(
  credentials: DemoLoginRequest,
): DemoAuthUser | undefined {
  const account = demoAccounts.find(
    (demoUser) =>
      demoUser.email === credentials.email &&
      demoUser.password === credentials.password,
  );
  return account ? toDemoAuthUser(account) : undefined;
}

function findDemoUserById(id: string | undefined): DemoAuthUser | null {
  if (!id) {
    return null;
  }
  const account = demoAccounts.find((user) => user.id === id);
  return account ? toDemoAuthUser(account) : null;
}

function toDemoAuthUser(account: DemoAccount): DemoAuthUser {
  const { password: _ignored, ...user } = account;
  return user;
}
