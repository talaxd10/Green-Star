// Signing in and out.
//
//   POST /v1/auth/login     Sign in with phone + password
//   POST /v1/auth/logout    End this device's session
//   GET  /v1/me             Who I am
//   POST /v1/auth/password  Change my password

import { ChangePasswordRequest, SignInRequest, type Me } from "@green-star/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { authOf } from "../app.ts";
import { lockSignIn, recordAttempt, secondsToWait } from "../auth/limits.ts";
import { hashPassword, verifyPassword } from "../auth/passwords.ts";
import {
  COOKIE_MAX_AGE_SECONDS,
  createSession,
  endSessions,
  SESSION_COOKIE,
  signInKey,
  toMe,
  toUser,
  type UserRow,
} from "../auth/sessions.ts";
import { ApiError, parse } from "../errors.ts";

const tooMany = (seconds: number) =>
  new ApiError(429, "too_many_attempts", `Too many wrong tries. Wait ${Math.ceil(seconds / 60)} minutes and try again.`, {
    retryAfterSeconds: seconds,
  });

// One answer for a wrong phone and a wrong password, so neither can be told from the other.
const signInFailed = () => new ApiError(401, "sign_in_failed", "Wrong phone number or password");

interface CredentialRow extends UserRow {
  password_hash: string | null;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, decoyHash } = app.ctx;

  const cookieOptions = {
    httpOnly: true, // scripts on the page cannot read it
    sameSite: "lax" as const, // not sent when another website makes the request
    secure: config.cookieSecure,
    path: "/",
  };
  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: COOKIE_MAX_AGE_SECONDS });

  app.post("/auth/login", { config: { access: "public" } }, async (request, reply): Promise<Me> => {
    const body = parse(SignInRequest, request.body);
    const key = signInKey(body.phone);
    const ip = request.ip ?? null;
    const device = request.headers["user-agent"] ?? null;

    // The try is recorded in the same transaction that checked the limit, and
    // the transaction commits whether the password was right or wrong.
    const outcome = await db.write(null, async (q) => {
      await lockSignIn(q, key);
      const wait = await secondsToWait(q, key, ip);
      if (wait !== null) return { kind: "wait" as const, wait };

      const row = await q.first<CredentialRow>(
        `select u.id, u.name, u.phone, u.active, c.password_hash
         from users u left join user_credentials c on c.user_id = u.id
         where u.active and u.phone = $1`,
        [key],
      );
      // Always check a hash, so an unknown phone takes as long as a wrong password.
      const matches = await verifyPassword(body.password, row?.password_hash ?? decoyHash);
      const ok = matches && row !== undefined && row.password_hash !== null;
      await recordAttempt(q, key, ip, ok);
      if (!ok) return { kind: "failed" as const };
      return { kind: "ok" as const, ...(await createSession(q, toUser(row), device, ip)) };
    });

    if (outcome.kind === "wait") throw tooMany(outcome.wait);
    if (outcome.kind === "failed") throw signInFailed();
    setCookie(reply, outcome.token);
    return toMe(outcome.auth);
  });

  // Public on purpose: signing out must work even when the session has already ended.
  app.post("/auth/logout", { config: { access: "public" } }, async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token !== undefined) {
      await db.write(null, (q) =>
        q.query(
          `update sessions set revoked_at = now(), revoked_by = user_id
           where token_hash = sha256($1::bytea) and revoked_at is null`,
          [Buffer.from(token)],
        ),
      );
    }
    void reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return reply.status(204).send();
  });

  app.get("/me", { config: { access: "signed_in" } }, async (request): Promise<Me> => toMe(authOf(request)));

  app.post("/auth/password", { config: { access: "signed_in", keyless: true } }, async (request, reply) => {
    const auth = authOf(request);
    const body = parse(ChangePasswordRequest, request.body);
    const key = auth.user.phone;
    const ip = request.ip ?? null;
    const nextHash = await hashPassword(body.next, config.scrypt);

    const outcome = await db.write(auth.user.id, async (q) => {
      await lockSignIn(q, key);
      const wait = await secondsToWait(q, key, ip);
      if (wait !== null) return { kind: "wait" as const, wait };

      const current = await q.first<{ password_hash: string }>(
        "select password_hash from user_credentials where user_id = $1",
        [auth.user.id],
      );
      const ok = await verifyPassword(body.current, current?.password_hash ?? decoyHash);
      if (!ok || current === undefined) {
        await recordAttempt(q, key, ip, false);
        return { kind: "failed" as const };
      }
      await q.query("update user_credentials set password_hash = $2 where user_id = $1", [auth.user.id, nextHash]);
      await endSessions(q, auth.user.id, auth.user.id, auth.sessionId);
      return { kind: "ok" as const };
    });

    if (outcome.kind === "wait") throw tooMany(outcome.wait);
    if (outcome.kind === "failed") throw new ApiError(422, "password_wrong", "Your current password is not right");
    return reply.status(204).send();
  });
}
