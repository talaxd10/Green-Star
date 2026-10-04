// Rounds, proven against a real Postgres: building a round, entering what
// the driver brings back, counting his cash in, and the statuses that follow.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { driverCollected, iqd, iqdToUsdCents, notesFor, officePayment, roundHandedIn, usd } from "@green-star/domain";
import { lit } from "../src/index.ts";
import {
  USER,
  app,
  balances,
  charge,
  confirmSql,
  consignmentStatus,
  customerBalance,
  draftShipmentSql,
  enterResult,
  handIn,
  health,
  keyOf,
  makeTrusted,
  newCustomer,
  newDriver,
  newRound,
  owner,
  post,
  refused,
  resultSql,
  roundOut,
  setRate,
  shipmentStatus,
} from "./helpers.ts";

// The rounds tests keep to their own days so no other test file changes their rates.
const DAY = new Date("2026-11-03T12:00:00Z");
const NEXT_DAY = new Date("2026-11-04T12:00:00Z");
const NO_RATE_DAY = new Date("2026-11-20T12:00:00Z");
setRate("2026-11-03", 145000); // 1,450 per dollar
setRate("2026-11-04", 147000); // 1,470 per dollar

const money = (consignmentId: string) =>
  app(
    `select due_usd_cents || ',' || paid_usd_cents || ',' || remaining_usd_cents
     from consignment_money where consignment_id = ${lit(consignmentId)};`,
  );

/** status, stops, results, missed collections, collected USD, collected IQD, gap USD, gap IQD */
const overview = (roundId: string) =>
  app(
    `select status || ',' || stops || ',' || results || ',' || missed_collections || ',' ||
            collected_usd_cents || ',' || collected_iqd || ',' || gap_usd_cents || ',' || gap_iqd
     from round_overview where round_id = ${lit(roundId)};`,
  );

const missed = (roundId: string) =>
  app(
    `select string_agg(customer_name || ':' || short_by_usd_cents, ' ' order by customer_name)
     from missed_collections where round_id = ${lit(roundId)};`,
  );

const entryCount = () => app("select count(*) from journal_entries;");

/** One confirmed file with one consignment per [customer, cents] pair. */
function file(rows: readonly (readonly [string, bigint])[], at = new Date("2026-11-03T05:00:00Z")) {
  const shipmentId = randomUUID();
  const consignments = rows.map(([customerId, cents]) => [customerId, cents, randomUUID()] as const);
  app(`${draftShipmentSql(shipmentId, consignments)}\n${confirmSql(shipmentId, at)}`);
  return { shipmentId, consignmentIds: consignments.map((c) => c[2]) };
}

test("the board's round 14 comes out exactly", () => {
  // Rate today: 1,450 IQD per $1. Four customers from two files on one round.
  const rebwar = newCustomer("Rebwar A.");
  const shvan = newCustomer("Shvan K.");
  const dara = newCustomer("Dara M.");
  const hemn = newCustomer("Hemn S.");
  makeTrusted(dara);
  const before = balances();

  const gssk6926 = file([[rebwar, 8500n], [shvan, 4000n]]);
  const gssk6931 = file([[dara, 31000n], [hemn, 6200n]]);
  const [cRebwar, cShvan] = gssk6926.consignmentIds as [string, string];
  const [cDara, cHemn] = gssk6931.consignmentIds as [string, string];

  const round = roundOut([cRebwar, cShvan, cDara, cHemn]);
  assert.equal(overview(round), "out,4,0,0,0,0,0,0");

  // Rebwar paid 123,250 IQD. Shvan's goods are held. Dara is on account. Hemn was delivered, not paid.
  enterResult({ roundId: round, consignmentId: cRebwar, outcome: "paid", received: { amount: 123250, currency: "IQD" }, at: DAY });
  enterResult({ roundId: round, consignmentId: cShvan, outcome: "held", at: DAY });
  enterResult({ roundId: round, consignmentId: cDara, outcome: "on_account", at: DAY });
  enterResult({ roundId: round, consignmentId: cHemn, outcome: "unpaid", at: DAY });

  // Receipts entered: 123,250 IQD and $0. One alert: Hemn S. delivered without payment.
  assert.equal(overview(round), "returned,4,4,1,0,123250,0,123250");
  assert.equal(missed(round), "Hemn S.:6200");
  assert.equal(
    app(`select received_amount || ' ' || received_currency || ' -> ' || credited_usd_cents || ' at ' || iqd_per_100_usd
         from round_stop_details where round_id = ${lit(round)} and consignment_id = ${lit(cRebwar)};`),
    "123250 IQD -> 8500 at 145000",
  );

  // The driver hands in 123,250 IQD and no dollars, counted note by note.
  const handInId = handIn(round, { iqd: { 50000: 2, 10000: 2, 1000: 3, 250: 1 } });
  assert.equal(overview(round), "handed_in,4,4,1,0,123250,0,0");
  assert.equal(
    app(`select string_agg(currency || ':' || counted || '/' || expected || '/' || difference, ' ' order by currency)
         from cash_counts where round_hand_in_id = ${lit(handInId)};`),
    "USD:0/0/0 IQD:123250/123250/0",
  );

  const after = balances();
  const delta = (key: string) => (after.get(key) ?? 0n) - (before.get(key) ?? 0n);
  assert.equal(after.get(`customer:${rebwar}`), 0n);
  assert.equal(after.get(`customer:${shvan}`), 4000n);
  assert.equal(after.get(`customer:${dara}`), 31000n);
  assert.equal(after.get(`customer:${hemn}`), 6200n);
  assert.equal(after.get(`driver:${round}:IQD`), 0n);
  assert.equal(delta("vault_iqd"), 123250n);
  assert.equal(delta("vault_usd"), 0n);
  assert.equal(delta("china_payable"), -49700n);
  assert.equal(delta("exchange_clearing_iqd"), -123250n);
  assert.equal(delta("exchange_clearing_usd"), 8500n);

  assert.equal(consignmentStatus(cRebwar), "closed");
  assert.equal(consignmentStatus(cShvan), "held");
  assert.equal(consignmentStatus(cDara), "delivered_on_account");
  assert.equal(consignmentStatus(cHemn), "delivered_not_paid");
  assert.equal(shipmentStatus(gssk6926.shipmentId), "on_rounds"); // Shvan's goods are still in the car
  assert.equal(shipmentStatus(gssk6931.shipmentId), "reconciling"); // Hemn has not paid
  assert.equal(health(), "");
});

test("the database posts the same lines for a round as the app builds", () => {
  const customerId = newCustomer();
  const { consignmentIds } = file([[customerId, 8500n]]);
  const roundId = roundOut(consignmentIds);
  const before = balances();
  enterResult({ roundId, consignmentId: consignmentIds[0]!, outcome: "paid", received: { amount: 123250, currency: "IQD" }, at: DAY });
  handIn(roundId, { iqd: notesFor("IQD", 123250n) });

  const expected = new Map<string, bigint>();
  for (const draft of [
    driverCollected({ roundId, customerId, received: iqd(123250), ratePer100: 145000 }),
    roundHandedIn({ roundId, countedUsdCents: 0n, countedIqd: 123250n }),
  ]) {
    for (const line of draft.lines) expected.set(keyOf(line.account), (expected.get(keyOf(line.account)) ?? 0n) + line.amount);
  }
  const after = balances();
  for (const [key, amount] of expected) {
    assert.equal((after.get(key) ?? 0n) - (before.get(key) ?? 0n), amount, key);
  }
});

test("a round carries goods from any confirmed file, and a consignment is on one round at a time", () => {
  const a = newCustomer("A");
  const b = newCustomer("B");
  const first = file([[a, 5000n]]);
  const second = file([[b, 7000n]]);
  const cA = first.consignmentIds[0]!;
  const cB = second.consignmentIds[0]!;

  // A draft file has charged nobody yet: its goods cannot go out.
  const draftFile = randomUUID();
  const cDraft = randomUUID();
  app(draftShipmentSql(draftFile, [[a, 1000n, cDraft]]));
  const round = newRound();
  refused(() => app(`select gs_add_round_stop(${lit(round)}, ${lit(cDraft)}, ${lit(USER)});`), /file_not_confirmed/);

  refused(() => app(`select gs_round_depart(${lit(round)}, ${lit(USER)});`), /round_empty/);
  app(`select gs_add_round_stop(${lit(round)}, ${lit(cA)}, ${lit(USER)});`);
  app(`select gs_add_round_stop(${lit(round)}, ${lit(cA)}, ${lit(USER)});`); // again: still one stop
  app(`select gs_add_round_stop(${lit(round)}, ${lit(cB)}, ${lit(USER)});`);
  assert.equal(app(`select count(*) from round_stops where round_id = ${lit(round)};`), "2");
  assert.equal(consignmentStatus(cA), "on_round");
  assert.equal(shipmentStatus(first.shipmentId), "on_rounds");

  const other = newRound();
  refused(() => app(`select gs_add_round_stop(${lit(other)}, ${lit(cA)}, ${lit(USER)});`), /consignment_not_available/);

  // Taken off by mistake: back to where it was.
  app(`select gs_remove_round_stop(${lit(round)}, ${lit(cB)}, ${lit(USER)});`);
  assert.equal(consignmentStatus(cB), "listed");
  assert.equal(shipmentStatus(second.shipmentId), "confirmed");
  app(`select gs_add_round_stop(${lit(other)}, ${lit(cB)}, ${lit(USER)});`);

  // Nothing is entered before the driver has left, or for goods that are not on the round.
  refused(() => enterResult({ roundId: round, consignmentId: cA, outcome: "held" }), /round_not_left/);
  app(`select gs_round_depart(${lit(round)}, ${lit(USER)});`);
  refused(() => enterResult({ roundId: round, consignmentId: cB, outcome: "held" }), /stop_not_found/);
  refused(() => handIn(round), /round_not_back/);

  // The round's shape is changed through the functions, never by hand.
  refused(() => app(`insert into round_stops (round_id, consignment_id, status_before, added_by) values (${lit(other)}, ${lit(cA)}, 'listed', ${lit(USER)});`), /permission denied/);
  refused(() => app(`update rounds set status = 'handed_in' where id = ${lit(round)};`), /permission denied/);
  refused(() => app(`update rounds set driver_id = ${lit(newDriver("Someone else"))} where id = ${lit(round)};`), /round_locked/);
  app(`update rounds set driver_id = ${lit(newDriver("Before leaving"))} where id = ${lit(other)};`);
  refused(() => app(`insert into rounds (created_by) values (${lit(USER)});`), /rounds_driver_or_carrier/);

  // Once a result is in, the stop stays on the round.
  enterResult({ roundId: round, consignmentId: cA, outcome: "held" });
  refused(() => app(`select gs_remove_round_stop(${lit(round)}, ${lit(cA)}, ${lit(USER)});`), /stop_has_result/);
  assert.equal(health(), "");
});

test("a transport office carries a round like a driver does", () => {
  const customer = newCustomer();
  const { consignmentIds } = file([[customer, 4000n]]);
  const carrier = randomUUID();
  const round = randomUUID();
  app(
    `insert into carriers (id, name, city, kind) values (${lit(carrier)}, 'Kirkuk transport', 'Kirkuk', 'transport_office');
     insert into rounds (id, carrier_id, created_by) values (${lit(round)}, ${lit(carrier)}, ${lit(USER)});
     select gs_add_round_stop(${lit(round)}, ${lit(consignmentIds[0]!)}, ${lit(USER)});
     select gs_round_depart(${lit(round)}, ${lit(USER)});`,
  );
  enterResult({ roundId: round, consignmentId: consignmentIds[0]!, outcome: "paid", received: { amount: 4000, currency: "USD" } });
  // The office has the money until it sends it: it shows as that round's gap.
  assert.equal(
    app(`select carrier_name || ',' || gap_usd_cents from round_overview where round_id = ${lit(round)};`),
    "Kirkuk transport,4000",
  );
  handIn(round, { usd: { 2000: 2 } });
  assert.equal(overview(round), "handed_in,1,1,0,4000,0,0,0");
});

test("cartons counted at the airport are checked against the file", () => {
  const customer = newCustomer();
  const { consignmentIds } = file([[customer, 5000n]]);
  const consignment = consignmentIds[0]!;
  app(`update consignments set cartons_expected = 5 where id = ${lit(consignment)};`);
  const round = newRound();
  const mismatch = () => app(`select cartons_expected || ',' || cartons_received || ',' || difference from carton_mismatches where consignment_id = ${lit(consignment)};`);

  refused(() => app(`select gs_add_round_stop(${lit(round)}, ${lit(consignment)}, ${lit(USER)}, -1);`), /cartons_invalid/);
  app(`select gs_add_round_stop(${lit(round)}, ${lit(consignment)}, ${lit(USER)}, 4);`);
  assert.equal(mismatch(), "5,4,-1");
  app(`select gs_add_round_stop(${lit(round)}, ${lit(consignment)}, ${lit(USER)}, 5);`); // counted again
  assert.equal(mismatch(), "");
});

test("each outcome has its rules, and a refused result writes nothing", () => {
  const payFirst = newCustomer("Pay first");
  const trusted = newCustomer("Trusted");
  const prepaidCustomer = newCustomer("Prepaid");
  makeTrusted(trusted);
  const { consignmentIds } = file([[payFirst, 8500n], [trusted, 31000n], [prepaidCustomer, 0n]]);
  const [cPay, cTrusted, cPrepaid] = consignmentIds as [string, string, string];
  const round = roundOut(consignmentIds);
  const entries = entryCount();
  const result = (consignmentId: string, outcome: Parameters<typeof enterResult>[0]["outcome"], received?: Parameters<typeof enterResult>[0]["received"]) =>
    enterResult({ roundId: round, consignmentId, outcome, ...(received ? { received } : {}), at: DAY });

  // Goods go on account only for a trusted customer.
  refused(() => result(cPay, "on_account"), /not_trusted/);
  refused(() => result(cTrusted, "unpaid"), /outcome_invalid/);
  // Paid means money changed hands.
  refused(() => result(cPay, "paid"), /payment_missing/);
  refused(() => result(cPay, "paid", { amount: 0, currency: "USD" }), /amount_invalid/);
  refused(() => result(cPay, "paid", { amount: 8500, currency: "USD", method: "office_cash" }), /method_invalid/);
  refused(
    () => app(`select gs_enter_round_result(${lit(randomUUID())}, ${lit(round)}, ${lit(cPay)}, 'paid', ${lit(USER)}, ${lit(DAY.toISOString())}, 8500, null, null);`),
    /payment_incomplete/,
  );
  refused(
    () => app(`select gs_enter_round_result(${lit(randomUUID())}, ${lit(round)}, ${lit(cPay)}, 'held', ${lit(USER)}, ${lit(DAY.toISOString())}, null, 'USD', null);`),
    /payment_incomplete/,
  );
  // Goods that stay in the car take no money, and a prepaid consignment has nothing to collect.
  refused(() => result(cPay, "held", { amount: 8500, currency: "USD" }), /outcome_invalid/);
  refused(() => result(cPay, "prepaid"), /outcome_invalid/);
  refused(() => result(cPrepaid, "paid", { amount: 100, currency: "USD" }), /outcome_invalid/);
  refused(() => result(cPrepaid, "unpaid"), /outcome_invalid/);
  refused(() => result(cPrepaid, "prepaid", { amount: 100, currency: "USD" }), /outcome_invalid/);

  assert.equal(entryCount(), entries, "a refused result must not post anything");
  assert.equal(app(`select count(*) from round_results where round_id = ${lit(round)};`), "0");
  assert.equal(overview(round), "out,3,0,0,0,0,0,0");

  // The valid ones.
  result(cPay, "paid", { amount: 8500, currency: "USD" });
  result(cTrusted, "on_account", { amount: 10000, currency: "USD" }); // he paid part; the rest goes on his account
  result(cPrepaid, "prepaid");
  assert.equal(money(cTrusted), "31000,10000,21000");
  assert.equal(consignmentStatus(cPrepaid), "delivered_prepaid");
  handIn(round, { usd: { 10000: 1, 5000: 1, 2000: 1, 1000: 1, 500: 1 } });
  assert.equal(consignmentStatus(cPay), "closed");
  assert.equal(consignmentStatus(cTrusted), "delivered_on_account");
  assert.equal(consignmentStatus(cPrepaid), "closed");
  assert.equal(missed(round), "");
  assert.equal(health(), "");
});

test("entering a result again replaces it, and the same request twice is one result", () => {
  const customer = newCustomer();
  const { consignmentIds } = file([[customer, 10000n]]);
  const consignment = consignmentIds[0]!;
  const round = roundOut(consignmentIds);
  const cash = () => balances().get(`driver:${round}:USD`) ?? 0n;

  // Typed $60.00 by mistake.
  const first = randomUUID();
  enterResult({ id: first, roundId: round, consignmentId: consignment, outcome: "paid", received: { amount: 6000, currency: "USD" } });
  assert.equal(customerBalance(customer), 4000n);

  // The same request again (a double click, a retry): nothing moves, whatever it says now.
  const entries = entryCount();
  assert.equal(enterResult({ id: first, roundId: round, consignmentId: consignment, outcome: "paid", received: { amount: 9999, currency: "USD" } }), first);
  assert.equal(entryCount(), entries);
  assert.equal(cash(), 6000n);

  // Entered again as $100.00: the old payment is reversed and the new one posted.
  const second = enterResult({ roundId: round, consignmentId: consignment, outcome: "paid", received: { amount: 10000, currency: "USD" } });
  assert.equal(customerBalance(customer), 0n);
  assert.equal(cash(), 10000n);
  assert.equal(money(consignment), "10000,10000,0");
  assert.equal(
    app(`select string_agg(case when voided_at is null then 'current' else 'voided' end || ':' || received_amount, ' ' order by entered_at, received_amount)
         from round_results where consignment_id = ${lit(consignment)};`),
    "voided:6000 current:10000",
  );
  assert.equal(overview(round), "returned,1,1,0,10000,0,10000,0");

  // An id is one stop's result, not any stop's.
  const { consignmentIds: otherIds } = file([[customer, 500n]]);
  app(`select gs_add_round_stop(${lit(round)}, ${lit(otherIds[0]!)}, ${lit(USER)});`);
  refused(() => enterResult({ id: second, roundId: round, consignmentId: otherIds[0]!, outcome: "held" }), /result_id_reused/);
  enterResult({ roundId: round, consignmentId: otherIds[0]!, outcome: "held" });

  // Taken back without a new one: the stop is open again and the money is off the round.
  refused(() => app(`select gs_void_round_result(${lit(second)}, ${lit(USER)}, ' ');`), /reason_required/);
  app(`select gs_void_round_result(${lit(second)}, ${lit(USER)}, 'Entered on the wrong round');`);
  app(`select gs_void_round_result(${lit(second)}, ${lit(USER)}, 'again');`); // already taken back: does nothing
  assert.equal(consignmentStatus(consignment), "on_round");
  assert.equal(customerBalance(customer), 10500n);
  assert.equal(cash(), 0n);
  refused(() => handIn(round), /results_missing/);

  // Results are written by the function and by nothing else.
  refused(() => app(`update round_results set outcome = 'held' where id = ${lit(second)};`), /permission denied/);
  refused(() => app(`delete from round_results where id = ${lit(second)};`), /permission denied/);
  refused(
    () => app(`insert into round_results (id, round_id, consignment_id, outcome, trust_at_time, happened_at, entered_by)
               values (${lit(randomUUID())}, ${lit(round)}, ${lit(consignment)}, 'paid', 'pay_first', now(), ${lit(USER)});`),
    /permission denied/,
  );
  assert.equal(health(), "");
});

test("a payment on a round pays that consignment first, then the oldest", () => {
  const customer = newCustomer("Two files");
  // An older file he has not been delivered yet, and today's.
  const older = file([[customer, 4000n]], new Date("2026-10-20T05:00:00Z"));
  const today = file([[customer, 8500n]], new Date("2026-11-03T05:00:00Z"));
  const cOlder = older.consignmentIds[0]!;
  const cToday = today.consignmentIds[0]!;

  // The driver delivers today's goods and is handed $100.00 for them.
  const round = roundOut([cToday]);
  const result = enterResult({ roundId: round, consignmentId: cToday, outcome: "paid", received: { amount: 10000, currency: "USD" } });

  // Today's consignment is paid in full; the extra $15.00 goes to the older one.
  assert.equal(money(cToday), "8500,8500,0");
  assert.equal(money(cOlder), "4000,1500,2500");
  assert.equal(missed(round), "");
  const payment = app(`select payment_entry_id from round_results where id = ${lit(result)};`);
  assert.equal(
    app(`select string_agg(amount_usd_cents::text, ',' order by id) from allocations where entry_id = ${lit(payment)};`),
    "8500,1500",
  );

  // Money paid at the office still goes to the oldest first.
  post(officePayment({ customerId: customer, received: usd(1000) }), DAY);
  assert.equal(money(cOlder), "4000,2500,1500");

  // A payment can only be made for a consignment of the customer it credits.
  const stranger = newCustomer("Stranger");
  refused(
    () => app(`select gs_post_entry('office_payment', now(), ${lit(USER)}, ${lit(randomUUID())}, jsonb_build_array(
                 jsonb_build_object('account_id', gs_account('vault_usd'), 'currency', 'USD', 'amount', 100),
                 jsonb_build_object('account_id', gs_customer_account(${lit(stranger)}), 'currency', 'USD', 'amount', -100)),
               null, null, null, ${lit(cOlder)});`),
    /target_invalid/,
  );
  assert.equal(health(), "");
});

test("dinars collected on a round convert at that day's rate", () => {
  const customer = newCustomer("Sixty-two dollars");
  const { consignmentIds } = file([[customer, 6200n]]);
  const consignment = consignmentIds[0]!;
  const round = roundOut(consignmentIds);
  const entries = entryCount();

  // No rate for that day yet: nothing is posted.
  refused(
    () => enterResult({ roundId: round, consignmentId: consignment, outcome: "paid", received: { amount: 91000, currency: "IQD" }, at: NO_RATE_DAY }),
    /rate_missing/,
  );
  assert.equal(entryCount(), entries);

  // $62.00 at 1,470 is 91,140 IQD. He hands over 90,000: more than 500 dinars short, so it is worth what it converts to.
  const short = enterResult({ roundId: round, consignmentId: consignment, outcome: "paid", received: { amount: 90000, currency: "IQD" }, at: NEXT_DAY });
  assert.equal(
    app(`select iqd_per_100_usd || ',' || credited_usd_cents from round_results where id = ${lit(short)};`),
    `147000,${iqdToUsdCents(90000n, 147000)}`,
  );
  assert.equal(money(consignment), "6200,6122,78");
  assert.equal(missed(round), "Sixty-two dollars:78");

  // He hands over 91,000, which is $61.90: the nearest thousand to what he owes. The CEO's rule: that settles it.
  const rounding = BigInt(app("select balance from account_overview where code = 'dinar_rounding_usd';"));
  const result = enterResult({ roundId: round, consignmentId: consignment, outcome: "paid", received: { amount: 91000, currency: "IQD" }, at: NEXT_DAY });
  assert.equal(iqdToUsdCents(91000n, 147000), 6190n);
  assert.equal(app(`select iqd_per_100_usd || ',' || credited_usd_cents from round_results where id = ${lit(result)};`), "147000,6200");
  assert.equal(money(consignment), "6200,6200,0");
  assert.equal(missed(round), "", "nothing is left owed, so nobody forgot to collect");
  assert.equal(BigInt(app("select balance from account_overview where code = 'dinar_rounding_usd';")) - rounding, 10n, "rounding took the 10 cents");
  // Every dinar he handed over is the driver's to hand in.
  assert.equal(app(`select collected from round_cash where round_id = ${lit(round)} and currency = 'IQD';`), "91000");

  // The database and the app convert the same way, to the cent.
  let seed = 4711;
  const next = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) >>> 12) % n; // the high bits are the random ones
  const cases = Array.from({ length: 200 }, () => [BigInt((next(400000) + 1) * 250), 100000 + next(90000)] as const);
  const fromDatabase = app(cases.map(([dinars, rate]) => `select gs_iqd_to_usd_cents(${dinars}, ${rate});`).join("\n")).split("\n");
  cases.forEach(([dinars, rate], i) => assert.equal(fromDatabase[i], iqdToUsdCents(dinars, rate).toString(), `${dinars} IQD at ${rate}`));
});

test("a wallet payment at the door goes to the wallet, not the driver's cash", () => {
  const customer = newCustomer();
  const { consignmentIds, shipmentId } = file([[customer, 8500n]]);
  const round = roundOut(consignmentIds);
  const before = balances();
  const result = enterResult({ roundId: round, consignmentId: consignmentIds[0]!, outcome: "paid", received: { amount: 8500, currency: "USD", method: "fib" } });

  const after = balances();
  assert.equal((after.get("wallet_fib_usd") ?? 0n) - (before.get("wallet_fib_usd") ?? 0n), 8500n);
  assert.equal(after.get(`driver:${round}:USD`) ?? 0n, 0n);
  assert.equal(overview(round), "returned,1,1,0,0,0,0,0");

  // Its payment is undone by changing the result, not behind its back.
  const payment = app(`select payment_entry_id from round_results where id = ${lit(result)};`);
  refused(() => app(`select gs_reverse_entry(${lit(payment)}, ${lit(USER)}, 'oops', ${lit(randomUUID())});`), /round_money_needs_round/);

  // Nothing to count, so nothing to explain.
  handIn(round);
  assert.equal(consignmentStatus(consignmentIds[0]!), "closed");
  assert.equal(shipmentStatus(shipmentId), "closed");
});

test("a hand-in is counted note by note; a gap needs a note and stays on the round", () => {
  const a = newCustomer("A");
  const b = newCustomer("B");
  const { consignmentIds } = file([[a, 20000n], [b, 5000n]]);
  const [cA, cB] = consignmentIds as [string, string];
  const round = roundOut(consignmentIds);
  enterResult({ roundId: round, consignmentId: cA, outcome: "paid", received: { amount: 20000, currency: "USD" }, at: DAY });
  refused(() => handIn(round, { usd: { 10000: 2 } }), /results_missing/);
  enterResult({ roundId: round, consignmentId: cB, outcome: "paid", received: { amount: 72500, currency: "IQD" }, at: DAY });
  const before = balances();
  const entries = entryCount();

  // A typo cannot become money.
  refused(() => handIn(round, { usd: { 10000: 2 }, iqd: { 300: 1 } }), /note_unknown/);
  refused(() => handIn(round, { usd: { 250: 1 } }), /note_unknown/); // 250 is a dinar note
  refused(() => app(`select gs_hand_in_round(${lit(randomUUID())}, ${lit(round)}, ${lit(USER)}, now(), '{"10000": 1.5}', null);`), /notes_invalid/);
  refused(() => app(`select gs_hand_in_round(${lit(randomUUID())}, ${lit(round)}, ${lit(USER)}, now(), '{"10000": -2}', null);`), /notes_invalid/);
  refused(() => app(`select gs_hand_in_round(${lit(randomUUID())}, ${lit(round)}, ${lit(USER)}, now(), '[2]', null);`), /notes_invalid/);

  // $150.00 counted against $200.00 on the receipts: he has to say why.
  const short = { usd: { 10000: 1, 5000: 1 }, iqd: { 50000: 1, 10000: 2, 1000: 2, 500: 1 } };
  refused(() => handIn(round, short), /gap_note_required/);
  refused(() => handIn(round, { ...short, note: "  " }), /gap_note_required/);
  assert.equal(entryCount(), entries);

  const first = randomUUID();
  handIn(round, { ...short, note: "Driver says a $50 note is at home", id: first });
  handIn(round, { ...short, note: "Driver says a $50 note is at home", id: first }); // the same request again
  const after = balances();
  assert.equal((after.get("vault_usd") ?? 0n) - (before.get("vault_usd") ?? 0n), 15000n);
  assert.equal((after.get("vault_iqd") ?? 0n) - (before.get("vault_iqd") ?? 0n), 72500n);
  // Only what was counted moved. The $50.00 is still on the round.
  assert.equal(overview(round), "handed_in,2,2,0,20000,72500,5000,0");
  assert.equal(
    app(`select counted || '/' || expected || '/' || difference from cash_counts where round_hand_in_id = ${lit(first)} and currency = 'USD';`),
    "15000/20000/-5000",
  );
  assert.equal(app(`select count(*) from round_hand_ins where round_id = ${lit(round)};`), "1");

  // He brings the $50.00 the next day.
  handIn(round, { usd: { 5000: 1 }, at: NEXT_DAY });
  assert.equal(overview(round), "handed_in,2,2,0,20000,72500,0,0");
  refused(() => handIn(round, { at: NEXT_DAY }), /nothing_counted/);

  // A count cannot be edited afterwards.
  refused(() => owner(`update cash_counts set counted = 1 where round_hand_in_id = ${lit(first)};`), /ledger_immutable/);
  assert.equal(health(), "");
});

test("round money is posted by the round and by nothing else", () => {
  const customer = newCustomer();
  const { consignmentIds } = file([[customer, 10000n]]);
  const round = roundOut(consignmentIds);
  const result = enterResult({ roundId: round, consignmentId: consignmentIds[0]!, outcome: "paid", received: { amount: 10000, currency: "USD" } });
  const handInId = handIn(round, { usd: { 10000: 1 } });
  const collection = app(`select payment_entry_id from round_results where id = ${lit(result)};`);
  const handInEntry = app(`select entry_id from round_hand_ins where id = ${lit(handInId)};`);

  refused(() => post(driverCollected({ roundId: round, customerId: customer, received: usd(100) })), /round_money_needs_round/);
  refused(() => post(roundHandedIn({ roundId: round, countedUsdCents: 100n, countedIqd: 0n })), /round_money_needs_round/);
  refused(() => app(`select gs_reverse_entry(${lit(collection)}, ${lit(USER)}, 'oops', ${lit(randomUUID())});`), /round_money_needs_round/);
  refused(() => app(`select gs_reverse_entry(${lit(handInEntry)}, ${lit(USER)}, 'oops', ${lit(randomUUID())});`), /round_money_needs_round/);
  // A round's cash account belongs to a real round.
  refused(() => app(`select gs_driver_cash_account(${lit(randomUUID())}, 'USD');`), /accounts_round_fk/);
  refused(() => app(`select gs_refresh_customer(${lit(customer)});`), /permission denied/);
  refused(() => app(`select gs_void_result_inner(${lit(result)}, ${lit(USER)}, 'x');`), /permission denied/);
});

test("a hand-in counted wrong is taken back whole", () => {
  const customer = newCustomer();
  const { consignmentIds, shipmentId } = file([[customer, 10000n]]);
  const consignment = consignmentIds[0]!;
  const round = roundOut(consignmentIds);
  enterResult({ roundId: round, consignmentId: consignment, outcome: "paid", received: { amount: 10000, currency: "USD" } });
  const before = balances().get("vault_usd") ?? 0n;
  const vault = () => (balances().get("vault_usd") ?? 0n) - before;

  // He typed one $100 note as two.
  const wrong = handIn(round, { usd: { 10000: 2 }, note: "Counted twice" });
  assert.equal(vault(), 20000n);
  assert.equal(overview(round), "handed_in,1,1,0,10000,0,-10000,0");
  assert.equal(consignmentStatus(consignment), "closed");

  refused(() => app(`select gs_void_hand_in(${lit(wrong)}, ${lit(USER)}, '');`), /reason_required/);
  app(`select gs_void_hand_in(${lit(wrong)}, ${lit(USER)}, 'Typed 2 notes, there was 1');`);
  app(`select gs_void_hand_in(${lit(wrong)}, ${lit(USER)}, 'again');`); // already taken back: does nothing
  assert.equal(vault(), 0n);
  assert.equal(overview(round), "returned,1,1,0,10000,0,10000,0");
  assert.equal(consignmentStatus(consignment), "delivered_paid");
  assert.equal(shipmentStatus(shipmentId), "reconciling");

  handIn(round, { usd: { 10000: 1 } });
  assert.equal(vault(), 10000n);
  assert.equal(overview(round), "handed_in,1,1,0,10000,0,0,0");
  assert.equal(shipmentStatus(shipmentId), "closed");
  assert.equal(health(), "");
});

test("the driver forgot to collect, unless the CEO allowed it", () => {
  const hemn = newCustomer("Hemn S.");
  const partial = newCustomer("Paid part");
  const dara = newCustomer("Dara M.");
  const zana = newCustomer("Zana T.");
  const prepaidCustomer = newCustomer("Prepaid");
  makeTrusted(dara);
  makeTrusted(zana);
  const { consignmentIds, shipmentId } = file([[hemn, 6200n], [partial, 8500n], [dara, 31000n], [zana, 20000n], [prepaidCustomer, 0n]]);
  const [cHemn, cPartial, cDara, cZana, cPrepaid] = consignmentIds as [string, string, string, string, string];
  const round = roundOut(consignmentIds);

  enterResult({ roundId: round, consignmentId: cHemn, outcome: "unpaid" });
  enterResult({ roundId: round, consignmentId: cPartial, outcome: "paid", received: { amount: 5000, currency: "USD" } });
  enterResult({ roundId: round, consignmentId: cDara, outcome: "on_account" });
  // Zana is trusted and paid $50.00 of his $200.00. Entered as "paid", but he still owes.
  enterResult({ roundId: round, consignmentId: cZana, outcome: "paid", received: { amount: 5000, currency: "USD" } });
  enterResult({ roundId: round, consignmentId: cPrepaid, outcome: "prepaid" });

  // Both pay-first customers are listed with what is missing. The trusted ones never are.
  assert.equal(missed(round), "Hemn S.:6200 Paid part:3500");
  assert.equal(overview(round), "returned,5,5,2,10000,0,10000,0");
  // The status follows what is owed, not the word that was picked.
  assert.equal(consignmentStatus(cPartial), "delivered_not_paid");
  assert.equal(consignmentStatus(cZana), "delivered_on_account");

  // The CEO had said Hemn could take his goods. It needs a reason, once.
  refused(() => app(`insert into exceptions (consignment_id, approved_by, reason) values (${lit(cHemn)}, ${lit(USER)}, ' ');`), /exceptions_reason_not_blank/);
  refused(() => app(`insert into exceptions (consignment_id, approved_by, reason) values (${lit(cPrepaid)}, ${lit(USER)}, 'x');`), /exception_not_needed/);
  app(`insert into exceptions (consignment_id, approved_by, reason) values (${lit(cHemn)}, ${lit(USER)}, 'Pays on Thursday, CEO agreed by phone');`);
  refused(() => app(`insert into exceptions (consignment_id, approved_by, reason) values (${lit(cHemn)}, ${lit(USER)}, 'again');`), /exceptions_consignment_id_key/);
  refused(() => app(`delete from exceptions where consignment_id = ${lit(cHemn)};`), /permission denied/);
  assert.equal(missed(round), "Paid part:3500");

  // He is chased until he pays.
  const chase = () => app(`select string_agg(customer_name || ':' || remaining_usd_cents, ' ') from chase_list where customer_id = ${lit(hemn)};`);
  assert.equal(chase(), "Hemn S.:6200");
  handIn(round, { usd: { 10000: 1 } });
  assert.equal(shipmentStatus(shipmentId), "reconciling");
  post(officePayment({ customerId: hemn, received: usd(6200) }), NEXT_DAY);
  assert.equal(chase(), "");
  assert.equal(consignmentStatus(cHemn), "closed");

  // The other one pays the rest at the office and drops off the list; the file closes.
  post(officePayment({ customerId: partial, received: usd(3500) }), NEXT_DAY);
  assert.equal(missed(round), "");
  assert.equal(shipmentStatus(shipmentId), "closed");
  assert.equal(health(), "");
});

test("goods held in the car go out again on the next round", () => {
  const customer = newCustomer("Shvan K.");
  const { consignmentIds, shipmentId } = file([[customer, 4000n]]);
  const consignment = consignmentIds[0]!;
  const held = () => app(`select round_id || ',' || (held_since at time zone 'Asia/Baghdad')::date from held_in_car where consignment_id = ${lit(consignment)};`);

  const first = roundOut(consignmentIds);
  enterResult({ roundId: first, consignmentId: consignment, outcome: "held", at: DAY });
  handIn(first);
  assert.equal(consignmentStatus(consignment), "held");
  assert.equal(shipmentStatus(shipmentId), "on_rounds");
  assert.equal(held(), `${first},2026-11-03`);

  const second = roundOut(consignmentIds, new Date("2026-11-04T06:00:00Z"));
  assert.equal(consignmentStatus(consignment), "on_round");
  assert.equal(app(`select status_before from round_stops where round_id = ${lit(second)};`), "held");
  enterResult({ roundId: second, consignmentId: consignment, outcome: "paid", received: { amount: 4000, currency: "USD" }, at: NEXT_DAY });
  assert.equal(consignmentStatus(consignment), "delivered_paid");
  handIn(second, { usd: { 2000: 2 }, at: NEXT_DAY });
  assert.equal(consignmentStatus(consignment), "closed");
  assert.equal(shipmentStatus(shipmentId), "closed");
  assert.equal(held(), "");
  assert.equal(health(), "");
});

test("a file closes by itself, and opens again when the facts change", () => {
  const payFirst = newCustomer("Pay first");
  const trusted = newCustomer("Trusted");
  const prepaidCustomer = newCustomer("Prepaid");
  makeTrusted(trusted);
  const { consignmentIds, shipmentId } = file([[payFirst, 8500n], [trusted, 31000n], [prepaidCustomer, 0n]]);
  const [cPay, cTrusted, cPrepaid] = consignmentIds as [string, string, string];
  assert.equal(shipmentStatus(shipmentId), "confirmed");

  const round = roundOut(consignmentIds);
  assert.equal(shipmentStatus(shipmentId), "on_rounds");

  enterResult({ roundId: round, consignmentId: cPay, outcome: "paid", received: { amount: 8500, currency: "USD" } });
  enterResult({ roundId: round, consignmentId: cPrepaid, outcome: "prepaid" });
  assert.equal(shipmentStatus(shipmentId), "on_rounds"); // one stop still to enter
  enterResult({ roundId: round, consignmentId: cTrusted, outcome: "on_account" });
  // Every customer has his goods, but the driver's cash is not counted in yet.
  assert.equal(shipmentStatus(shipmentId), "reconciling");

  const handInId = handIn(round, { usd: { 5000: 1, 2000: 1, 1000: 1, 500: 1 } });
  // Paid, prepaid, and on account to a trusted customer: this is his CHECKED folder.
  assert.equal(shipmentStatus(shipmentId), "closed");
  assert.equal([cPay, cTrusted, cPrepaid].map(consignmentStatus).join(","), "closed,delivered_on_account,closed");

  // The trusted customer pays later: his consignment closes, the file stays closed.
  const payment = post(officePayment({ customerId: trusted, received: usd(31000) }), NEXT_DAY);
  assert.equal(consignmentStatus(cTrusted), "closed");
  // That payment was a mistake: he owes again, and the consignment says so.
  app(`select gs_reverse_entry(${lit(payment)}, ${lit(USER)}, 'Wrong customer', ${lit(randomUUID())});`);
  assert.equal(consignmentStatus(cTrusted), "delivered_on_account");
  assert.equal(shipmentStatus(shipmentId), "closed");

  // A dispute waiting on China keeps the file open until China answers.
  const dispute = randomUUID();
  app(`insert into disputes (id, consignment_id, kind, note, created_by) values (${lit(dispute)}, ${lit(cPay)}, 'damaged', 'Two cartons crushed', ${lit(USER)});`);
  assert.equal(shipmentStatus(shipmentId), "reconciling");
  app(`update disputes set status = 'sent_to_china', sent_to_china_at = now() where id = ${lit(dispute)};`);
  assert.equal(shipmentStatus(shipmentId), "reconciling");
  app(`update disputes set status = 'answered', china_answer = 'Refund on the next file', answered_at = now() where id = ${lit(dispute)};`);
  assert.equal(shipmentStatus(shipmentId), "closed");

  // The hand-in is taken back: the money is not in the vault, so the file is not done.
  app(`select gs_void_hand_in(${lit(handInId)}, ${lit(USER)}, 'Counted the wrong round');`);
  assert.equal(shipmentStatus(shipmentId), "reconciling");
  assert.equal([cPay, cTrusted, cPrepaid].map(consignmentStatus).join(","), "delivered_paid,delivered_on_account,delivered_prepaid");
  assert.equal(health(), "");
});

test("a consignment fixed while it is on a round keeps its stop, its result and its payment", () => {
  const customer = newCustomer();
  // An older file of his is still unpaid, so it matters which consignment the driver's money was for.
  const older = file([[customer, 4000n]], new Date("2026-10-20T05:00:00Z")).consignmentIds[0]!;
  const { consignmentIds, shipmentId } = file([[customer, 8500n]]);
  const wrong = consignmentIds[0]!;
  const round = roundOut(consignmentIds);
  app(`insert into attachments (consignment_id, round_id, kind, storage_key, uploaded_by) values (${lit(wrong)}, ${lit(round)}, 'payment_receipt', ${lit(`receipts/${wrong}.jpg`)}, ${lit(USER)});`);
  enterResult({ roundId: round, consignmentId: wrong, outcome: "paid", received: { amount: 8500, currency: "USD" } });

  refused(() => app(`select gs_correct_consignment(${lit(wrong)}, 0, 0, ${lit(USER)}, 'Was prepaid after all');`), /correction_invalid/);

  // The file should have said $58.00. He paid $85.00 at the door for these goods: they are paid,
  // and the $27.00 over goes to his older file.
  const fixed = app(`select gs_correct_consignment(${lit(wrong)}, 5800, 0, ${lit(USER)}, 'China confirmed 58');`);
  assert.equal(consignmentStatus(wrong), "cancelled");
  assert.equal(money(fixed), "5800,5800,0");
  assert.equal(money(older), "4000,2700,1300");
  assert.equal(customerBalance(customer), 1300n);
  assert.equal(
    app(`select consignment_id || ',' || outcome || ',' || has_payment_receipt from round_stop_details where round_id = ${lit(round)};`),
    `${fixed},paid,true`,
  );
  assert.equal(consignmentStatus(fixed), "delivered_paid");
  handIn(round, { usd: { 5000: 1, 2000: 1, 1000: 1, 500: 1 } });
  assert.equal(consignmentStatus(fixed), "closed");
  assert.equal(shipmentStatus(shipmentId), "closed");

  // A consignment cancelled while it is out does not hold the round up.
  const other = file([[customer, 3000n]]);
  const second = roundOut(other.consignmentIds);
  app(`select gs_cancel_consignment(${lit(other.consignmentIds[0]!)}, ${lit(USER)}, 'Goods never arrived');`);
  refused(() => enterResult({ roundId: second, consignmentId: other.consignmentIds[0]!, outcome: "held" }), /consignment_cancelled/);
  app(`select gs_round_return(${lit(second)}, ${lit(USER)});`);
  handIn(second);
  assert.equal(overview(second), "handed_in,0,0,0,0,0,0,0");
  assert.equal(health(), "");
});

test("random rounds keep every customer, every round and every file straight", () => {
  let seed = 20261103;
  const next = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) >>> 12) % n; // the high bits are the random ones
  const pick = <T>(items: readonly T[]): T => items[next(items.length)]!;

  const days = [
    { at: new Date("2026-11-05T09:00:00Z"), day: "2026-11-05", rate: 147250 },
    { at: new Date("2026-11-06T09:00:00Z"), day: "2026-11-06", rate: 152750 },
    { at: new Date("2026-11-07T09:00:00Z"), day: "2026-11-07", rate: 131000 },
  ];
  for (const d of days) setRate(d.day, d.rate);

  const customers = Array.from({ length: 6 }, (_, i) => ({ id: newCustomer(`Random ${i}`), trusted: i % 3 === 0 }));
  for (const c of customers) if (c.trusted) makeTrusted(c.id);
  const trustedIds = new Set(customers.filter((c) => c.trusted).map((c) => c.id));

  const expectedBalance = new Map<string, bigint>(customers.map((c) => [c.id, 0n]));
  const bump = (customer: string, by: bigint) => expectedBalance.set(customer, (expectedBalance.get(customer) ?? 0n) + by);
  const start = balances();
  let vaultUsd = 0n;
  let vaultIqd = 0n;
  let walletUsd = 0n;
  let roundsDone = 0;
  let resultsEntered = 0;

  /** Consignments waiting for a round: new ones, and ones held in the car. */
  let waiting: { id: string; customer: string; cents: bigint }[] = [];
  let clock = Date.parse("2026-11-05T04:00:00Z");

  for (let step = 0; step < 14; step++) {
    // Two or three files arrive.
    for (let f = 0; f < 2 + next(2); f++) {
      const chosen = customers.filter(() => next(2) === 0);
      if (chosen.length === 0) continue;
      const rows = chosen.map((c) => [c.id, BigInt(next(5) === 0 ? 0 : (next(400) + 1) * 100)] as const);
      clock += 60_000;
      const made = file(rows, new Date(clock));
      rows.forEach(([customer, cents], i) => {
        waiting.push({ id: made.consignmentIds[i]!, customer, cents });
        bump(customer, cents);
      });
    }
    if (waiting.length === 0) continue;

    // One round takes some of what is waiting.
    const onRound = waiting.filter(() => next(3) !== 0);
    if (onRound.length === 0) continue;
    waiting = waiting.filter((w) => !onRound.includes(w));
    const round = roundOut(onRound.map((w) => w.id));
    const day = pick(days);
    let cashUsd = 0n;
    let cashIqd = 0n;

    const enter = (stop: (typeof onRound)[number], replaces: { usd: bigint; iqd: bigint; wallet: bigint; credit: bigint } | null) => {
      // Take back what an earlier result on this stop had posted.
      if (replaces) {
        cashUsd -= replaces.usd;
        cashIqd -= replaces.iqd;
        walletUsd -= replaces.wallet;
        bump(stop.customer, replaces.credit);
      }
      const posted = { usd: 0n, iqd: 0n, wallet: 0n, credit: 0n };
      const trusted = trustedIds.has(stop.customer);
      let outcome: "paid" | "on_account" | "prepaid" | "held" | "unpaid";
      let received: { amount: bigint; currency: "USD" | "IQD"; method?: "driver_cash" | "fib" } | undefined;
      if (stop.cents === 0n) {
        outcome = next(4) === 0 ? "held" : "prepaid";
      } else {
        const roll = next(10);
        if (roll === 0) outcome = "held";
        else if (roll <= 2) outcome = trusted ? "on_account" : "unpaid";
        else outcome = "paid";
        const pays = outcome === "paid" || (outcome !== "held" && next(2) === 0);
        if (pays) {
          const how = next(3);
          if (how === 0) {
            const dinars = BigInt((next(600) + 1) * 250);
            received = { amount: dinars, currency: "IQD" };
            posted.iqd = dinars;
            posted.credit = iqdToUsdCents(dinars, day.rate);
          } else {
            const cents = outcome === "paid" && next(3) !== 0 ? stop.cents : BigInt((next(400) + 1) * 100);
            received = { amount: cents, currency: "USD", ...(how === 1 ? { method: "fib" as const } : {}) };
            if (how === 1) posted.wallet = cents;
            else posted.usd = cents;
            posted.credit = cents;
          }
        }
      }
      enterResult({ roundId: round, consignmentId: stop.id, outcome, ...(received ? { received } : {}), at: day.at });
      resultsEntered += 1;
      cashUsd += posted.usd;
      cashIqd += posted.iqd;
      walletUsd += posted.wallet;
      bump(stop.customer, -posted.credit);
      return { outcome, posted };
    };

    for (const stop of onRound) {
      let { outcome, posted } = enter(stop, null);
      // Now and then a result is entered again.
      if (next(4) === 0) ({ outcome, posted } = enter(stop, posted));
      if (outcome === "held") waiting.push(stop);
    }

    // The cash is counted in: usually all of it, sometimes short with a note.
    const shortUsd = cashUsd >= 10000n && next(4) === 0 ? 5000n : 0n;
    handIn(round, {
      usd: notesFor("USD", cashUsd - shortUsd),
      iqd: notesFor("IQD", cashIqd),
      at: day.at,
      ...(shortUsd > 0n ? { note: "Random test: one $50 note missing" } : {}),
    });
    vaultUsd += cashUsd - shortUsd;
    vaultIqd += cashIqd;
    roundsDone += 1;
    assert.equal(
      app(`select gap_usd_cents || ',' || gap_iqd from round_overview where round_id = ${lit(round)};`),
      `${shortUsd},0`,
    );

    // Sometimes a customer pays what he owes at the office.
    if (next(2) === 0) {
      const customer = pick(customers).id;
      const cents = BigInt((next(300) + 1) * 100);
      post(officePayment({ customerId: customer, received: usd(cents) }), day.at);
      bump(customer, -cents);
      vaultUsd += cents;
    }
  }

  assert.ok(roundsDone >= 10 && resultsEntered >= 60, `expected a real run, got ${roundsDone} rounds and ${resultsEntered} results`);
  for (const c of customers) assert.equal(customerBalance(c.id), expectedBalance.get(c.id), `balance of ${c.id}`);
  const end = balances();
  const delta = (key: string) => (end.get(key) ?? 0n) - (start.get(key) ?? 0n);
  assert.equal(delta("vault_usd"), vaultUsd);
  assert.equal(delta("vault_iqd"), vaultIqd);
  assert.equal(delta("wallet_fib_usd"), walletUsd);
  // Every status is what the facts say, every collection has its result, every hand-in its count.
  assert.equal(health(), "");
});
