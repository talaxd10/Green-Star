// One stop paid in more than one way, proven against a real Postgres: every
// part is its own entry, dollars are applied first, the dinars settle what is
// left, and taking the result back reverses every part.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lit } from "../src/index.ts";
import { USER, app, charge, consignmentStatus, customerBalance, enterResult, handIn, health, makeTrusted, newCustomer, owner, refused, resultSql, roundOut, setRate, shipmentStatus } from "./helpers.ts";

// These tests keep to their own days, so no other test file changes their rates.
const RATE = 157000;                       // 1,570 per dollar: the CEO's example
setRate("2027-03-03", RATE);
const day = (hour: number) => new Date(Date.UTC(2027, 2, 3, hour));
const LEFT = day(6);
const DOOR = day(12);

const on = (code: string) => BigInt(app(`select coalesce((select balance from account_overview where code = ${lit(code)}), 0);`));
const remaining = (consignmentId: string) => BigInt(app(`select remaining_usd_cents from consignment_money where consignment_id = ${lit(consignmentId)};`));
/** What the receipts say the driver holds, per currency: "USD:40000 IQD:209000". */
const roundCash = (roundId: string) =>
  app(`select coalesce(string_agg(currency || ':' || collected, ' ' order by currency), '') from round_cash where round_id = ${lit(roundId)} and collected <> 0;`);
/** Every part of a stop's payment, in the order it was applied: "driver_cash:40000:USD:40000 ...". */
const parts = (roundId: string, consignmentId: string) =>
  app(
    `select coalesce(string_agg((p ->> 'method') || ':' || (p ->> 'received_amount') || ':' || (p ->> 'received_currency') || ':' || (p ->> 'credited_usd_cents'), ' ' order by n), '')
     from round_stop_details d, jsonb_array_elements(d.payments) with ordinality as t (p, n)
     where d.round_id = ${lit(roundId)} and d.consignment_id = ${lit(consignmentId)};`,
  );
const entriesOf = (resultId: string) => app(`select count(*) from round_payment_entries where result_id = ${lit(resultId)};`);

/** One customer with one consignment, out on a round. */
function atTheDoor(name: string, cents: bigint) {
  const customer = newCustomer(name);
  const { consignmentId, shipmentId } = charge(customer, cents, day(4));
  return { customer, consignmentId, shipmentId, round: roundOut([consignmentId], LEFT) };
}

test("the CEO's example at the door: $400 in dollars and 209,000 IQD pay $533, and the driver holds both", () => {
  const { customer, consignmentId, shipmentId, round } = atTheDoor("Door Mixed", 53300n);
  const rounding = on("dinar_rounding_usd");

  const result = enterResult({
    roundId: round, consignmentId, outcome: "paid", at: DOOR,
    received: { amount: 40000, currency: "USD" },
    more: [{ amount: 209000, currency: "IQD" }],
  });

  assert.deepEqual([customerBalance(customer), remaining(consignmentId)], [0n, 0n]);
  assert.equal(parts(round, consignmentId), "driver_cash:40000:USD:40000 driver_cash:209000:IQD:13300");
  assert.equal(roundCash(round), "USD:40000 IQD:209000");
  assert.equal(on("dinar_rounding_usd") - rounding, -12n);
  // One result, one row for the rest of what he handed over, two entries in the ledger.
  assert.equal(app(`select received_amount || '|' || received_currency || '|' || credited_usd_cents from round_results where id = ${lit(result)};`), "40000|USD|40000");
  assert.equal(
    app(`select part_no || '|' || received_amount || '|' || received_currency || '|' || method || '|' || iqd_per_100_usd || '|' || credited_usd_cents from round_result_parts where result_id = ${lit(result)};`),
    "2|209000|IQD|driver_cash|157000|13300",
  );
  assert.equal(entriesOf(result), "2");
  assert.equal(app(`select count(*) from payments where customer_id = ${lit(customer)} and round_id = ${lit(round)} and not reversed;`), "2");
  assert.equal(app(`select count(*) from missed_collections where round_id = ${lit(round)};`), "0");
  assert.equal(consignmentStatus(consignmentId), "delivered_paid");

  // The driver hands in exactly that, and the file closes.
  handIn(round, { usd: { 10000: 4 }, iqd: { 50000: 4, 5000: 1, 1000: 4 }, at: day(15) });
  assert.equal(app(`select string_agg(currency || ':' || gap, ' ' order by currency) from round_cash where round_id = ${lit(round)};`), "USD:0 IQD:0");
  assert.equal(shipmentStatus(shipmentId), "closed");
  assert.equal(health(), "");
});

test("dollars are applied first whatever order they are given in, so the dinars settle what is left", () => {
  const { customer, consignmentId, round } = atTheDoor("Dinars First", 53300n);
  enterResult({
    roundId: round, consignmentId, outcome: "paid", at: DOOR,
    received: { amount: 209000, currency: "IQD" },
    more: [{ amount: 40000, currency: "USD" }],
  });
  // Had the dinars gone first they would be worth $133.12 and leave him 12 cents in credit.
  assert.equal(customerBalance(customer), 0n);
  assert.equal(parts(round, consignmentId), "driver_cash:40000:USD:40000 driver_cash:209000:IQD:13300");
});

test("cash and a wallet at one stop: the driver holds only the cash", () => {
  const { customer, consignmentId, round } = atTheDoor("Three Ways", 53300n);
  const wallet = { iqd: on("wallet_fib_iqd"), usd: on("wallet_fastpay_usd") };

  // $200 in cash, $100 by FastPay, 100,000 IQD in cash, and the rest by FIB in dinars.
  // What is left for the last part: $533 - $300 - 100,000 IQD ($63.69) = $169.31 = 265,817 IQD. He sends 266,000.
  const result = enterResult({
    roundId: round, consignmentId, outcome: "paid", at: DOOR,
    received: { amount: 20000, currency: "USD" },
    more: [
      { amount: 100000, currency: "IQD" },
      { amount: 10000, currency: "USD", method: "fastpay" },
      { amount: 266000, currency: "IQD", method: "fib" },
    ],
  });
  assert.equal(customerBalance(customer), 0n);
  assert.equal(parts(round, consignmentId), "driver_cash:20000:USD:20000 fastpay:10000:USD:10000 driver_cash:100000:IQD:6369 fib:266000:IQD:16931");
  assert.equal(roundCash(round), "USD:20000 IQD:100000", "wallet money is not the driver's to hand in");
  assert.equal(on("wallet_fib_iqd") - wallet.iqd, 266000n);
  assert.equal(on("wallet_fastpay_usd") - wallet.usd, 10000n);
  assert.equal(entriesOf(result), "4");
  // Each part is its own line on his statement, and each says which round it was taken on.
  assert.equal(
    app(`select string_agg(what || ':' || change_usd_cents || ':' || (round_id = ${lit(round)}), ' ' order by line_no) from gs_customer_statement(${lit(customer)}) where what <> 'file_confirmed';`),
    "driver_collected:-20000:true wallet_payment:-10000:true driver_collected:-6369:true wallet_payment:-16931:true",
  );
  assert.equal(health(), "");
});

test("a single dinar payment at the door is rounded too, and a part payment is not", () => {
  const settled = atTheDoor("Door Rounded", 13300n);
  enterResult({ roundId: settled.round, consignmentId: settled.consignmentId, outcome: "paid", at: DOOR, received: { amount: 208500, currency: "IQD" } });
  assert.equal(customerBalance(settled.customer), 0n);
  assert.equal(parts(settled.round, settled.consignmentId), "driver_cash:208500:IQD:13300");

  const part = atTheDoor("Door Part", 13300n);
  enterResult({ roundId: part.round, consignmentId: part.consignmentId, outcome: "unpaid", at: DOOR, received: { amount: 150000, currency: "IQD" } });
  assert.equal(customerBalance(part.customer), 13300n - 9554n);     // 150,000 at 1,570 is $95.54, to the cent
  assert.equal(app(`select count(*) from missed_collections where round_id = ${lit(part.round)};`), "1");

  const over = atTheDoor("Door Over", 13300n);
  enterResult({ roundId: over.round, consignmentId: over.consignmentId, outcome: "paid", at: DOOR, received: { amount: 250000, currency: "IQD" } });
  assert.equal(customerBalance(over.customer), 13300n - 15924n, "what is over is his credit, to the cent");
  assert.equal(health(), "");
});

test("a trusted customer who pays off everything at the door in dinars owes nothing after", () => {
  const customer = newCustomer("Trusted Clears All");
  makeTrusted(customer);
  const older = charge(customer, 10000n, day(3)).consignmentId;
  const today = charge(customer, 6200n, day(4)).consignmentId;
  const round = roundOut([today], LEFT);
  // $162.00 is 254,340 IQD. He hands over 254,000.
  enterResult({ roundId: round, consignmentId: today, outcome: "paid", at: DOOR, received: { amount: 254000, currency: "IQD" } });
  assert.deepEqual([customerBalance(customer), remaining(today), remaining(older)], [0n, 0n, 0n]);
  assert.equal(parts(round, today), "driver_cash:254000:IQD:16200");

  // Dinars that come to today's goods alone settle those, and the older file stays owed.
  const again = newCustomer("Trusted Pays Today");
  makeTrusted(again);
  const before = charge(again, 10000n, day(3)).consignmentId;
  const now = charge(again, 6200n, day(4)).consignmentId;
  const second = roundOut([now], LEFT);
  enterResult({ roundId: second, consignmentId: now, outcome: "paid", at: DOOR, received: { amount: 97000, currency: "IQD" } });   // $62.00 is 97,340
  assert.deepEqual([customerBalance(again), remaining(now), remaining(before)], [10000n, 0n, 10000n]);
  assert.equal(health(), "");
});

test("what is typed for the other payments is checked like the first", () => {
  const { customer, consignmentId, round } = atTheDoor("Refused Parts", 53300n);
  const first = { amount: 40000, currency: "USD" as const };
  const tryMore = (more: readonly { amount: number; currency: string; method?: string }[], received: typeof first | null = first) =>
    enterResult({ roundId: round, consignmentId, outcome: "paid", at: DOOR, ...(received === null ? {} : { received }), more });

  refused(() => tryMore([{ amount: 0, currency: "IQD" }]), /amount_invalid/);
  refused(() => tryMore([{ amount: -5, currency: "IQD" }]), /amount_invalid/);
  refused(() => tryMore([{ amount: 1.5, currency: "IQD" }]), /amount_invalid/);
  refused(() => tryMore([{ amount: 1000, currency: "EUR" }]), /payment_invalid: money is taken in dollars or dinars/);
  refused(() => tryMore([{ amount: 1000, currency: "IQD", method: "office_cash" }]), /method_invalid/);
  refused(() => tryMore([{ amount: 1000, currency: "IQD", method: "cheque" }]), /method_invalid/);
  // Two payments the same way are one payment.
  refused(() => tryMore([{ amount: 1000, currency: "USD" }]), /payment_invalid: two payments in the same currency and the same way/);
  refused(() => tryMore([{ amount: 1000, currency: "IQD" }, { amount: 2000, currency: "IQD" }]), /payment_invalid: two payments/);
  // At most four.
  refused(
    () => tryMore([{ amount: 1000, currency: "IQD" }, { amount: 1000, currency: "USD", method: "fib" }, { amount: 1000, currency: "IQD", method: "fib" }, { amount: 1000, currency: "USD", method: "zaincash" }]),
    /payment_invalid: one stop takes at most four payments/,
  );
  // The rest without a first, and things that are not a list of payments.
  refused(() => tryMore([{ amount: 1000, currency: "IQD" }], null), /payment_incomplete: other payments were given without a first one/);
  const rawMore = (json: string) =>
    app(`select gs_enter_round_result(${lit(randomUUID())}, ${lit(round)}, ${lit(consignmentId)}, 'paid', ${lit(USER)}, ${lit(DOOR.toISOString())}, 40000, 'USD', 'driver_cash', null, ${lit(json)}::jsonb);`);
  refused(() => rawMore('{"amount": 1000}'), /payment_incomplete: the other payments must be a list/);
  refused(() => rawMore('[1000]'), /payment_incomplete/);
  refused(() => rawMore('[{"amount": 1000, "currency": "IQD"}]'), /payment_incomplete/);
  refused(() => rawMore('[{"amount": "many", "currency": "IQD", "method": "driver_cash"}]'), /amount_invalid/);
  // Goods that stayed in the car, and prepaid goods, take no money in any part.
  refused(() => enterResult({ roundId: round, consignmentId, outcome: "held", at: DOOR, received: first, more: [{ amount: 1000, currency: "IQD" }] }), /outcome_invalid/);

  // A refused result writes nothing at all, not even the parts that were fine.
  assert.equal(app(`select count(*) from round_results where round_id = ${lit(round)};`), "0");
  assert.equal(app(`select count(*) from payments where customer_id = ${lit(customer)};`), "0");
  assert.equal(roundCash(round), "");
  assert.equal(customerBalance(customer), 53300n);

  // An empty list is no other payments.
  tryMore([]);
  assert.equal(parts(round, consignmentId), "driver_cash:40000:USD:40000");
  assert.equal(customerBalance(customer), 13300n);
});

test("entering the stop again, or taking the result back, reverses every part", () => {
  const { customer, consignmentId, round } = atTheDoor("Replaced Parts", 53300n);
  const rounding = on("dinar_rounding_usd");
  const id = randomUUID();
  const input = {
    roundId: round, consignmentId, outcome: "paid" as const, at: DOOR, id,
    received: { amount: 40000, currency: "USD" as const },
    more: [{ amount: 209000, currency: "IQD" }],
  };
  enterResult(input);
  enterResult(input);                                  // the same request again
  assert.equal(app(`select count(*) from round_results where round_id = ${lit(round)};`), "1");
  assert.equal(entriesOf(id), "2");
  assert.equal(customerBalance(customer), 0n);

  // The receipt was read wrong: it was $300 and 366,000 IQD.
  const second = enterResult({ ...input, id: randomUUID(), received: { amount: 30000, currency: "USD" }, more: [{ amount: 366000, currency: "IQD" }] });
  assert.equal(app(`select voided_at is not null from round_results where id = ${lit(id)};`), "t");
  assert.equal(app(`select count(*) from payments where customer_id = ${lit(customer)} and reversed;`), "2", "both parts of the first result are reversed");
  assert.equal(parts(round, consignmentId), "driver_cash:30000:USD:30000 driver_cash:366000:IQD:23300");   // $233.00 is 365,810
  assert.equal(roundCash(round), "USD:30000 IQD:366000");
  assert.equal(customerBalance(customer), 0n);
  assert.equal(health(), "");

  // Taken back: he owes it all again, the driver holds nothing, and rounding is where it was.
  app(`select gs_void_round_result(${lit(second)}, ${lit(USER)}, 'Wrong customer');`);
  assert.equal(customerBalance(customer), 53300n);
  assert.equal(remaining(consignmentId), 53300n);
  assert.equal(roundCash(round), "");
  assert.equal(on("dinar_rounding_usd"), rounding);
  assert.equal(parts(round, consignmentId), "");
  assert.equal(app(`select count(*) from payments where customer_id = ${lit(customer)} and not reversed;`), "0");
  assert.equal(health(), "");
});

test("a part's payment is changed through the round, and a part is never edited", () => {
  const { customer, consignmentId, round } = atTheDoor("Guarded Parts", 53300n);
  const result = enterResult({
    roundId: round, consignmentId, outcome: "paid", at: DOOR,
    received: { amount: 40000, currency: "USD" },
    more: [{ amount: 209000, currency: "IQD", method: "fib" }],
  });
  const wallet = app(`select payment_entry_id from round_result_parts where result_id = ${lit(result)};`);
  // The second part is a wallet payment: reversing it by hand would leave the result saying he paid.
  refused(
    () => app(`select gs_reverse_entry(${lit(wallet)}, ${lit(USER)}, 'by hand', ${lit(randomUUID())});`),
    /round_money_needs_round: change the round result instead of reversing its payment/,
  );
  refused(() => app(`update round_result_parts set received_amount = 1 where result_id = ${lit(result)};`), /permission denied/);
  refused(() => app(`delete from round_result_parts where result_id = ${lit(result)};`), /permission denied/);
  refused(() => app(`insert into round_result_parts (result_id, part_no, received_amount, received_currency, method, credited_usd_cents, payment_entry_id) values (${lit(result)}, 3, 100, 'USD', 'fib', 100, ${lit(wallet)});`), /permission denied/);
  refused(() => owner(`update round_result_parts set credited_usd_cents = 1 where result_id = ${lit(result)};`), /ledger_immutable/);
  refused(() => owner(`delete from round_result_parts where result_id = ${lit(result)};`), /ledger_immutable/);
  refused(() => owner("truncate round_result_parts;"), /ledger_immutable|cannot truncate/);
  assert.equal(customerBalance(customer), 0n);
  assert.equal(health(), "");
});

test("the SQL a stop is entered with says every part", () => {
  // The helper the other tests use sends the rest of the money as the eleventh argument.
  const sql = resultSql({ roundId: randomUUID(), consignmentId: randomUUID(), outcome: "paid", received: { amount: 1, currency: "USD" }, more: [{ amount: 2, currency: "IQD" }] });
  assert.match(sql, /1, 'USD', 'driver_cash', null, '\[\{"amount":2,"currency":"IQD","method":"driver_cash"\}\]'::jsonb\);$/);
});
