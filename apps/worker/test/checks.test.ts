// The worker, against a real Postgres: it runs the checks on a timer, the
// deep one every so often, and one failed run does not end it.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lit, psql, requireEnv, withActor } from "@green-star/db";
import pg from "pg";
import { DEFAULT_SCHEDULE, isDeepRun, runChecks, scheduleFromEnv, startWorker } from "../src/checks.ts";

const OWNER = requireEnv("DATABASE_URL");
const APP = requireEnv("APP_DATABASE_URL");
const CEO = randomUUID();
psql(OWNER, `insert into users (id, name, role, phone) values (${lit(CEO)}, 'Worker test CEO', 'ceo', '+9647700000001');`);
const asCeo = (sql: string) => psql(withActor(APP, CEO), sql);
const owner = (sql: string) => psql(OWNER, sql);

// The worker's own connection: the application's login, with nobody acting.
const pool = new pg.Pool({ connectionString: APP, max: 2 });
after(() => pool.end());

/** Waits until something is true, and fails the test if it never is. A test never waits for ever. */
async function until(done: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`waited ${ms} ms and still not: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The promise, or a failed test if it takes longer than this. */
function within<T>(promise: Promise<T>, what: string, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`waited ${ms} ms and still not: ${what}`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const alerts = (kind: string, subject: string) =>
  owner(`select coalesce(string_agg(status::text, ' ' order by opened_at, id), '') from alerts where kind = ${lit(kind)} and subject = ${lit(subject)};`);

test("the deep check runs on the first run and then every so many runs", () => {
  const every15 = { everySeconds: 60, deepEvery: 15 };
  assert.deepEqual([1, 2, 15, 16, 17, 31].map((run) => isDeepRun(run, every15)), [true, false, false, true, false, true]);
  assert.deepEqual([1, 2, 3].map((run) => isDeepRun(run, { everySeconds: 60, deepEvery: 1 })), [true, true, true]);
});

test("the schedule comes from the environment, and a wrong value stops the worker from starting", () => {
  assert.deepEqual(scheduleFromEnv({}), DEFAULT_SCHEDULE);
  assert.deepEqual(scheduleFromEnv({ CHECK_EVERY_SECONDS: "", DEEP_CHECK_EVERY_RUNS: "" }), DEFAULT_SCHEDULE);
  assert.deepEqual(scheduleFromEnv({ CHECK_EVERY_SECONDS: "30", DEEP_CHECK_EVERY_RUNS: "4" }), { everySeconds: 30, deepEvery: 4 });
  assert.throws(() => scheduleFromEnv({ CHECK_EVERY_SECONDS: "soon" }), /CHECK_EVERY_SECONDS/);
  assert.throws(() => scheduleFromEnv({ CHECK_EVERY_SECONDS: "1" }), /CHECK_EVERY_SECONDS/);
  assert.throws(() => scheduleFromEnv({ CHECK_EVERY_SECONDS: "2.5" }), /CHECK_EVERY_SECONDS/);
  assert.throws(() => scheduleFromEnv({ DEEP_CHECK_EVERY_RUNS: "0" }), /DEEP_CHECK_EVERY_RUNS/);
});

test("a run opens an alert for what is wrong, once", async () => {
  const customer = randomUUID();
  const shipment = randomUUID();
  asCeo(`
    insert into customers (id, display_name) values (${lit(customer)}, 'Over His Limit');
    select gs_set_customer_trust(${lit(customer)}, 'trusted', 10000, ${lit(CEO)}, 'China office');
    insert into shipments (id, code) values (${lit(shipment)}, 'GSSK-WORKER-1');
    insert into consignments (shipment_id, customer_id, amount_due_usd_cents) values (${lit(shipment)}, ${lit(customer)}, 15000);
    select gs_confirm_shipment(${lit(shipment)}, ${lit(CEO)}, now());`);
  assert.equal(alerts("over_limit", customer), "", "nobody has run the checks yet");

  const first = await runChecks(pool, false);
  assert.equal(first.deep, false);
  assert.equal(first.opened, 1);
  assert.equal(alerts("over_limit", customer), "open");

  const second = await runChecks(pool, false);
  assert.equal(second.opened, 0);
  assert.equal(alerts("over_limit", customer), "open");
});

test("only the deep run reads the whole ledger", async () => {
  const vault = owner("select id from accounts where code = 'vault_usd';");
  // Something no rule lets through: the cached balance of the vault is changed by hand.
  owner(`insert into account_balances (account_id, currency, balance) values (${lit(vault)}, 'USD', 1)
         on conflict (account_id) do update set balance = account_balances.balance + 1;`);
  const subject = owner("select left(problem || ' ' || detail, 400) from gs_ledger_health() limit 1;");
  assert.match(subject, /^balance_cache_wrong /);

  assert.equal((await runChecks(pool, false)).opened, 0);
  assert.equal(alerts("books_out_of_step", subject), "");
  const deep = await runChecks(pool, true);
  assert.equal(deep.deep, true);
  assert.equal(deep.opened, 1);
  assert.equal(alerts("books_out_of_step", subject), "open");

  owner(`update account_balances set balance = balance - 1 where account_id = ${lit(vault)};`);
  await runChecks(pool, false);
  assert.equal(alerts("books_out_of_step", subject), "open");
  await runChecks(pool, true);
  assert.equal(alerts("books_out_of_step", subject), "cleared");
  assert.equal(owner("select count(*) from gs_ledger_health();"), "0");
});

test("the worker runs now, then on its timer, and stops when told to", async () => {
  const lines: Record<string, unknown>[] = [];
  const worker = startWorker(pool, { everySeconds: 0.05, deepEvery: 2 }, (line) => lines.push(line));
  try {
    await until(() => lines.length >= 3, "three runs");
  } finally {
    worker.stop();
  }
  await within(worker.done, "the worker stopping");
  assert.deepEqual(lines.slice(0, 3).map((line) => [line.msg, line.deep]), [["checks", true], ["checks", false], ["checks", true]]);

  // Asleep for an hour, it still stops at once.
  const slow: Record<string, unknown>[] = [];
  const sleeper = startWorker(pool, { everySeconds: 3600, deepEvery: 1 }, (line) => slow.push(line));
  await until(() => slow.length >= 1, "the first run");
  sleeper.stop();
  await within(sleeper.done, "stop() ending the worker without waiting for its timer", 1000);
  assert.equal(slow.length, 1);
});

test("a run that fails is logged and the next one still happens", async () => {
  let calls = 0;
  const flaky = {
    query: async (text: string, params: unknown[]) => {
      calls += 1;
      if (calls <= 2) throw new Error("the database is restarting");
      return pool.query(text, params);
    },
  } as unknown as pg.Pool;
  const lines: Record<string, unknown>[] = [];
  const worker = startWorker(flaky, { everySeconds: 0.02, deepEvery: 100 }, (line) => lines.push(line));
  try {
    await until(() => lines.length >= 4, "two failed runs and two that worked");
  } finally {
    worker.stop();
  }
  await within(worker.done, "the worker stopping");
  assert.deepEqual(lines.slice(0, 4).map((line) => line.msg), ["checks failed", "checks failed", "checks", "checks"]);
  assert.equal(lines[0]?.error, "the database is restarting");
});
