// What happens when the same request arrives several times at once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { officePayment, usd } from "@green-star/domain";
import { lit, psql, renderPost } from "../src/index.ts";
import { APP, USER, app, charge, health, newCustomer } from "./helpers.ts";

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
  const customerId = newCustomer();
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
  const customerId = newCustomer();
  const sql = `begin;\nselect gs_customer_account(${lit(customerId)});\nselect pg_sleep(0.2) is null;\ncommit;`;
  const results = await Promise.all(Array.from({ length: 8 }, () => psqlAsync(sql)));
  assert.equal(new Set(results.map((r) => r.split("\n")[0])).size, 1);
  assert.equal(psql(APP, `select count(*) from accounts where customer_id = ${lit(customerId)};`), "1");
});

test("many different payments at once all land and the books stay sound", async () => {
  const customerId = newCustomer();
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
  assert.equal(health(), "");
});

test("payments racing for the same unpaid consignment never pay it twice", async () => {
  const customerId = newCustomer();
  const { consignmentId } = charge(customerId, 10000n);
  const pay = (cents: number) =>
    `begin;\n${renderPost(officePayment({ customerId, received: usd(cents) }), {
      happenedAt: new Date("2026-10-02T09:00:00Z"),
      createdBy: USER,
      idempotencyKey: randomUUID(),
    })}\nselect pg_sleep(0.2) is null;\ncommit;`;
  // Six payments of $30.00 against a $100.00 consignment.
  await Promise.all(Array.from({ length: 6 }, () => psqlAsync(pay(3000))));
  assert.equal(
    app(`select due_usd_cents || ',' || paid_usd_cents || ',' || remaining_usd_cents from consignment_money where consignment_id = ${lit(consignmentId)};`),
    "10000,10000,0",
  );
  // $180.00 paid against $100.00 owed: $80.00 stays as credit.
  assert.equal(app(`select balance_usd_cents from customer_balances where customer_id = ${lit(customerId)};`), "-8000");
  assert.equal(
    app(`select sum(credit_usd_cents - allocated_usd_cents) from customer_payments where customer_id = ${lit(customerId)};`),
    "8000",
  );
  assert.equal(health(), "");
});
