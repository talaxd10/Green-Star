// What happens when the same request arrives several times at once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { currencyExchange, currencyExchangeToDinars, officePayment, usd } from "@green-star/domain";
import { lit, psql, renderPost } from "../src/index.ts";
import {
  APP,
  USER,
  app,
  balances,
  charge,
  confirmSql,
  draftShipmentSql,
  enterResult,
  handInSql,
  health,
  newCustomer,
  resultSql,
  roundOut,
} from "./helpers.ts";

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

test("the same round result saved eight times at once is one result and one payment", async () => {
  const customerId = newCustomer();
  const { consignmentId } = charge(customerId, 10000n);
  const roundId = roundOut([consignmentId]);
  const id = randomUUID();
  const sql = `begin;\n${resultSql({ id, roundId, consignmentId, outcome: "paid", received: { amount: 10000, currency: "USD" } })}\nselect pg_sleep(0.2) is null;\ncommit;`;
  const results = await Promise.all(Array.from({ length: 8 }, () => psqlAsync(sql)));
  assert.equal(new Set(results.map((r) => r.split("\n")[0])).size, 1);
  assert.equal(app(`select count(*) from round_results where round_id = ${lit(roundId)};`), "1");
  assert.equal(balances().get(`driver:${roundId}:USD`), 10000n);
  assert.equal(app(`select balance_usd_cents from customer_balances where customer_id = ${lit(customerId)};`), "0");

  // The hand-in too: eight clicks move the cash to the vault once.
  const before = balances().get("vault_usd") ?? 0n;
  const handInId = randomUUID();
  const handInOnce = `begin;\n${handInSql(roundId, { id: handInId, usd: { 10000: 1 } })}\nselect pg_sleep(0.2) is null;\ncommit;`;
  await Promise.all(Array.from({ length: 8 }, () => psqlAsync(handInOnce)));
  assert.equal((balances().get("vault_usd") ?? 0n) - before, 10000n);
  assert.equal(balances().get(`driver:${roundId}:USD`), 0n);
  assert.equal(app(`select count(*) from round_hand_ins where round_id = ${lit(roundId)};`), "1");
  assert.equal(health(), "");
});

test("two different results for one stop at the same moment leave exactly one standing", async () => {
  const customerId = newCustomer();
  const { consignmentId } = charge(customerId, 10000n);
  const roundId = roundOut([consignmentId]);
  const save = (cents: number) =>
    psqlAsync(`begin;\n${resultSql({ roundId, consignmentId, outcome: "paid", received: { amount: cents, currency: "USD" } })}\nselect pg_sleep(0.2) is null;\ncommit;`);
  await Promise.all([save(10000), save(9000), save(8000), save(7000)]);
  assert.equal(app(`select count(*) from round_results where round_id = ${lit(roundId)} and voided_at is null;`), "1");
  const standing = BigInt(app(`select received_amount from round_results where round_id = ${lit(roundId)} and voided_at is null;`));
  // The round's cash and the customer's account both hold exactly the one that stands.
  assert.equal(balances().get(`driver:${roundId}:USD`), standing);
  assert.equal(app(`select balance_usd_cents from customer_balances where customer_id = ${lit(customerId)};`), String(10000n - standing));
  assert.equal(health(), "");
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request takes a customer's lock and sits on it, then runs `then`. The
 * other request starts while it waits. If the two take their locks in
 * different orders, Postgres reports a deadlock and one of them fails.
 */
async function whileHolding(customerId: string, then: string, other: string): Promise<[string, string]> {
  const first = psqlAsync(`begin;\nselect gs_lock_customer(${lit(customerId)}) is null;\nselect pg_sleep(0.6) is null;\n${then}\ncommit;`);
  await pause(200);
  const second = psqlAsync(other);
  return Promise.all([first, second]);
}

const officePaymentSql = (customerId: string, cents: number) =>
  renderPost(officePayment({ customerId, received: usd(cents) }), {
    happenedAt: new Date("2026-10-02T09:00:00Z"),
    createdBy: USER,
    idempotencyKey: randomUUID(),
  });

test("an office payment waits for the customer before it writes anything", async () => {
  // A round result for the customer is in flight. The payment must not grab the customer's
  // account first and then wait for the customer, or the two wait on each other for ever.
  const customerId = newCustomer();
  const { consignmentId } = charge(customerId, 10000n);
  const roundId = roundOut([consignmentId]);
  await whileHolding(
    customerId,
    resultSql({ roundId, consignmentId, outcome: "paid", received: { amount: 6000, currency: "USD" } }),
    officePaymentSql(customerId, 1000),
  );
  assert.equal(app(`select balance_usd_cents from customer_balances where customer_id = ${lit(customerId)};`), "3000");
  assert.equal(health(), "");
});

test("a round result waits for the customer before it locks his consignment", async () => {
  const customerId = newCustomer();
  const { consignmentId } = charge(customerId, 10000n);
  const roundId = roundOut([consignmentId]);
  await whileHolding(
    customerId,
    `update consignments set cartons_received = 3 where id = ${lit(consignmentId)};`,
    resultSql({ roundId, consignmentId, outcome: "paid", received: { amount: 10000, currency: "USD" } }),
  );
  assert.equal(app(`select cartons_received || ',' || status from consignments where id = ${lit(consignmentId)};`), "3,delivered_paid");
  assert.equal(health(), "");
});

test("cancelling a consignment and confirming a file wait for the customer first too", async () => {
  const customerId = newCustomer();
  const { consignmentId } = charge(customerId, 10000n);
  await whileHolding(
    customerId,
    `update consignments set cartons_received = 2 where id = ${lit(consignmentId)};`,
    `select gs_cancel_consignment(${lit(consignmentId)}, ${lit(USER)}, 'Goods belonged to someone else');`,
  );
  assert.equal(app(`select cartons_received || ',' || status from consignments where id = ${lit(consignmentId)};`), "2,cancelled");

  const shipmentId = randomUUID();
  const draft = randomUUID();
  app(draftShipmentSql(shipmentId, [[customerId, 5000n, draft]]));
  await whileHolding(
    customerId,
    `update consignments set cartons_expected = 4 where id = ${lit(draft)};`,
    confirmSql(shipmentId, new Date("2026-10-02T08:00:00Z")),
  );
  assert.equal(app(`select cartons_expected || ',' || (charge_entry_id is not null) from consignments where id = ${lit(draft)};`), "4,true");
  assert.equal(health(), "");
});

test("a hand-in and a payment for the same customer at once leave the right status", async () => {
  // A trusted customer took his goods on account. He pays at the office at the very moment the
  // round is handed in. Whichever finishes last has to see the other, or the consignment is
  // left saying "on account" when it is paid and counted in.
  const customerId = newCustomer();
  app(`select gs_set_customer_trust(${lit(customerId)}, 'trusted', null, ${lit(USER)}, 'China office');`);
  const { consignmentId, shipmentId } = charge(customerId, 31000n);
  const roundId = roundOut([consignmentId]);
  enterResult({ roundId, consignmentId, outcome: "on_account" });

  const paying = psqlAsync(`begin;\n${officePaymentSql(customerId, 31000)}\nselect pg_sleep(0.6) is null;\ncommit;`);
  await pause(200);
  await Promise.all([paying, psqlAsync(handInSql(roundId))]);

  assert.equal(app(`select status from consignments where id = ${lit(consignmentId)};`), "closed");
  assert.equal(app(`select status from shipments where id = ${lit(shipmentId)};`), "closed");
  assert.equal(health(), "");
});

test("payments, results and a hand-in for the same customers all at once", async () => {
  const customers = Array.from({ length: 6 }, () => newCustomer());
  const consignments = customers.map((customerId) => charge(customerId, 10000n).consignmentId);
  const roundId = roundOut(consignments);
  // A second round, already entered, whose hand-in races with everything below.
  const earlier = customers.map((customerId) => charge(customerId, 2000n).consignmentId);
  const earlierRound = roundOut(earlier);
  for (const consignmentId of earlier) {
    enterResult({ roundId: earlierRound, consignmentId, outcome: "paid", received: { amount: 2000, currency: "USD" } });
  }

  const work: Promise<string>[] = [];
  customers.forEach((customerId, i) => {
    work.push(psqlAsync(officePaymentSql(customerId, 1000)));
    work.push(psqlAsync(resultSql({ roundId, consignmentId: consignments[i]!, outcome: "paid", received: { amount: 6000, currency: "USD" } })));
    work.push(psqlAsync(officePaymentSql(customerId, 1000)));
    if (i === 2) work.push(psqlAsync(handInSql(earlierRound, { usd: { 10000: 1, 2000: 1 } })));
    work.push(psqlAsync(officePaymentSql(customerId, 1000)));
  });
  await Promise.all(work);

  for (const customerId of customers) {
    // $120.00 owed; $20.00 and $60.00 at the door, three payments of $10.00 at the office.
    assert.equal(app(`select balance_usd_cents from customer_balances where customer_id = ${lit(customerId)};`), "1000");
  }
  assert.equal(app(`select status from rounds where id = ${lit(earlierRound)};`), "handed_in");
  assert.equal(balances().get(`driver:${earlierRound}:USD`), 0n);
  assert.equal(health(), "");
});

test("exchanges in both directions at once reach the vault's two currencies in the same order", async () => {
  // One changes dinars into dollars, the other dollars into dinars. Written naively they would
  // lock the two vault accounts in opposite orders and deadlock.
  const before = balances();
  const at = { happenedAt: new Date("2026-10-02T09:00:00Z"), createdBy: USER };
  const hold = (sql: string) => `begin;\n${sql}\nselect pg_sleep(0.05) is null;\ncommit;`;
  const work: Promise<string>[] = [];
  for (let i = 0; i < 12; i++) {
    work.push(psqlAsync(hold(renderPost(currencyExchange({ iqdGiven: 145000n, usdCentsReceived: 10000n }), { ...at, idempotencyKey: randomUUID() }))));
    work.push(psqlAsync(hold(renderPost(currencyExchangeToDinars({ usdCentsGiven: 10000n, iqdReceived: 145000n }), { ...at, idempotencyKey: randomUUID() }))));
  }
  await Promise.all(work);
  const after = balances();
  assert.equal(after.get("vault_usd"), before.get("vault_usd"));
  assert.equal(after.get("vault_iqd"), before.get("vault_iqd"));
  assert.equal(health(), "");
});
