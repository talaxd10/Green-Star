// Sessions: one per device, each one can be ended on its own.
//
// The browser holds a random token in a cookie that scripts cannot read.
// The database holds only the token's sha256, so reading the sessions table
// cannot sign anyone in.

import { createHash, randomBytes } from "node:crypto";
import type { Me, User } from "@green-star/contracts";
import { normalizePhone } from "@green-star/domain";
import type { Queryable } from "../db.ts";

export const SESSION_COOKIE = "gs_session";

/** The longest a browser keeps a cookie. The database decides when a session really ends. */
export const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/** A session ends when it has not been used for this many days. */
export const IDLE_DAYS = 14;

/** "Last seen" is written at most this often, so reading a screen is not a write every time. */
const TOUCH_AFTER_MS = 5 * 60 * 1000;

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function newToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

/**
 * What was typed in the phone field, as the database stores it: a phone in
 * international form. Anything else is kept as typed, and matches no account.
 */
export function signInKey(typed: string): string {
  return normalizePhone(typed) ?? typed.trim().toLowerCase();
}

export interface UserRow {
  [key: string]: unknown;
  id: string;
  name: string;
  phone: string;
  active: boolean;
}

export function toUser(row: UserRow): User {
  return { id: row.id, name: row.name, phone: row.phone, active: row.active };
}

/** Who is making this request. */
export interface Auth {
  user: User;
  sessionId: string;
  expiresAt: Date;
}

export function toMe(auth: Auth): Me {
  return {
    user: auth.user,
    session: { id: auth.sessionId, expiresAt: auth.expiresAt.toISOString() },
  };
}

export async function createSession(
  q: Queryable,
  user: User,
  device: string | null,
  ip: string | null,
): Promise<{ token: string; auth: Auth }> {
  const { token, hash } = newToken();
  const row = await q.first<{ id: string; expires_at: Date }>(
    `insert into sessions (user_id, token_hash, device, ip, expires_at)
     values ($1, $2, $3, $4, now() + make_interval(days => $5))
     returning id, expires_at`,
    [user.id, hash, device?.slice(0, 300) ?? null, ip, IDLE_DAYS],
  );
  if (row === undefined) throw new Error("the session was not created");
  return { token, auth: { user, sessionId: row.id, expiresAt: row.expires_at } };
}

interface SessionRow extends UserRow {
  session_id: string;
  last_seen_at: Date;
  expires_at: Date;
}

/**
 * The user behind a session token, or null when the session has ended, has
 * not been used for too long, or belongs to a user who was switched off.
 */
export async function findSession(q: Queryable, token: string): Promise<Auth | null> {
  if (token.length < 20 || token.length > 100) return null;
  const row = await q.first<SessionRow>(
    `select s.id as session_id, s.last_seen_at, s.expires_at,
            u.id, u.name, u.phone, u.active
     from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and u.active`,
    [hashToken(token)],
  );
  if (row === undefined) return null;

  let expiresAt = row.expires_at;
  if (Date.now() - row.last_seen_at.getTime() > TOUCH_AFTER_MS) {
    const touched = await q.first<{ expires_at: Date }>(
      `update sessions set last_seen_at = now(), expires_at = now() + make_interval(days => $2)
       where id = $1 and revoked_at is null returning expires_at`,
      [row.session_id, IDLE_DAYS],
    );
    if (touched !== undefined) expiresAt = touched.expires_at;
  }
  return { user: toUser(row), sessionId: row.session_id, expiresAt };
}

/** Ends every session of a user, except one to keep. Returns how many ended. */
export async function endSessions(q: Queryable, userId: string, by: string, keepSessionId: string | null = null): Promise<number> {
  const rows = await q.query(
    `update sessions set revoked_at = now(), revoked_by = $2
     where user_id = $1 and revoked_at is null and ($3::uuid is null or id <> $3)
     returning id`,
    [userId, by, keepSessionId],
  );
  return rows.length;
}
