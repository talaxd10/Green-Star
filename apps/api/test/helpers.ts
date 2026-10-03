// Shared by the API tests. Every test talks to the real app over its real
// routes, against a real Postgres. Nothing is mocked.

import { randomInt, randomUUID } from "node:crypto";
import type { Role } from "@green-star/contracts";
import { requireEnv } from "@green-star/db";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp } from "../src/app.ts";
import { hashPassword } from "../src/auth/passwords.ts";
import type { Config } from "../src/config.ts";
import { Db } from "../src/db.ts";

export const WEB = "http://localhost:3000";

/** Cheap hashes: the tests check the rules, not how long a password takes to guess. */
export const TEST_COST = { N: 1024, r: 8, p: 1 };

export const config: Config = {
  databaseUrl: requireEnv("APP_DATABASE_URL"),
  host: "127.0.0.1",
  port: 0,
  webOrigins: [WEB],
  cookieSecure: true,
  trustProxy: false,
  scrypt: TEST_COST,
  log: false,
};

export interface Harness {
  app: FastifyInstance;
  db: Db;
  /** As the role that owns the schema: for setting a scene and looking behind the API. */
  owner: pg.Pool;
  close(): Promise<void>;
}

export async function start(overrides: Partial<Config> = {}): Promise<Harness> {
  const db = new Db(config.databaseUrl);
  const app = await buildApp({ ...config, ...overrides }, db);
  const owner = new pg.Pool({ connectionString: requireEnv("DATABASE_URL"), max: 2 });
  return {
    app,
    db,
    owner,
    async close() {
      await app.close();
      await db.close();
      await owner.end();
    },
  };
}

export interface Reply {
  status: number;
  // The tests read whatever the API sent; each assertion says what it expects.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Record<string, string | string[] | number | undefined>;
  /** The session cookie this reply set, as a Cookie header, or null. */
  cookie: string | null;
  /** The Set-Cookie line for the session, as sent. */
  setCookie: string | null;
}

export interface CallOptions {
  body?: unknown;
  cookie?: string | null;
  origin?: string;
  /** The address the request comes from. */
  ip?: string;
  headers?: Record<string, string>;
}

export async function call(app: FastifyInstance, method: string, url: string, options: CallOptions = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.body !== undefined) headers["content-type"] ??= "application/json";

  const response = await app.inject({
    method: method as "GET",
    url,
    headers,
    ...(options.body === undefined ? {} : { payload: typeof options.body === "string" ? options.body : JSON.stringify(options.body) }),
    remoteAddress: options.ip ?? "10.0.0.1",
  });

  const raw = response.headers["set-cookie"];
  const lines = raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)];
  const setCookie = lines.find((line) => line.startsWith("gs_session=")) ?? null;
  const value = setCookie === null ? "" : (setCookie.split(";")[0] as string).slice("gs_session=".length);
  let body: unknown = null;
  if (response.body.length > 0) {
    try {
      body = JSON.parse(response.body);
    } catch {
      body = response.body;
    }
  }
  return {
    status: response.statusCode,
    body,
    headers: response.headers,
    cookie: value.length > 0 ? `gs_session=${value}` : null,
    setCookie,
  };
}

let counter = 0;
/** A phone number no other test uses. */
export const nextPhone = () => `+96475${randomInt(10_000_000, 99_999_999)}`;

export const PASSWORD = "correct horse battery";

export interface Seeded {
  id: string;
  phone: string | null;
  signInName: string | null;
  password: string;
}

/** Puts a user straight into the database, the way create-ceo does for the first CEO. */
export async function seedUser(h: Harness, role: Role, name = `Test ${role}`, password = PASSWORD): Promise<Seeded> {
  const id = randomUUID();
  const phone = role === "monitor" ? null : nextPhone();
  const signInName = role === "monitor" ? `screen${randomInt(1_000_000, 9_999_999)}x${++counter}` : null;
  await h.owner.query("insert into users (id, name, role, phone, sign_in_name) values ($1, $2, $3, $4, $5)", [
    id,
    name,
    role,
    phone,
    signInName,
  ]);
  await h.owner.query("insert into user_credentials (user_id, password_hash) values ($1, $2)", [
    id,
    await hashPassword(password, TEST_COST),
  ]);
  return { id, phone, signInName, password };
}

/** Signs in and returns the session cookie. */
export async function signIn(h: Harness, user: Seeded, options: CallOptions = {}): Promise<string> {
  const reply = await call(h.app, "POST", "/v1/auth/login", {
    ...options,
    body: { phone: user.phone ?? user.signInName, password: user.password },
  });
  if (reply.status !== 200 || reply.cookie === null) {
    throw new Error(`sign-in failed: ${reply.status} ${JSON.stringify(reply.body)}`);
  }
  return reply.cookie;
}

/** One signed-in user of each role. */
export async function everyRole(h: Harness): Promise<Record<Role, { user: Seeded; cookie: string }>> {
  const out = {} as Record<Role, { user: Seeded; cookie: string }>;
  for (const role of ["ceo", "owner", "monitor"] as const) {
    const user = await seedUser(h, role);
    out[role] = { user, cookie: await signIn(h, user) };
  }
  return out;
}
