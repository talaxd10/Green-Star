// The API: one Fastify app, REST with JSON under /v1.
//
// Three things are decided here, once, for every address:
//
//   1. Every address says who may call it. One that does not is refused at
//      start-up, so nothing can be opened to everyone by forgetting.
//   2. A browser on another website cannot make a signed-in user's browser
//      change anything: the cookie is not sent across sites, and a request
//      that names another site as its origin is refused.
//   3. Every error leaves in the same shape, with a code that never changes.

import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import type { Access, Role } from "@green-star/contracts";
import Fastify, { LogController, type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { hashPassword } from "./auth/passwords.ts";
import { findSession, SESSION_COOKIE, type Auth } from "./auth/sessions.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { ApiError, fromDatabase, invalidRequest, notAllowed, notSignedIn } from "./errors.ts";
import { alertRoutes } from "./routes/alerts.ts";
import { authRoutes } from "./routes/auth.ts";
import { customerRoutes } from "./routes/customers.ts";
import { healthRoutes } from "./routes/health.ts";
import { moneyRoutes } from "./routes/money.ts";
import { roundRoutes } from "./routes/rounds.ts";
import { shipmentRoutes } from "./routes/shipments.ts";
import { userRoutes } from "./routes/users.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** Who is signed in. Null on public addresses. */
    auth: Auth | null;
  }
  interface FastifyContextConfig {
    /** Who may call this address. Required on every route. */
    access?: Access;
    /** True for the few writes that are safe to repeat as they are and take no Idempotency-Key. */
    keyless?: boolean;
  }
}

export interface AppContext {
  config: Config;
  db: Db;
  /** A hash of nothing, checked when the account does not exist, so a wrong phone takes as long as a wrong password. */
  decoyHash: string;
  /** The checks that run after every save: how often they failed since the API started, and whether the latest run did. */
  checks: { failed: number; failing: boolean; lastError: string | null };
}

export interface RouteInfo {
  method: string;
  url: string;
  access: Access;
}

declare module "fastify" {
  interface FastifyInstance {
    ctx: AppContext;
    /** Every address and who may call it. */
    routeList: RouteInfo[];
  }
}

/** The signed-in user of a request. Every non-public address has one. */
export function authOf(request: FastifyRequest): Auth {
  if (request.auth === null) throw notSignedIn();
  return request.auth;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const KEY = /^[A-Za-z0-9._:-]{8,200}$/;

/** The request's Idempotency-Key: one new value for each click on Save. */
export function requireKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (key === undefined || key === "") {
    throw new ApiError(400, "idempotency_key_required", "Send an Idempotency-Key header: one new value for each click on Save");
  }
  if (!KEY.test(key)) {
    throw new ApiError(400, "idempotency_key_invalid", "An Idempotency-Key is 8 to 200 letters, digits, dots, dashes, colons or underscores");
  }
  return key;
}

export async function buildApp(config: Config, db: Db): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.log
      ? { redact: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]'] }
      : false,
    // Requests are logged below by their address pattern, never their real
    // address, so a phone number typed into a search never reaches the logs.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  app.decorate("ctx", {
    config,
    db,
    decoyHash: await hashPassword("no account has this password", config.scrypt),
    checks: { failed: 0, failing: false, lastError: null },
  });
  app.decorate("routeList", []);
  app.decorateRequest("auth", null);

  await app.register(cookie);
  await app.register(cors, {
    origin: [...config.webOrigins],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Idempotency-Key"],
    maxAge: 600,
  });

  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (methods.every((method) => method === "OPTIONS" || method === "HEAD")) return;
    const access = route.config?.access;
    if (access === undefined) {
      throw new Error(`${methods.join(",")} ${route.url} does not say who may call it. Set config.access.`);
    }
    for (const method of methods) app.routeList.push({ method, url: route.url, access });
  });

  app.addHook("onRequest", async (request) => {
    // A request a browser sends from another website names that website here.
    const origin = request.headers.origin;
    if (UNSAFE.has(request.method) && origin !== undefined && !config.webOrigins.includes(origin)) {
      throw new ApiError(403, "origin_not_allowed", "This request came from another website");
    }

    const access = request.routeOptions.config.access;
    if (access === undefined || access === "public") return;

    const token = request.cookies[SESSION_COOKIE];
    const auth = token === undefined ? null : await findSession(db.direct, token);
    if (auth === null) throw notSignedIn();
    if (!(access as readonly Role[]).includes(auth.user.role)) throw notAllowed();
    request.auth = auth;

    // Every write carries a key, so a double click on Save is done once.
    // Asked for here, before anything else is looked at.
    if (UNSAFE.has(request.method) && request.routeOptions.config.keyless !== true) requireKey(request);
  });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? "(no such address)",
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
        user: request.auth?.user.id,
      },
      "request",
    );
  });

  app.setNotFoundHandler(async (_request, reply) => {
    await reply.status(404).send(new ApiError(404, "not_found", "There is nothing at this address").body());
  });

  app.setErrorHandler(async (error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
    const known = toApiError(error);
    if (known === null) {
      request.log.error({ err: error }, "unexpected error");
      // With the log switched off (the tests), an error nobody expected is still shown.
      if (!config.log) console.error(error);
      await reply.status(500).send(new ApiError(500, "internal_error", "Something went wrong. Nothing was saved.").body());
      return;
    }
    if (known.retryAfterSeconds !== undefined) void reply.header("Retry-After", String(known.retryAfterSeconds));
    await reply.status(known.status).send(known.body());
  });

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/v1" });
  await app.register(userRoutes, { prefix: "/v1" });
  await app.register(customerRoutes, { prefix: "/v1" });
  await app.register(shipmentRoutes, { prefix: "/v1" });
  await app.register(roundRoutes, { prefix: "/v1" });
  await app.register(moneyRoutes, { prefix: "/v1" });
  await app.register(alertRoutes, { prefix: "/v1" });

  return app;
}

function toApiError(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  if (error instanceof z.ZodError) return invalidRequest(error);
  const fromDb = fromDatabase(error);
  if (fromDb !== null) return fromDb;

  // Fastify's own refusals: a body that is not JSON, too large, or of the wrong type.
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    if (status === 413) return new ApiError(413, "too_large", "The request is too large");
    if (status === 415) return new ApiError(415, "not_json", "Send the request as JSON");
    return new ApiError(status === 404 ? 404 : 400, "invalid_request", "The request is not valid");
  }
  return null;
}
