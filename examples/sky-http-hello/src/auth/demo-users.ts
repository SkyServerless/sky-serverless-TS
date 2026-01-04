import { AuthUser } from "../../../../src";

export interface DemoUser extends AuthUser {
  email: string;
  name: string;
  role: "admin" | "reader";
}

interface DemoAccount extends DemoUser {
  password: string;
}

export interface LoginRequest {
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

export function parseLoginRequest(body: unknown): LoginRequest | null {
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
  credentials: LoginRequest,
): DemoUser | null {
  const account = demoAccounts.find(
    (demoUser) =>
      demoUser.email === credentials.email &&
      demoUser.password === credentials.password,
  );
  return account ? toDemoUser(account) : null;
}

export function findDemoUserById(id: string | undefined): DemoUser | null {
  if (!id) {
    return null;
  }
  const account = demoAccounts.find((user) => user.id === id);
  return account ? toDemoUser(account) : null;
}

function toDemoUser(account: DemoAccount): DemoUser {
  const { password: _ignored, ...user } = account;
  return user;
}
