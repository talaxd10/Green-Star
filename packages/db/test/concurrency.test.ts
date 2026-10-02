// What happens when the same request arrives several times at once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { officePayment, usd } from "@green-star/domain";
import { lit, psql, renderPost, requireEnv } from "../src/index.ts";

const APP = requireEnv("APP_DATABASE_URL");
const USER = "99999999-9999-4999-8999-999999999999";

function psqlAsync(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", APP]);
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))));
    child.stdin.end(sql);
  });
}

test("eight clicks on Save at the same moment post one entry", async () => {
  const customerId = randomUUID();
  const key = randomUUID();
  // Create the account first so the race is on the entry alone.
  psql(APP, `select gs_customer_account(${lit(customerId)});`);
  const statement = renderPost(officePayment({ customerId, received: usd(2500) }), {
    happenedAt: new Date("2026-10-02T09:00:00Z"),
    createdBy: USER,
    idempotencyKey: key,
  });
  // Each request holds its transaction open briefly so the others overlap it.
  const sql = `begin;\n${statement}\nselect pg_sleep(0.3) is null;\ncommit;`;
  const results = await Promise.all(Array.from({ length: 8 }, () => psqlAsync(sql)));
  const ids = new Set(results.map((r) => r.split("\n")[0]));
  assert.equal(ids.size, 1, "every request must get the same entry id");
  assert.equal(psql(APP, `select count(*) from journal_entries where idempotency_key = ${lit(key)};`), "1");
  assert.equal(psql(APP, `select balance_usd_cents from customer_balances where customer_id = ${lit(customerId)};`), "-2500");
});

test("a new customer's account is created once under a race", async () => {
  const customerId = randomUUID();
  const sql = `begin;\nselect gs_customer_account(${lit(customerId)});\nselect pg_sleep(0.2) is null;\ncommit;`;
  const results = await Promise.all(Array.from({ length: 8 }, () => psqlAsync(sql)));
  assert.equal(new Set(results.map((r) => r.split("\n")[0])).size, 1);
  assert.equal(psql(APP, `select count(*) from accounts where customer_id = ${lit(customerId)};`), "1");
});

test("many different payments at once all land and the books stay sound", async () => {
  const customerId = randomUUID();
  psql(APP, `select gs_customer_account(${lit(customerId)});`);
  const posts = Array.from({ length: 24 }, (_, i) =>
    psqlAsync(
      renderPost(officePayment({ customerId, received: usd(100 + i) }), {
        happenedAt: new Date("2026-10-02T09:00:00Z"),
        createdBy: USER,
        idempotencyKey: randomUUID(),
      }),
    ),
  );
  await Promise.all(posts);
  // 24 payments of $1.00 to $1.23
  const expected = -Array.from({ length: 24 }, (_, i) => 100 + i).reduce((a, b) => a + b, 0);
  assert.equal(psql(APP, `select balance_usd_cents from customer_balances where customer_id = ${lit(customerId)};`), String(expected));
  assert.equal(psql(APP, "select count(*) from gs_ledger_health();"), "0");
});
