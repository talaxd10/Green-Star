// Outside the ledger, the same rule as inside it: only the CEO changes
// anything, under his own name, and every change is on record.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lit } from "../src/index.ts";
import {
  USER,
  app,
  appAs,
  appNoActor,
  charge,
  confirmSql,
  customerBalance,
  draftShipmentSql,
  enterResult,
  handIn,
  health,
  newCeo,
  newCustomer,
  newDriver,
  newRound,
  owner,
  refused,
  resultSql,
  retire,
  roundOut,
  switchedOff,
} from "./helpers.ts";

let n = 0;
const phone = () => `+96478${(20000000 + ++n).toString()}`;

/**
 * One statement for every table and function a person can change through, as
 * `who` would send it. Each one is set up so that it would go through for a CEO.
 */
function everyChange(who: string): Record<string, string> {
  const customer = newCustomer();
  const other = newCustomer();
  const driver = newDriver();
  const shipment = randomUUID();
  const draft = randomUUID();
  app(draftShipmentSql(draft, [[customer, 4000n]]));
  const prepaidDraft = randomUUID();
  app(draftShipmentSql(prepaidDraft, [[customer, 0n]]));
  const { consignmentId } = charge(customer, 6000n);
  const round = roundOut([consignmentId]);                       // out, waiting for its result
  const { consignmentId: held } = charge(other, 2000n);
  const back = roundOut([held]);                                 // back, every stop has its result
  enterResult({ roundId: back, consignmentId: held, outcome: "held" });
  const { consignmentId: free } = charge(other, 1000n);
  const { consignmentId: loaded } = charge(other, 1500n);
  const planned = newRound([loaded], driver);                    // planned, with goods on it
  // A pay-first customer who got his goods and paid nothing: an alert waiting to be resolved.
  const { consignmentId: unpaid } = charge(other, 700n);
  const forgot = roundOut([unpaid]);
  enterResult({ roundId: forgot, consignmentId: unpaid, outcome: "unpaid" });
  app("select gs_sync_alerts();");
  const alert = app(`select id from alerts where kind = 'missed_collection' and subject = ${lit(unpaid)} and status = 'open';`);
  // A statement made and not yet sent.
  const statement = randomUUID();
  const balanceNow = `jsonb_build_object('balanceUsdCents', coalesce((select balance_usd_cents from customer_balances where customer_id = ${lit(customer)}), 0))`;
  app(`select gs_record_statement(${lit(statement)}, ${lit(customer)}, ${lit(USER)}, null, ${balanceNow}, 'You owe $60.00.');`);
  const u = lit(who);
  return {
    "add a customer": `insert into customers (display_name) values ('Someone');`,
    "rename a customer": `update customers set display_name = 'Renamed' where id = ${lit(customer)};`,
    "add a phone": `insert into customer_phones (customer_id, phone) values (${lit(customer)}, ${lit(phone())});`,
    "add a mark": `insert into customer_marks (customer_id, mark) values (${lit(customer)}, ${lit(`MARK ${++n}`)});`,
    "add a name as written": `insert into customer_aliases (customer_id, alias) values (${lit(customer)}, 'As written');`,
    "change trust": `select gs_set_customer_trust(${lit(customer)}, 'trusted', 50000, ${u}, 'China office');`,
    "merge customers": `select gs_merge_customer(${lit(newCustomer())}, ${lit(customer)});`,
    "add a driver": `insert into drivers (name) values ('Driver');`,
    "add a carrier": `insert into carriers (name, kind) values ('Office', 'transport_office');`,
    "record a file": `insert into source_files (filename, storage_key, sha256, uploaded_by) values ('f.xlsx', ${lit(`files/${++n}`)}, ${lit(randomUUID().replaceAll("-", "").padEnd(64, "0"))}, ${u});`,
    "start a draft file": `insert into shipments (id, code) values (${lit(shipment)}, ${lit(`GSSK-W${++n}`)});`,
    "add to a draft file": `insert into consignments (shipment_id, customer_id, amount_due_usd_cents) values (${lit(draft)}, ${lit(other)}, 1000);`,
    "confirm a file": `select gs_confirm_shipment(${lit(draft)}, ${u}, now());`,
    "confirm a prepaid file": `select gs_confirm_shipment(${lit(prepaidDraft)}, ${u}, now());`,   // posts no money at all
    "add a user": `insert into users (name, role, phone, created_by) values ('Added', 'ceo', ${lit(phone())}, ${u});`,
    "open a dispute": `insert into disputes (consignment_id, kind, created_by) values (${lit(consignmentId)}, 'damaged', ${u});`,
    "allow an exception": `insert into exceptions (consignment_id, approved_by, reason) values (${lit(consignmentId)}, ${u}, 'ok');`,
    "create a round": `insert into rounds (driver_id, created_by) values (${lit(driver)}, ${u});`,
    "put goods on a round": `select gs_add_round_stop(${lit(planned)}, ${lit(free)}, ${u});`,
    "take goods off a round": `select gs_remove_round_stop(${lit(planned)}, ${lit(loaded)}, ${u});`,
    "send a round out": `select gs_round_depart(${lit(planned)}, ${u});`,
    "enter a result with money": resultSql({ roundId: round, consignmentId, outcome: "paid", received: { amount: 6000, currency: "USD" } }).replace(lit(USER), u),
    "enter a result without money": resultSql({ roundId: round, consignmentId, outcome: "held" }).replace(lit(USER), u),
    "hand in a round": `select gs_hand_in_round(${lit(randomUUID())}, ${lit(back)}, ${u}, now(), null, null, null);`,
    "attach a receipt": `insert into attachments (consignment_id, kind, storage_key, uploaded_by) values (${lit(consignmentId)}, 'payment_receipt', ${lit(`r/${++n}`)}, ${u});`,
    "set the rate": `select gs_set_rate('2031-01-0${(n % 9) + 1}', ${145000 + ++n}, ${u}, true);`,
    // Later than any close another test makes, so the order of the test files does not matter.
    "close the vault": `select gs_close_vault(${lit(randomUUID())}, ${u}, '2040-01-01T00:00:00Z'::timestamptz + interval '${++n} seconds', null, null, 'count');`,
    "cancel a consignment": `select gs_cancel_consignment(${lit(free)}, ${u}, 'wrong');`,
    "change a setting": `update settings set wallet_check_days = 7;`,
    "check a wallet": `select gs_check_wallet(${lit(randomUUID())}, 'wallet_fastpay_usd', ${u}, 0, now(), 'read it in the app');`,
    "resolve an alert": `select gs_resolve_alert(${lit(alert)}, ${u}, 'spoke to the driver');`,
    "make a statement": `select gs_record_statement(${lit(randomUUID())}, ${lit(customer)}, ${u}, null, ${balanceNow}, 'You owe $60.00.');`,
    "mark a statement sent": `select gs_mark_statement_sent(${lit(statement)}, ${u});`,
    "record a request": `insert into api_requests (key, user_id, method, path, request_hash) values (${lit(randomUUID())}, ${u}, 'POST', '/v1/x', sha256('x'));`,
  };
}

/** Like refused(), and says which change was let through. */
function refusedChange(what: string, run: () => unknown, pattern: RegExp): void {
  try {
    refused(run, pattern);
  } catch (error) {
    throw new Error(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Statements that are not about money or goods and so are not the CEO's alone. */
const OPEN_TO_ANY_USER = new Set(["record a request"]);

test("an account that is switched off can change nothing, in the ledger or outside it", () => {
  const before = Number(app("select count(*) from audit_log;"));
  const who = switchedOff();
  const changes = everyChange(who);
  for (const [what, sql] of Object.entries(changes)) {
    if (OPEN_TO_ANY_USER.has(what)) continue;
    refusedChange(what, () => appAs(who)(sql), /actor_unknown/);
    // And not by borrowing the CEO's name.
    refusedChange(what, () => appAs(who)(sql.replaceAll(lit(who), lit(USER))), /actor_unknown/);
  }
  assert.equal(app(`select count(*) from audit_log where actor = ${lit(who)};`), "0", "nothing was done under his name");
  assert.equal(app(`select count(*) from journal_entries where created_by = ${lit(who)};`), "0");
  assert.ok(Number(app("select count(*) from audit_log;")) > before, "setting the scene, as the CEO, was logged");
  assert.equal(health(), "");
});

test("with nobody acting, the application can change nothing", () => {
  const changes = everyChange(USER);
  for (const [what, sql] of Object.entries(changes)) {
    if (OPEN_TO_ANY_USER.has(what)) continue;
    refusedChange(what, () => appNoActor(sql), /actor_required/);
  }
});

test("a row names the CEO who is acting, not another one", () => {
  const second = newCeo();
  // The second CEO is acting, and every statement names the first.
  const changes = everyChange(USER);
  const named = [
    "change trust", "record a file", "confirm a file", "confirm a prepaid file", "add a user", "open a dispute", "allow an exception",
    "create a round", "put goods on a round", "enter a result with money", "enter a result without money",
    "hand in a round", "attach a receipt", "set the rate", "close the vault", "cancel a consignment",
    "check a wallet", "resolve an alert", "make a statement", "mark a statement sent",
  ];
  for (const what of named) {
    refusedChange(what, () => appAs(second)(changes[what] as string), /actor_mismatch/);
  }
  // Under his own name the second CEO can do every change there is.
  const own = everyChange(second);
  for (const [what, sql] of Object.entries(own)) {
    try {
      appAs(second)(sql);
    } catch (error) {
      throw new Error(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Take the far-future close back, so tests that count the vault later are not out of order.
  appAs(second)(`select gs_void_vault_close(id, ${lit(second)}, 'test') from vault_closes where voided_at is null and closed_at >= '2040-01-01';`);
  assert.equal(app("select count(*) from vault_closes where voided_at is null and closed_at >= '2040-01-01';"), "0");
  // And the accounts this test made are switched off again, so one CEO is left for the other tests.
  app("update users set active = false where name = 'Added' and active;");
  retire(second);
  assert.equal(app("select count(*) from users where active;"), "1");
  assert.equal(health(), "");
});

test("every change to a customer is in the audit log with before and after", () => {
  const id = newCustomer("Hemn");
  const p = phone();
  app(`insert into customer_phones (customer_id, phone, is_primary) values (${lit(id)}, ${lit(p)}, true);`);
  app(`update customers set display_name = 'Hemn S.' where id = ${lit(id)};`);
  app(`select gs_set_customer_trust(${lit(id)}, 'trusted', 80000, ${lit(USER)}, 'China office', 'Ships every week');`);
  app(`delete from customer_phones where customer_id = ${lit(id)};`);

  const rows = app(`select entity || '|' || action || '|' || actor || '|' ||
                           coalesce(before ->> 'display_name', before ->> 'phone', '-') || '|' ||
                           coalesce(after ->> 'display_name', after ->> 'phone', '-') || '|' ||
                           coalesce(after ->> 'trust', '')
                    from audit_log
                    where (entity = 'customers' and entity_id = ${lit(id)})
                       or (entity = 'customer_phones' and coalesce(after, before) ->> 'customer_id' = ${lit(id)})
                    order by id;`).split("\n");
  assert.deepEqual(rows, [
    `customers|insert|${USER}|-|Hemn|pay_first`,
    `customer_phones|insert|${USER}|-|${p}|`,
    `customers|update|${USER}|Hemn|Hemn S.|pay_first`,
    `customers|update|${USER}|Hemn S.|Hemn S.|trusted`,
    `customer_phones|delete|${USER}|${p}|-|`,
  ]);
});

test("a status the system works out is not logged as something a person did", () => {
  const customer = newCustomer();
  const { shipmentId, consignmentId } = charge(customer, 5000n);
  const logged = () => app(`select count(*) from audit_log where entity in ('consignments', 'shipments') and entity_id in (${lit(consignmentId)}, ${lit(shipmentId)}) and action = 'update';`);
  // Confirming set the charge and the confirmer: those are a person's doing.
  const afterConfirm = logged();

  const round = roundOut([consignmentId]);
  enterResult({ roundId: round, consignmentId, outcome: "paid", received: { amount: 5000, currency: "USD" } });
  handIn(round, { usd: { 5000: 1 } });
  assert.equal(app(`select status from consignments where id = ${lit(consignmentId)};`), "closed");
  assert.equal(app(`select status from shipments where id = ${lit(shipmentId)};`), "closed");
  assert.equal(logged(), afterConfirm, "listed, on_round, delivered_paid and closed were worked out, not typed");
  assert.equal(app(`select count(*) from audit_log where entity = 'rounds' and entity_id = ${lit(round)} and action = 'update';`), "0",
    "out, returned and handed in were worked out too");

  // Who put the goods on the round is logged.
  assert.equal(app(`select actor from audit_log where entity = 'round_stops' and action = 'insert' and after ->> 'consignment_id' = ${lit(consignmentId)};`), USER);
});

test("a request sent twice is recorded once, and its answer is set once", () => {
  const key = randomUUID();
  const insert = `insert into api_requests (key, user_id, method, path, request_hash) values (${lit(key)}, ${lit(USER)}, 'POST', '/v1/payments', sha256('a'));`;
  app(insert);
  refused(() => app(insert), /api_requests_pkey/);
  assert.equal(app(`insert into api_requests (key, user_id, method, path, request_hash) values (${lit(key)}, ${lit(USER)}, 'POST', '/v1/payments', sha256('a')) on conflict (key) do nothing returning key;`), "");

  app(`update api_requests set status = 201, response = '{"id": 1}' where key = ${lit(key)};`);
  refused(() => app(`update api_requests set status = 200 where key = ${lit(key)};`), /request_locked/);
  refused(() => app(`update api_requests set request_hash = sha256('b') where key = ${lit(key)};`), /permission denied/);
  refused(() => owner(`update api_requests set request_hash = sha256('b') where key = ${lit(key)};`), /request_locked/);
  refused(() => app(`delete from api_requests where key = ${lit(key)};`), /permission denied/);
  refused(() => app(`insert into api_requests (key, user_id, method, path, request_hash) values ('short', ${lit(USER)}, 'POST', '/', sha256('a'));`), /api_requests_key_format/);
  refused(() => app(`insert into api_requests (key, user_id, method, path, request_hash) values (${lit(randomUUID())}, ${lit(USER)}, 'POST', '/', 'abc');`), /api_requests_hash_is_sha256/);
});

test("a duplicate customer is merged into the real one while it has nothing on the books", () => {
  const real = newCustomer("Dara M.");
  const dup = newCustomer("DARA MHAMAD");
  const realPhone = phone();
  const dupPhone = phone();
  app(`insert into customer_phones (customer_id, phone, is_primary) values (${lit(real)}, ${lit(realPhone)}, true), (${lit(dup)}, ${lit(dupPhone)}, true);`);
  app(`insert into customer_marks (customer_id, mark) values (${lit(dup)}, ${lit(`DARA ${++n}`)});`);
  app(`insert into customer_aliases (customer_id, alias) values (${lit(dup)}, 'Dara Mhamad'), (${lit(real)}, 'Dara Mhamad');`);
  const draft = randomUUID();
  app(draftShipmentSql(draft, [[dup, 7000n]]));

  app(`select gs_merge_customer(${lit(dup)}, ${lit(real)});`);

  assert.equal(app(`select merged_into from customers where id = ${lit(dup)};`), real);
  assert.equal(app(`select string_agg(phone || ':' || is_primary, ',' order by is_primary desc) from customer_phones where customer_id = ${lit(real)};`), `${realPhone}:true,${dupPhone}:false`);
  assert.equal(app(`select count(*) from customer_phones where customer_id = ${lit(dup)};`), "0");
  assert.equal(app(`select count(*) from customer_marks where customer_id = ${lit(real)};`), "1");
  assert.equal(app(`select string_agg(alias, ',' order by alias) from customer_aliases where customer_id = ${lit(real)};`), "DARA MHAMAD,Dara Mhamad");
  assert.equal(app(`select customer_id from consignments where shipment_id = ${lit(draft)};`), real);
  // The file's row now finds the real customer by the duplicate's phone.
  assert.equal(app(`select customer_id from gs_match_customer(${lit(dupPhone)}, null);`), real);
  assert.equal(app(`select count(*) from customer_overview where customer_id = ${lit(dup)};`), "0", "a merged customer is no longer listed");

  // The merge is on record under the CEO's name.
  assert.equal(app(`select actor || '|' || (after ->> 'merged_into') from audit_log where entity = 'customers' and entity_id = ${lit(dup)} and action = 'update';`), `${USER}|${real}`);

  app(confirmSql(draft, new Date("2026-10-03T08:00:00Z")));
  assert.equal(customerBalance(real), 7000n);
  assert.equal(health(), "");
});

test("a merged customer is used for nothing afterwards", () => {
  const real = newCustomer("Real");
  const dup = newCustomer("Duplicate");
  app(`select gs_merge_customer(${lit(dup)}, ${lit(real)});`);

  refused(() => app(`insert into customer_phones (customer_id, phone) values (${lit(dup)}, ${lit(phone())});`), /customer_merged/);
  refused(() => app(`insert into customer_marks (customer_id, mark) values (${lit(dup)}, ${lit(`DUP ${++n}`)});`), /customer_merged/);
  refused(() => app(`insert into customer_aliases (customer_id, alias) values (${lit(dup)}, 'x');`), /customer_merged/);
  refused(() => app(draftShipmentSql(randomUUID(), [[dup, 1000n]])), /customer_merged/);
  refused(() => app(`select gs_merge_customer(${lit(dup)}, ${lit(real)});`), /customer_merged/);
  refused(() => app(`select gs_merge_customer(${lit(real)}, ${lit(dup)});`), /customer_merged/);
  refused(() => app(`update customers set merged_into = null where id = ${lit(dup)};`), /permission denied/);
});

test("a customer with goods or money on the books is not merged away", () => {
  const real = newCustomer("Real");
  const charged = newCustomer("Charged");
  charge(charged, 3000n);
  refused(() => app(`select gs_merge_customer(${lit(charged)}, ${lit(real)});`), /merge_has_history/);

  const prepaid = newCustomer("Prepaid only");
  charge(prepaid, 0n);   // on a confirmed file, though nothing was posted
  refused(() => app(`select gs_merge_customer(${lit(prepaid)}, ${lit(real)});`), /merge_has_history/);

  // Both on the same draft file: one of the two rows has to go first.
  const twin = newCustomer("Twin");
  app(draftShipmentSql(randomUUID(), [[twin, 1000n], [real, 2000n]]));
  refused(() => app(`select gs_merge_customer(${lit(twin)}, ${lit(real)});`), /merge_conflict/);

  refused(() => app(`select gs_merge_customer(${lit(real)}, ${lit(real)});`), /merge_invalid/);
  refused(() => app(`select gs_merge_customer(${lit(randomUUID())}, ${lit(real)});`), /customer_not_found/);
  assert.equal(app(`select count(*) from customers where merged_into is not null and id in (${lit(charged)}, ${lit(prepaid)}, ${lit(twin)});`), "0");
  assert.equal(customerBalance(charged), 3000n);
});

test("the files list shows what was expected, what came in and what stops a file closing", () => {
  const trusted = newCustomer("Trusted");
  app(`select gs_set_customer_trust(${lit(trusted)}, 'trusted', null, ${lit(USER)}, 'China office');`);
  const payFirst = newCustomer("Pay first");
  const waiting = newCustomer("Still in the car");
  const shipment = randomUUID();
  const [cTrusted, cPay, cWait] = [randomUUID(), randomUUID(), randomUUID()];
  app(`${draftShipmentSql(shipment, [[trusted, 30000n, cTrusted], [payFirst, 5000n, cPay], [waiting, 2000n, cWait]])}\n${confirmSql(shipment, new Date("2026-10-03T08:00:00Z"))}`);

  const overview = () => app(`select status || '|' || consignments || '|' || expected_usd_cents || '|' || collected_usd_cents || '|' || remaining_usd_cents || '|' ||
                                     not_delivered || '|' || delivered_not_paid || '|' || on_account || '|' || waiting_for_hand_in || '|' || disputes_waiting
                              from shipment_overview where shipment_id = ${lit(shipment)};`);
  assert.equal(overview(), "confirmed|3|37000|0|37000|3|0|0|0|0");

  const round = roundOut([cTrusted, cPay, cWait]);
  enterResult({ roundId: round, consignmentId: cTrusted, outcome: "on_account" });
  enterResult({ roundId: round, consignmentId: cPay, outcome: "unpaid", received: { amount: 2000, currency: "USD" } });
  enterResult({ roundId: round, consignmentId: cWait, outcome: "held" });
  app(`insert into disputes (consignment_id, kind, created_by) values (${lit(cPay)}, 'damaged', ${lit(USER)});`);
  assert.equal(overview(), "on_rounds|3|37000|2000|35000|1|1|1|2|1");

  assert.equal(app(`select balance_usd_cents || '|' || unpaid_consignments || '|' || over_limit from customer_overview where customer_id = ${lit(payFirst)};`), "3000|1|false");
  assert.equal(app(`select status || '|' || remaining_usd_cents || '|' || has_exception from consignment_details where consignment_id = ${lit(cPay)};`), "delivered_not_paid|3000|false");
  assert.equal(app(`select kind || '|' || currency || '|' || balance from account_overview where customer_id = ${lit(payFirst)};`), "customer|USD|3000");

  // A consignment taken off the file is no longer counted on it.
  app(`select gs_cancel_consignment(${lit(cWait)}, ${lit(USER)}, 'Wrong customer');`);
  assert.equal(overview(), "reconciling|2|35000|2000|33000|0|1|1|2|1");
});

test("a payment at the office can name the consignment it is for, and only while it is posted", () => {
  const customer = newCustomer();
  const other = newCustomer();
  const { consignmentId: older } = charge(customer, 4000n, new Date("2026-10-01T08:00:00Z"));
  const { consignmentId: newer } = charge(customer, 5000n, new Date("2026-10-02T08:00:00Z"));
  const { consignmentId: someoneElses } = charge(other, 1000n);
  const pay = (cents: number, target: string | null, key = randomUUID()) =>
    `select gs_post_entry('office_payment', now(), ${lit(USER)}, ${lit(key)}, jsonb_build_array(
       jsonb_build_object('account_id', gs_account('vault_usd'), 'currency', 'USD', 'amount', ${cents}),
       jsonb_build_object('account_id', gs_customer_account(${lit(customer)}), 'currency', 'USD', 'amount', -${cents})),
       null, null, null, ${target === null ? "null" : lit(target)});`;
  const remaining = (id: string) => app(`select remaining_usd_cents from consignment_money where consignment_id = ${lit(id)};`);

  // $50 for the newer goods pays those, not the older file.
  const entry = app(pay(5000, newer));
  assert.equal(remaining(newer), "0");
  assert.equal(remaining(older), "4000");

  // Not for another customer's goods: refused, and nothing is posted.
  refused(() => app(pay(1000, someoneElses)), /target_invalid/);
  assert.equal(customerBalance(customer), 4000n);

  // A payment already posted cannot be pointed somewhere else, by anyone.
  const plain = app(pay(1000, null));
  refused(() => app(`select gs_set_payment_target(${lit(plain)}, ${lit(older)});`), /entry_closed/);
  refused(() => owner(`select gs_set_payment_target(${lit(plain)}, ${lit(older)});`), /entry_closed/);
  refused(() => app(`insert into payment_targets (entry_id, consignment_id) values (${lit(plain)}, ${lit(older)});`), /permission denied/);
  refused(() => app(`update payment_targets set consignment_id = ${lit(older)} where entry_id = ${lit(entry)};`), /permission denied/);
  assert.equal(app(`select consignment_id from payment_targets where entry_id = ${lit(entry)};`), newer);
  assert.equal(health(), "");
});
