// The API inside the office app, for hosts that only run short requests
// (Vercel). Each request the office app gets at /v1 is handed to the same
// Fastify app the standalone API runs, with no network in between.
//
// The worker's timer does not exist there, so the clock checks (goods held
// too long, the vault not counted by closing time) run when the office is
// read, at most once a minute, and the deep check once a day from the host's
// daily timer (dailyChecks).

import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { Db } from "./db.ts";
import { appDatabaseUrl, appPassword } from "./hosting.ts";

const CHECK_EVERY_MS = 60_000;

let started: Promise<FastifyInstance> | null = null;
let lastChecks = 0;

/** The environment, with the app login worked out from the owner's when it is not set. */
function environment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if ((env.APP_DATABASE_URL ?? "") === "" && (env.DATABASE_URL ?? "") !== "") {
    const owner = env.DATABASE_URL as string;
    env.APP_DATABASE_URL = appDatabaseUrl(owner, appPassword(owner, env.APP_DB_PASSWORD));
  }
  return env;
}

/** The app, built on the first request and kept while the host keeps this instance. */
function app(): Promise<FastifyInstance> {
  if (started === null) {
    const starting = (async () => {
      // The caller's address is passed in by hand below; nothing else is trusted for it.
      const config = { ...configFromEnv(environment()), trustProxy: false };
      const built = await buildApp(config, new Db(config.databaseUrl, 3));
      await built.ready();
      return built;
    })();
    started = starting;
    // A start that failed is tried again on the next request.
    starting.catch(() => {
      if (started === starting) started = null;
    });
  }
  return started;
}

async function clockChecks(built: FastifyInstance, deep: boolean): Promise<void> {
  if (!deep && Date.now() - lastChecks < CHECK_EVERY_MS) return;
  lastChecks = Date.now();
  try {
    await built.ctx.db.direct.query("select gs_sync_alerts($1)", [deep]);
  } catch (error) {
    built.log.error({ err: error }, "the clock checks failed");
  }
}

/** One request to /v1, answered by the API. */
export async function handle(request: Request): Promise<Response> {
  const built = await app();
  if (request.method === "GET") await clockChecks(built, false);

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  // The office app and the API are one site here. A request from this same
  // site is let through as same-origin; one from any other site keeps its
  // Origin, and the API refuses it as always.
  const origin = headers.origin;
  if (origin !== undefined) {
    try {
      if (new URL(origin).host === (headers["x-forwarded-host"] ?? headers.host)) delete headers.origin;
    } catch {
      // Not an address: the API refuses it.
    }
  }

  const url = new URL(request.url);
  const body = request.method === "GET" || request.method === "HEAD" ? null : Buffer.from(await request.arrayBuffer());
  const options: InjectOptions = {
    method: request.method as NonNullable<InjectOptions["method"]>,
    url: url.pathname + url.search,
    headers,
    remoteAddress: headers["x-forwarded-for"]?.split(",")[0]?.trim() || "127.0.0.1",
  };
  if (body !== null && body.length > 0) options.payload = body;
  const reply = await built.inject(options);

  const out = new Headers();
  for (const [key, value] of Object.entries(reply.headers)) {
    if (value === undefined || key === "content-length" || key === "transfer-encoding" || key === "connection") continue;
    for (const one of Array.isArray(value) ? value : [value]) out.append(key, String(one));
  }
  const empty = reply.statusCode === 204 || reply.statusCode === 304 || request.method === "HEAD";
  return new Response(empty ? null : new Uint8Array(reply.rawPayload), { status: reply.statusCode, headers: out });
}

/** The deep check, which reads every line in the books. Once a day, from the host's timer. */
export async function dailyChecks(): Promise<void> {
  await clockChecks(await app(), true);
}
