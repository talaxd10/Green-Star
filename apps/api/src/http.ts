// What every route shares: safe retries for writes, pages for lists, and
// turning database rows into the shapes in packages/contracts.

import { createHash } from "node:crypto";
import type { Page, PageQuery } from "@green-star/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { authOf, requireKey, type AppContext } from "./app.ts";
import type { Auth } from "./auth/sessions.ts";
import type { Queryable, Row } from "./db.ts";
import { ApiError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface WriteContext {
  q: Queryable;
  auth: Auth;
  /** The request's own key. Passed on to the ledger, which also posts a key only once. */
  key: string;
}

export interface WriteResult<T> {
  /** 200 unless said otherwise. */
  status?: number;
  body: T;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Runs a change in one transaction, acting as the signed-in user, and makes
 * it safe to send twice.
 *
 * Every write carries an Idempotency-Key header: a value the office app makes
 * up for one click on Save. The key is recorded in the same transaction as
 * the change. When the same key arrives again (a double click, or a retry
 * after the connection dropped) the first answer is returned and nothing is
 * done again. The same key with a different request is refused.
 */
export async function write<T>(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  work: (context: WriteContext) => Promise<WriteResult<T>>,
): Promise<T> {
  const auth = authOf(request);
  const key = requireKey(request);
  const path = request.url.split("?")[0] as string;
  const hash = createHash("sha256")
    .update(`${request.method}\n${path}\n${stable(request.body ?? null)}`)
    .digest();

  const outcome = await ctx.db.write(auth.user.id, async (q) => {
    const fresh = await q.first(
      `insert into api_requests (key, user_id, method, path, request_hash) values ($1, $2, $3, $4, $5)
       on conflict (key) do nothing returning key`,
      [key, auth.user.id, request.method, path, hash],
    );
    if (fresh === undefined) {
      const first = await q.first<{ user_id: string; request_hash: Buffer; status: number | null; response: unknown }>(
        "select user_id, request_hash, status, response from api_requests where key = $1",
        [key],
      );
      if (first === undefined || first.user_id !== auth.user.id || !first.request_hash.equals(hash) || first.status === null) {
        throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key was already used for a different request");
      }
      return { replay: true, status: first.status, body: first.response as T };
    }
    const result = await work({ q, auth, key });
    const status = result.status ?? 200;
    await q.query("update api_requests set status = $2, response = $3::jsonb where key = $1", [
      key,
      status,
      JSON.stringify(result.body ?? null),
    ]);
    await runChecks(ctx, request, q);
    return { replay: false, status, body: result.body };
  });

  if (outcome.replay) void reply.header("Idempotent-Replay", "true");
  void reply.status(outcome.status);
  return outcome.body;
}

/**
 * Brings the alerts in line with what was just saved, in the same
 * transaction, so the alert is there the moment the save is.
 *
 * A save is never lost because a check failed: the check runs inside a
 * savepoint, and if it fails it is undone alone, counted and logged. The
 * worker runs the same checks on a timer and would bring the alerts back in
 * line. /healthz says so while the latest run is a failed one, so a failing
 * check does not go unseen.
 */
async function runChecks(ctx: AppContext, request: FastifyRequest, q: Queryable): Promise<void> {
  await q.query("savepoint checks");
  try {
    await q.query("select gs_sync_alerts()");
    await q.query("release savepoint checks");
    ctx.checks.failing = false;
  } catch (error) {
    await q.query("rollback to savepoint checks");
    ctx.checks.failed += 1;
    ctx.checks.failing = true;
    ctx.checks.lastError = error instanceof Error ? error.message : String(error);
    request.log.error({ err: error }, "the checks failed after a save");
    if (!ctx.config.log) console.error("the checks failed after a save:", error);
  }
}

/** Reads in one read-only transaction. */
export function read<T>(ctx: AppContext, work: (q: Queryable) => Promise<T>): Promise<T> {
  return ctx.db.read(work);
}

// ---------------------------------------------------------------------------
// When something happened
// ---------------------------------------------------------------------------

const CLOCK_SLACK_MS = 5 * 60 * 1000;

/** The instant a request says something happened, or now. Never in the future. */
export function happened(at: string | undefined, field = "happenedAt"): Date {
  if (at === undefined) return new Date();
  const when = new Date(at);
  if (when.getTime() > Date.now() + CLOCK_SLACK_MS) {
    const message = "That time has not happened yet";
    throw new ApiError(400, "invalid_request", `${field}: ${message}`, { fields: { [field]: message } });
  }
  return when;
}

// ---------------------------------------------------------------------------
// Rows to JSON
// ---------------------------------------------------------------------------

const camelKey = (key: string) => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** A database row in the API's spelling: snake_case becomes camelCase, times become ISO text. */
export function camel<T>(row: Row, rename: Record<string, string> = {}): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith("_")) continue;
    out[rename[key] ?? camelKey(key)] = value instanceof Date ? value.toISOString() : value;
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

interface CursorParts {
  at: string;
  id: string;
}

function decodeCursor(cursor: string): CursorParts {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { at: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw new ApiError(400, "invalid_request", "cursor: That is not a cursor this list gave out", {
    fields: { cursor: "That is not a cursor this list gave out" },
  });
}

/**
 * Builds the SQL for one page of a list, newest first.
 *
 *   const p = pager(query, "e.created_at", "e.id::text");
 *   const rows = await q.query(`select ..., ${p.columns} from ... where true ${p.where(params)} ${p.orderAndLimit(params)}`, params);
 *   return p.page(rows, toItem);
 *
 * The list is cut by (time, id), so a row added while someone is paging
 * through never makes another one appear twice or go missing.
 */
export function pager(query: PageQuery, atExpr: string, idExpr: string) {
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
  return {
    /** The two columns the next cursor is made from. */
    columns: `${atExpr}::text as _at, ${idExpr} as _id`,
    where(params: unknown[]): string {
      if (after === null) return "";
      params.push(after.at, after.id);
      return `and (${atExpr}, ${idExpr}) < ($${params.length - 1}::timestamptz, $${params.length})`;
    },
    orderAndLimit(params: unknown[]): string {
      params.push(query.limit + 1);
      return `order by ${atExpr} desc, ${idExpr} desc limit $${params.length}`;
    },
    page<R extends Row, T>(rows: R[], toItem: (row: R) => T): Page<T> {
      const more = rows.length > query.limit;
      const shown = more ? rows.slice(0, query.limit) : rows;
      const last = shown[shown.length - 1];
      return {
        items: shown.map(toItem),
        nextCursor:
          more && last !== undefined
            ? Buffer.from(JSON.stringify([last._at, last._id]), "utf8").toString("base64url")
            : null,
      };
    },
  };
}

/** A Baghdad day as the instant it starts, for "from" and "to" filters. */
export function dayRange(params: unknown[], column: string, from: string | undefined, to: string | undefined): string {
  let sql = "";
  if (from !== undefined) {
    params.push(from);
    sql += ` and (${column} at time zone 'Asia/Baghdad')::date >= $${params.length}::date`;
  }
  if (to !== undefined) {
    params.push(to);
    sql += ` and (${column} at time zone 'Asia/Baghdad')::date <= $${params.length}::date`;
  }
  return sql;
}
