// The API's connection to Postgres.
//
// Two rules live here and nowhere else:
//
//   1. Every change runs in a transaction that tells the database who is
//      acting (gs.actor). The database refuses changes that carry no name,
//      and refuses money posted by anyone but the CEO who is acting.
//   2. Everything that only reads runs in a read-only transaction, so a
//      screen that reads can never change anything, whatever its code does.

import pg from "pg";

const INT8 = 20;
const NUMERIC = 1700;
const DATE = 1082;

function wholeNumber(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`the database returned a number too large to handle safely: ${value}`);
  }
  return n;
}

// Money is whole numbers (cents and dinars) and never close to this limit.
// Postgres sends bigint as text; here it becomes a number or the read fails.
// A date stays "YYYY-MM-DD": it is a Baghdad day, not an instant.
const types: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (oid === INT8) return wholeNumber;
    if (oid === NUMERIC) return (value: string) => (/^-?\d+$/.test(value) ? wholeNumber(value) : value);
    if (oid === DATE) return (value: string) => value;
    return pg.types.getTypeParser(oid, format as "text");
  }) as pg.CustomTypesConfig["getTypeParser"],
};

export type Row = Record<string, unknown>;

/** Something SQL can be sent to: the pool, or one transaction. */
export interface Queryable {
  /** Every row. */
  query<T extends Row = Row>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** The first row, or undefined. */
  first<T extends Row = Row>(text: string, params?: readonly unknown[]): Promise<T | undefined>;
  /** The single value of the first row: `select gs_post_entry(...)`. */
  value<T = unknown>(text: string, params?: readonly unknown[]): Promise<T>;
}

function queryable(run: (text: string, params?: readonly unknown[]) => Promise<pg.QueryResult>): Queryable {
  return {
    async query<T extends Row>(text: string, params?: readonly unknown[]) {
      return (await run(text, params)).rows as T[];
    },
    async first<T extends Row>(text: string, params?: readonly unknown[]) {
      return (await run(text, params)).rows[0] as T | undefined;
    },
    async value<T>(text: string, params?: readonly unknown[]) {
      const row = (await run(text, params)).rows[0] as Row | undefined;
      if (row === undefined) throw new Error("the statement returned no row");
      return Object.values(row)[0] as T;
    },
  };
}

/** Postgres gave up on one of two transactions waiting on each other. Nothing was written. */
const RETRYABLE = new Set(["40P01", "40001"]);
const ATTEMPTS = 4;

function isRetryable(error: unknown): boolean {
  return typeof error === "object" && error !== null && RETRYABLE.has(String((error as { code?: unknown }).code));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Db {
  readonly #pool: pg.Pool;

  /**
   * Single statements outside a transaction, with nobody acting. Only for
   * finding the session behind a request, which happens before anyone is
   * known. Everything else goes through read() or write().
   */
  readonly direct: Queryable;

  constructor(connectionString: string, max = 10) {
    this.#pool = new pg.Pool({ connectionString, max, types });
    // A connection dropped while idle is replaced by the pool. Without a
    // listener it would take the whole process down.
    this.#pool.on("error", () => {});
    this.direct = queryable((text, params) => this.#pool.query(text, params as unknown[]));
  }

  /** Reads in one read-only transaction: every statement sees the same moment. */
  async read<T>(work: (q: Queryable) => Promise<T>): Promise<T> {
    return this.#transaction("begin transaction isolation level repeatable read read only", null, work);
  }

  /**
   * Changes in one transaction, acting as this user. Pass null only where
   * nobody is signed in yet: signing in itself.
   *
   * If Postgres reports a deadlock nothing was written, so the work is run
   * again. Every write the API sends carries its own id, which makes that safe.
   */
  async write<T>(actorId: string | null, work: (q: Queryable) => Promise<T>): Promise<T> {
    if (actorId !== null && !UUID.test(actorId)) throw new TypeError(`not a user id: ${actorId}`);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.#transaction("begin", actorId, work);
      } catch (error) {
        if (attempt >= ATTEMPTS || !isRetryable(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.random() * 30));
      }
    }
  }

  async #transaction<T>(begin: string, actorId: string | null, work: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    let broken = false;
    try {
      await client.query(begin);
      if (actorId !== null) {
        await client.query("select set_config('gs.actor', $1, true)", [actorId]);
      }
      const result = await work(queryable((text, params) => client.query(text, params as unknown[])));
      await client.query("commit");
      return result;
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        broken = true;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  /** True when the database answers. */
  async ping(): Promise<boolean> {
    try {
      await this.#pool.query("select 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
