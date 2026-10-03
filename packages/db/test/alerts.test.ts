// Checks and alerts, proven against a real Postgres: what is wrong is worked
// out from the facts, one alert per thing, closed by a note or by the facts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { iqd, notesFor, officePayment, usd, walletPayment } from "@green-star/domain";
import { lit } from "../src/index.ts";
import {
  USER,
  app,
  appAs,
  appNoActor,
  charge,
  enterResult,
  handIn,
  health,
  makeTrusted,
  newCustomer,
  owner,
  post,
  refused,
  roundOut,
  setRate,
} from "./helpers.ts";

const DAY = new Date("2026-12-01T09:00:00Z");
setRate("2026-12-01", 145000);

let n = 0;
function newUser(role: "ceo" | "owner" | "monitor"): string {
  const id = randomUUID();
  const who = role === "monitor" ? `null, ${lit(`alertscreen${++n}`)}` : `${lit(`+96479${(30000000 + ++n).toString()}`)}, null`;
  app(`insert into users (id, name, role, phone, sign_in_name, created_by) values (${lit(id)}, ${lit(`Alert ${role}`)}, ${lit(role)}, ${who}, ${lit(USER)});`);
  return id;
}

/** Switches a second CEO off again, so the other test files find one CEO, as they expect. */
const retire = (userId: string) => app(`update users set active = false where id = ${lit(userId)};`);

/** Runs the checks the way the application does: now. Returns how many alerts were opened. */
const sync = (deep = false) => Number(app(`select gs_sync_alerts(${deep});`));
/** Runs the checks as if it were this moment. Only the schema owner can. */
const syncAt = (at: Date | string, deep = false) =>
  Number(owner(`select gs_sync_alerts_at(${typeof at === "string" ? at : lit(at.toISOString())}, ${deep});`));

/** Every alert about one thing, oldest first: "status/active" joined by spaces. */
const alertsOf = (kind: string, subject: string) =>
  app(
    `select coalesce(string_agg(status || '/' || active, ' ' order by opened_at, id), '')
     from alerts where kind = ${lit(kind)} and subject = ${lit(subject)};`,
  );

const field = (kind: string, subject: string, column: string) =>
  app(`select ${column} from alerts where kind = ${lit(kind)} and subject = ${lit(subject)} order by opened_at desc, id desc limit 1;`);

/** A pay-first customer who got his goods and paid nothing. Returns the round and the consignment. */
function forgotToCollect(name: string, cents = 6200n) {
  const customer = newCustomer(name);
  const { consignmentId, shipmentId } = charge(customer, cents, new Date("2026-12-01T05:00:00Z"));
  const round = roundOut([consignmentId], new Date("2026-12-01T06:00:00Z"));
  enterResult({ roundId: round, consignmentId, outcome: "unpaid", at: DAY });
  return { customer, consignmentId, shipmentId, round };
}

test("the driver forgot to collect: one alert, however often the checks run", () => {
  const { customer, consignmentId, shipmentId, round } = forgotToCollect("Hemn Forgot");
  assert.equal(alertsOf("missed_collection", consignmentId), "", "nothing until the checks run");

  assert.ok(sync() >= 1);
  assert.equal(alertsOf("missed_collection", consignmentId), "open/true");
  assert.equal(sync(), 0, "running the checks again opens nothing");
  assert.equal(sync(), 0);
  assert.equal(alertsOf("missed_collection", consignmentId), "open/true");

  assert.equal(
    field("missed_collection", consignmentId, "severity || '|' || amount || '|' || currency || '|' || customer_id || '|' || shipment_id || '|' || round_id"),
    `high|6200|USD|${customer}|${shipmentId}|${round}`,
  );
  const number = app(`select number from rounds where id = ${lit(round)};`);
  assert.equal(field("missed_collection", consignmentId, "title"), `Round ${number}: Hemn Forgot got the goods and $62.00 was not collected`);
});

test("an alert goes away by itself when the facts change", () => {
  const { consignmentId } = forgotToCollect("Allowed Later");
  sync();
  assert.equal(alertsOf("missed_collection", consignmentId), "open/true");

  // The CEO allows it: no longer the driver's mistake.
  app(`insert into exceptions (consignment_id, approved_by, reason) values (${lit(consignmentId)}, ${lit(USER)}, 'pays on Thursday');`);
  sync();
  assert.equal(alertsOf("missed_collection", consignmentId), "cleared/false");
  assert.equal(field("missed_collection", consignmentId, "cleared_at is not null and resolved_at is null and note is null"), "t");
  // It went away by itself, so there is nothing left to resolve.
  refused(() => app(`select gs_resolve_alert(id, ${lit(USER)}, 'late') from alerts where kind = 'missed_collection' and subject = ${lit(consignmentId)};`), /alert_not_open/);
});

test("something that stops being wrong and happens again is a new alert", () => {
  const customer = newCustomer("Over The Limit");
  makeTrusted(customer, 10000n);
  charge(customer, 15000n, new Date("2026-12-01T05:00:00Z"));
  sync();
  assert.equal(alertsOf("over_limit", customer), "open/true");
  assert.equal(field("over_limit", customer, "title"), "Over The Limit owes $150.00, $50.00 over the limit");
  assert.equal(field("over_limit", customer, "amount"), "5000");

  // He pays some more and is still over: the same alert, with the new amount.
  post(officePayment({ customerId: customer, received: usd(2000n) }), DAY);
  sync();
  assert.equal(alertsOf("over_limit", customer), "open/true");
  assert.equal(field("over_limit", customer, "title"), "Over The Limit owes $130.00, $30.00 over the limit");

  post(officePayment({ customerId: customer, received: usd(4000n) }), DAY);
  sync();
  assert.equal(alertsOf("over_limit", customer), "cleared/false");

  charge(customer, 9000n, new Date("2026-12-01T05:30:00Z"));
  sync();
  assert.equal(alertsOf("over_limit", customer), "cleared/false open/true");
});

test("the CEO resolves an alert with a note, and it stays resolved while the same thing is still wrong", () => {
  const { consignmentId } = forgotToCollect("Resolved By Note");
  sync();
  const id = field("missed_collection", consignmentId, "id");

  refused(() => app(`select gs_resolve_alert(${lit(id)}, ${lit(USER)}, '   ');`), /note_required/);
  refused(() => app(`select gs_resolve_alert(${lit(id)}, ${lit(USER)}, null);`), /note_required/);
  refused(() => app(`select gs_resolve_alert(${lit(randomUUID())}, ${lit(USER)}, 'x');`), /alert_not_found/);
  assert.equal(alertsOf("missed_collection", consignmentId), "open/true");

  app(`select gs_resolve_alert(${lit(id)}, ${lit(USER)}, '  Called him, he pays tomorrow  ');`);
  assert.equal(alertsOf("missed_collection", consignmentId), "resolved/true");
  assert.equal(field("missed_collection", consignmentId, "note || '|' || resolved_by || '|' || (resolved_at is not null)"), `Called him, he pays tomorrow|${USER}|true`);

  // Still unpaid, and the checks do not open it again.
  assert.equal(sync(), 0);
  assert.equal(alertsOf("missed_collection", consignmentId), "resolved/true");
  // The same request again changes nothing.
  app(`select gs_resolve_alert(${lit(id)}, ${lit(USER)}, 'a second note');`);
  assert.equal(field("missed_collection", consignmentId, "note"), "Called him, he pays tomorrow");

  // He pays: it is no longer wrong, and the record of who resolved it stays.
  const customer = field("missed_collection", consignmentId, "customer_id");
  post(officePayment({ customerId: customer, received: usd(6200n) }), DAY);
  sync();
  assert.equal(alertsOf("missed_collection", consignmentId), "resolved/false");
  assert.equal(field("missed_collection", consignmentId, "note || '|' || (cleared_at is not null)"), "Called him, he pays tomorrow|true");
});

test("only the CEO resolves an alert, under his own name", () => {
  const { consignmentId } = forgotToCollect("Who Resolves");
  sync();
  const id = field("missed_collection", consignmentId, "id");
  const resolve = (who: string) => `select gs_resolve_alert(${lit(id)}, ${lit(who)}, 'done');`;

  for (const role of ["owner", "monitor"] as const) {
    const who = newUser(role);
    refused(() => appAs(who)(resolve(who)), /ceo_only/);
    refused(() => appAs(who)(resolve(USER)), /ceo_only/);
  }
  refused(() => appNoActor(resolve(USER)), /actor_required/);
  const second = newUser("ceo");
  refused(() => appAs(second)(resolve(USER)), /actor_mismatch/);
  assert.equal(alertsOf("missed_collection", consignmentId), "open/true");

  appAs(second)(resolve(second));
  assert.equal(field("missed_collection", consignmentId, "status || '|' || resolved_by"), `resolved|${second}`);
  retire(second);
});

test("nothing deletes an alert or rewrites one that was resolved", () => {
  const open = forgotToCollect("Locked Open").consignmentId;
  const done = forgotToCollect("Locked Done").consignmentId;
  const gone = forgotToCollect("Locked Gone").consignmentId;
  sync();
  app(`select gs_resolve_alert(id, ${lit(USER)}, 'handled') from alerts where kind = 'missed_collection' and subject = ${lit(done)};`);
  app(`insert into exceptions (consignment_id, approved_by, reason) values (${lit(gone)}, ${lit(USER)}, 'allowed');`);
  sync();
  const where = (subject: string) => `where kind = 'missed_collection' and subject = ${lit(subject)}`;

  // The application can only read alerts. Everything else goes through the two functions.
  refused(() => app(`update alerts set title = 'nothing to see' ${where(open)};`), /permission denied/);
  refused(() => app(`delete from alerts ${where(open)};`), /permission denied/);
  refused(() => app(`insert into alerts (kind, severity, subject, title) values ('vault_gap', 'low', 'made up', 'made up');`), /permission denied/);

  // And the rules hold for the schema owner too.
  refused(() => owner(`delete from alerts ${where(open)};`), /ledger_immutable/);
  refused(() => owner("truncate alerts;"), /ledger_immutable/);
  refused(() => owner(`update alerts set subject = 'something else' ${where(open)};`), /alert_locked/);
  refused(() => owner(`update alerts set consignment_id = null ${where(open)};`), /alert_locked/);
  refused(() => owner(`update alerts set note = 'rewritten' ${where(done)};`), /alert_locked/);
  refused(() => owner(`update alerts set status = 'open', resolved_at = null, resolved_by = null, note = null ${where(done)};`), /alert_locked/);
  refused(() => owner(`update alerts set title = 'rewritten' ${where(done)};`), /alert_locked/);
  refused(() => owner(`update alerts set title = 'rewritten' ${where(gone)};`), /alert_locked/);
  refused(() => owner(`update alerts set active = true, cleared_at = null, status = 'open' ${where(gone)};`), /alert_locked/);
  // One thing that is wrong is one alert, even by hand.
  refused(
    () => owner(`insert into alerts (kind, severity, subject, title) values ('missed_collection', 'high', ${lit(open)}, 'twice');`),
    /alerts_one_active/,
  );

  assert.equal(alertsOf("missed_collection", open), "open/true");
  assert.equal(alertsOf("missed_collection", done), "resolved/true");
  assert.equal(alertsOf("missed_collection", gone), "cleared/false");
});

test("only the schema owner can name the moment the checks run at", () => {
  refused(() => app("select gs_sync_alerts_at(now() + interval '30 days', false);"), /permission denied/);
  refused(() => appNoActor("select gs_sync_alerts_at(now(), false);"), /permission denied/);
  // The worker runs the checks with nobody acting.
  appNoActor("select gs_sync_alerts();");
  appNoActor("select gs_sync_alerts(true);");
});

test("a round's cash that does not match its receipts is an alert per currency, until the rest comes in", () => {
  const customer = newCustomer("Cash Gap");
  const { consignmentId } = charge(customer, 10000n, new Date("2026-12-01T05:00:00Z"));
  const round = roundOut([consignmentId], new Date("2026-12-01T06:00:00Z"));
  enterResult({ roundId: round, consignmentId, outcome: "paid", received: { amount: 10000, currency: "USD" }, at: DAY });
  sync();
  assert.equal(alertsOf("round_cash_gap", `${round}:USD`), "", "cash still with the driver is not a gap until it is counted in");

  handIn(round, { usd: { 5000: 1, 2000: 2 }, note: "he says the rest is at home", at: new Date("2026-12-01T15:00:00Z") });
  sync();
  assert.equal(alertsOf("round_cash_gap", `${round}:USD`), "open/true");
  assert.equal(alertsOf("round_cash_gap", `${round}:IQD`), "");
  const number = app(`select number from rounds where id = ${lit(round)};`);
  assert.equal(field("round_cash_gap", `${round}:USD`, "title || '|' || amount || '|' || round_id"), `Round ${number}: the cash handed in is $10.00 short|1000|${round}`);

  handIn(round, { usd: { 1000: 1 }, at: new Date("2026-12-01T16:00:00Z") });
  sync();
  assert.equal(alertsOf("round_cash_gap", `${round}:USD`), "cleared/false");
});

test("cartons that differ from the file are an alert until China is told", () => {
  const customer = newCustomer("Carton Count");
  const { consignmentId, shipmentId } = charge(customer, 3000n, new Date("2026-12-01T05:00:00Z"));
  app(`update consignments set cartons_expected = 5, cartons_received = 5 where id = ${lit(consignmentId)};`);
  sync();
  assert.equal(alertsOf("carton_mismatch", consignmentId), "");

  app(`update consignments set cartons_received = 4 where id = ${lit(consignmentId)};`);
  sync();
  assert.equal(alertsOf("carton_mismatch", consignmentId), "open/true");
  const code = app(`select code from shipments where id = ${lit(shipmentId)};`);
  assert.equal(field("carton_mismatch", consignmentId, "title"), `${code}: Carton Count has 4 cartons, the file says 5`);

  // Damaged goods are another matter; a missing carton sent to China is this one.
  app(`insert into disputes (consignment_id, kind, created_by) values (${lit(consignmentId)}, 'damaged', ${lit(USER)});`);
  sync();
  assert.equal(alertsOf("carton_mismatch", consignmentId), "open/true");
  app(`insert into disputes (consignment_id, kind, created_by) values (${lit(consignmentId)}, 'missing', ${lit(USER)});`);
  sync();
  assert.equal(alertsOf("carton_mismatch", consignmentId), "cleared/false");
});

test("goods held in the car longer than the set number of days are an alert", () => {
  const customer = newCustomer("Held Goods");
  const { consignmentId, shipmentId } = charge(customer, 4000n, new Date("2026-12-01T05:00:00Z"));
  const round = roundOut([consignmentId], new Date("2026-12-01T06:00:00Z"));
  const heldAt = new Date("2026-12-01T10:00:00Z");
  enterResult({ roundId: round, consignmentId, outcome: "held", at: heldAt });
  const after = (days: number, seconds = 0) => new Date(heldAt.getTime() + days * 86_400_000 + seconds * 1000);
  assert.equal(app("select held_in_car_days from settings;"), "3");

  syncAt(after(3, -1));
  assert.equal(alertsOf("held_too_long", consignmentId), "");
  syncAt(after(3));
  assert.equal(alertsOf("held_too_long", consignmentId), "open/true");
  const code = app(`select code from shipments where id = ${lit(shipmentId)};`);
  assert.equal(field("held_too_long", consignmentId, "title"), `Held Goods's goods from ${code} have been in the car for 3 days`);
  // The wording keeps up with the days.
  syncAt(after(6, 5));
  assert.equal(alertsOf("held_too_long", consignmentId), "open/true");
  assert.equal(field("held_too_long", consignmentId, "title"), `Held Goods's goods from ${code} have been in the car for 6 days`);

  // The CEO sets the number of days.
  app("update settings set held_in_car_days = 10;");
  syncAt(after(6, 5));
  assert.equal(alertsOf("held_too_long", consignmentId), "cleared/false");
  syncAt(after(10));
  assert.equal(alertsOf("held_too_long", consignmentId), "cleared/false open/true");
  app("update settings set held_in_car_days = 3;");

  // The goods go out again and are paid for: nothing is held any more.
  const again = roundOut([consignmentId], new Date("2026-12-12T06:00:00Z"));
  enterResult({ roundId: again, consignmentId, outcome: "paid", received: { amount: 4000, currency: "USD" }, at: new Date("2026-12-12T10:00:00Z") });
  syncAt(after(30));
  assert.equal(alertsOf("held_too_long", consignmentId), "cleared/false cleared/false");
});

test("the settings are one row, changed only by the CEO, and every change is logged", () => {
  assert.equal(app("select count(*) from settings;"), "1");
  assert.equal(
    app("select held_in_car_days || '|' || vault_close_time || '|' || wallet_check_days || '|' || array_to_string(monitor_widgets, ',') from settings;"),
    "3|18:00:00|7|files,rounds,held",
  );
  refused(() => owner("insert into settings (id) values (2);"), /settings_one_row/);
  refused(() => owner("insert into settings default values;"), /settings_pkey/);
  refused(() => owner("delete from settings;"), /ledger_immutable/);
  refused(() => app("delete from settings;"), /permission denied/);

  refused(() => app("update settings set held_in_car_days = 0;"), /settings_held_days/);
  refused(() => app("update settings set held_in_car_days = 61;"), /settings_held_days/);
  refused(() => app("update settings set wallet_check_days = 0;"), /settings_wallet_days/);
  refused(() => app("update settings set monitor_widgets = '{files,money}';"), /settings_widgets/);
  refused(() => app("update settings set monitor_widgets = '{files,files}';"), /settings_widgets/);
  refused(() => app("update settings set monitor_widgets = null;"), /null value|settings_widgets/);

  for (const role of ["owner", "monitor"] as const) {
    const who = newUser(role);
    refused(() => appAs(who)("update settings set held_in_car_days = 5;"), /ceo_only/);
  }
  refused(() => appNoActor("update settings set held_in_car_days = 5;"), /actor_required/);
  assert.equal(app("select held_in_car_days from settings;"), "3");

  const before = Number(app("select count(*) from audit_log where entity = 'settings';"));
  app("update settings set monitor_widgets = '{held,rounds}', updated_at = now();");
  assert.equal(Number(app("select count(*) from audit_log where entity = 'settings';")), before + 1);
  assert.equal(
    app("select actor || '|' || (before ->> 'monitor_widgets') || '|' || (after ->> 'monitor_widgets') from audit_log where entity = 'settings' order by id desc limit 1;"),
    `${USER}|["files", "rounds", "held"]|["held", "rounds"]`,
  );
  // An empty screen is allowed: the monitor shows nothing.
  app("update settings set monitor_widgets = '{}';");
  app("update settings set monitor_widgets = '{files,rounds,held}';");
});

test("a wallet is checked against its app: a gap needs a note and is carried forward", () => {
  const customer = newCustomer("Wallet Payer");
  charge(customer, 50000n, new Date("2026-12-01T05:00:00Z"));
  const status = () => app("select ledger_balance || '|' || expected_in_app || '|' || coalesce(last_difference::text, '-') || '|' || (unchecked_since is not null) from wallet_status where code = 'wallet_fib_iqd';");
  const base = Number(app("select expected_in_app from wallet_status where code = 'wallet_fib_iqd';"));
  post(walletPayment({ customerId: customer, received: iqd(145000n), ratePer100: 145000, wallet: "fib" }), DAY);
  assert.equal(status(), `${base + 145000}|${base + 145000}|-|true`);

  const check = (balance: number, note: string | null, id = randomUUID(), account = "wallet_fib_iqd") =>
    `select gs_check_wallet(${lit(id)}, ${lit(account)}, ${lit(USER)}, ${balance}, ${lit(DAY.toISOString())}, ${note === null ? "null" : lit(note)});`;

  refused(() => app(check(base + 100000, null)), /gap_note_required/);
  refused(() => app(check(base + 100000, "   ")), /gap_note_required/);
  refused(() => app(check(-1, "negative")), /balance_invalid/);
  refused(() => app(check(5, "x", randomUUID(), "wallet_nowhere")), /wallet_not_found/);
  refused(() => app(check(5, "x", randomUUID(), "vault_usd")), /wallet_not_found/);
  assert.equal(app("select count(*) from wallet_checks where account_id = (select id from accounts where code = 'wallet_fib_iqd');"), "0");

  // The app shows 45,000 less than the books: he took it out as cash.
  const first = randomUUID();
  app(check(base + 100000, "took 45,000 out as cash", first));
  assert.equal(status(), `${base + 145000}|${base + 100000}|-45000|false`);
  // The same request again is one check.
  app(check(base + 100000, "took 45,000 out as cash", first));
  app(check(1, "something else entirely", first));
  assert.equal(app(`select count(*) from wallet_checks where id = ${lit(first)};`), "1");
  refused(() => app(check(5, "x", first, "wallet_fib_usd")), /check_id_reused/);

  sync();
  assert.equal(alertsOf("wallet_gap", first), "open/true");
  assert.equal(field("wallet_gap", first, "title || '|' || amount || '|' || currency"), "FIB, dinars: the app shows 45,000 IQD less than the books|-45000|IQD");

  // From now on the app is expected to show what it showed: no note needed when it matches.
  const second = randomUUID();
  app(check(base + 100000, null, second));
  sync();
  assert.equal(alertsOf("wallet_gap", second), "");
  post(walletPayment({ customerId: customer, received: iqd(14500n), ratePer100: 145000, wallet: "fib" }), DAY);
  assert.equal(status(), `${base + 159500}|${base + 114500}|0|true`);
  refused(() => app(check(base + 100000, null)), /gap_note_required/);
  app(check(base + 114500, null));

  // A check is never edited or deleted.
  refused(() => owner(`update wallet_checks set app_balance = 1 where id = ${lit(first)};`), /ledger_immutable/);
  refused(() => owner(`delete from wallet_checks where id = ${lit(first)};`), /ledger_immutable/);
  refused(() => app(`insert into wallet_checks (id, account_id, currency, app_balance, expected, checked_at, checked_by) select ${lit(randomUUID())}, id, 'IQD', 1, 1, now(), ${lit(USER)} from accounts where code = 'wallet_fib_iqd';`), /permission denied/);
  refused(
    () => owner(`insert into wallet_checks (id, account_id, currency, app_balance, expected, checked_at, checked_by) select ${lit(randomUUID())}, id, 'IQD', 1, 2, now(), ${lit(USER)} from accounts where code = 'wallet_fib_iqd';`),
    /wallet_checks_gap_has_note/,
  );

  // Only the CEO, under his own name.
  for (const role of ["owner", "monitor"] as const) {
    const who = newUser(role);
    refused(() => appAs(who)(check(base + 114500, null).replace(lit(USER), lit(who))), /ceo_only/);
    refused(() => appAs(who)(check(base + 114500, null)), /ceo_only/);
  }
  refused(() => appNoActor(check(base + 114500, null)), /actor_required/);
  const otherCeo = newUser("ceo");
  refused(() => appAs(otherCeo)(check(base + 114500, null)), /actor_mismatch/);
  retire(otherCeo);
});

test("wallet money that goes unchecked for longer than the set days is an alert", () => {
  const customer = newCustomer("Zain Payer");
  charge(customer, 20000n, new Date("2026-12-01T05:00:00Z"));
  post(walletPayment({ customerId: customer, received: usd(5000n), wallet: "zaincash" }), DAY);
  const since = new Date(app("select unchecked_since from wallet_status where code = 'wallet_zaincash_usd';").replace(" ", "T").replace(/\+00$/, "Z"));
  assert.ok(!Number.isNaN(since.getTime()));
  const after = (days: number, seconds = 0) => new Date(since.getTime() + days * 86_400_000 + seconds * 1000);

  syncAt(after(7, -2));
  assert.equal(alertsOf("wallet_check_due", "wallet_zaincash_usd"), "");
  // A wallet nobody has paid into has nothing to check.
  assert.equal(alertsOf("wallet_check_due", "wallet_fastpay_iqd"), "");
  syncAt(after(7, 2));
  assert.equal(alertsOf("wallet_check_due", "wallet_zaincash_usd"), "open/true");
  assert.equal(field("wallet_check_due", "wallet_zaincash_usd", "severity || '|' || title"), "low|ZainCash, dollars has not been checked against its app for 7 days");

  app(`select gs_check_wallet(${lit(randomUUID())}, 'wallet_zaincash_usd', ${lit(USER)}, expected_in_app, now(), null) from wallet_status where code = 'wallet_zaincash_usd';`);
  syncAt(after(40));
  assert.equal(alertsOf("wallet_check_due", "wallet_zaincash_usd"), "cleared/false");
  syncAt("now()");
});

test("a dinar payment that stands at a rate the day no longer has is an alert until it is reversed", () => {
  setRate("2026-12-05", 145000);
  const customer = newCustomer("Old Rate");
  charge(customer, 20000n, new Date("2026-12-01T05:00:00Z"));
  const at = new Date("2026-12-05T09:00:00Z");
  const entry = post(officePayment({ customerId: customer, received: iqd(145000n), ratePer100: 145000 }), at);
  sync();
  assert.equal(alertsOf("payment_at_old_rate", entry), "");

  setRate("2026-12-05", 150000);
  sync();
  assert.equal(alertsOf("payment_at_old_rate", entry), "open/true");
  assert.equal(
    field("payment_at_old_rate", entry, "title || '|' || customer_id"),
    `Old Rate paid 145,000 IQD on 5 Dec at 145,000, and the day's rate is now 150,000|${customer}`,
  );

  app(`select gs_reverse_entry(${lit(entry)}, ${lit(USER)}, 'entered again at the new rate', ${lit(randomUUID())});`);
  sync();
  assert.equal(alertsOf("payment_at_old_rate", entry), "cleared/false");
});

// The vault tests come last: they count the vault, and take every count back again.
const BAGHDAD_MS = 3 * 3_600_000;
const baghdadDay = (at: Date) => new Date(at.getTime() + BAGHDAD_MS).toISOString().slice(0, 10);

test("a vault count that does not match is an alert, and goes when the count is taken back", () => {
  const customer = newCustomer("Vault Payer");
  charge(customer, 30000n, new Date("2026-12-01T05:00:00Z"));
  post(officePayment({ customerId: customer, received: usd(10000n) }), DAY);
  const expected = Number(app("select gs_vault_expected('USD');"));
  assert.ok(expected >= 10000);

  // Later than any close another test makes. Counted $20 short in dollars, and the dinars to the note.
  const close = randomUUID();
  const usdNotes = JSON.stringify(notesFor("USD", BigInt(expected - 2000)));
  const iqdNotes = JSON.stringify(notesFor("IQD", BigInt(app("select gs_vault_expected('IQD');"))));
  app(`select gs_close_vault(${lit(close)}, ${lit(USER)}, '2039-06-01T15:00:00Z', ${lit(usdNotes)}::jsonb, ${lit(iqdNotes)}::jsonb, 'a 20 is missing');`);
  assert.equal(app(`select difference from cash_counts where vault_close_id = ${lit(close)} and currency = 'USD';`), "-2000");

  sync();
  assert.equal(alertsOf("vault_gap", `${close}:USD`), "open/true");
  assert.equal(alertsOf("vault_gap", `${close}:IQD`), "");
  assert.equal(field("vault_gap", `${close}:USD`, "severity || '|' || title || '|' || amount"), "high|Vault count of 1 Jun: $20.00 short|-2000");

  app(`select gs_resolve_alert(id, ${lit(USER)}, 'found it in the drawer') from alerts where kind = 'vault_gap' and subject = ${lit(`${close}:USD`)};`);
  assert.equal(sync(), 0);
  assert.equal(alertsOf("vault_gap", `${close}:USD`), "resolved/true");

  app(`select gs_void_vault_close(${lit(close)}, ${lit(USER)}, 'counted again');`);
  sync();
  assert.equal(alertsOf("vault_gap", `${close}:USD`), "resolved/false");
});

test("cash moved and the vault was not counted by closing time: a reminder until it is counted", () => {
  // Nothing has been counted, and cash has moved.
  assert.equal(app("select count(*) from vault_closes where voided_at is null;"), "0");
  const first = new Date(
    app(
      `select min(e.created_at) from journal_entries e
       where exists (select 1 from journal_lines l join accounts a on a.id = l.account_id where l.entry_id = e.id and a.kind = 'vault');`,
    ).replace(" ", "T").replace(/\+00$/, "Z"),
  );
  assert.ok(!Number.isNaN(first.getTime()));
  const day = baghdadDay(first);
  const next = baghdadDay(new Date(first.getTime() + 86_400_000));
  // Other tests ran the checks at moments of their own, so this one looks only at what is open now.
  const open = (subject: string) => app(`select count(*) from alerts where kind = 'vault_not_closed' and subject = ${lit(subject)} and status = 'open';`);
  /** A time of day on a Baghdad day, as an instant. */
  const baghdad = (d: string, time: string, plusSeconds = 0) => new Date(new Date(`${d}T${time}+03:00`).getTime() + plusSeconds * 1000);

  // Closing time at the very end of the day: the money moved before it, so that day is the one to count.
  app("update settings set vault_close_time = '23:59:59';");
  syncAt(baghdad(day, "23:59:59", -1));
  assert.equal(open(day), "0");
  syncAt(baghdad(day, "23:59:59"));
  assert.equal(open(day), "1");
  assert.equal(field("vault_not_closed", day, "severity"), "medium");
  assert.match(field("vault_not_closed", day, "title"), /^The vault has not been counted since \d{1,2} [A-Z][a-z]{2}$/);
  // It stays until the vault is counted, however many days pass.
  syncAt(baghdad(next, "23:59:59", 86_400 * 3));
  assert.equal(open(day), "1");

  // Closing time at the very start of the day: the money moved after it, so it belongs to the next day's count.
  app("update settings set vault_close_time = '00:00:00';");
  syncAt(baghdad(next, "00:00:00", -1));
  assert.equal(open(day), "0");
  assert.equal(open(next), "0");
  syncAt(baghdad(next, "00:00:00"));
  assert.equal(open(next), "1");

  // He counts the vault: the reminder goes.
  const close = randomUUID();
  app(`select gs_close_vault(${lit(close)}, ${lit(USER)}, '2039-06-02T15:00:00Z', null, null, 'counted nothing, for the test');`);
  syncAt(baghdad(next, "00:00:00", 86_400 * 5));
  assert.equal(open(next), "0");
  assert.equal(field("vault_not_closed", next, "status || '/' || active"), "cleared/false");

  // Money moves again after the count: a new day to count, and a new reminder when its closing time passes.
  const customer = newCustomer("After The Count");
  charge(customer, 1000n, new Date("2026-12-01T05:00:00Z"));
  post(officePayment({ customerId: customer, received: usd(1000n) }), DAY);
  const movedDay = baghdadDay(new Date(Date.now() + 86_400_000));
  syncAt(baghdad(movedDay, "00:00:00", 5));
  assert.equal(open(movedDay), "1");

  // Leave things as the other test files expect them: no count standing, the default settings.
  app(`select gs_void_vault_close(${lit(close)}, ${lit(USER)}, 'test over');`);
  app("update settings set vault_close_time = '18:00';");
  syncAt("now()");
  assert.equal(app("select count(*) from vault_closes where voided_at is null;"), "0");
});

test("the books' own health check is an alert too, and only the deep run looks", () => {
  assert.equal(health(), "");
  const vault = app("select id from accounts where code = 'vault_usd';");
  // Something no rule lets through: the cached balance of the vault is changed by hand.
  owner(`update account_balances set balance = balance + 1 where account_id = ${lit(vault)};`);
  try {
    assert.match(health(), /balance_cache_wrong/);
    const subject = app("select left(problem || ' ' || detail, 400) from gs_ledger_health() limit 1;");

    assert.equal(sync(false), 0, "a single save does not read every line in the books");
    assert.equal(alertsOf("books_out_of_step", subject), "");
    assert.equal(sync(true), 1);
    assert.equal(alertsOf("books_out_of_step", subject), "open/true");
    assert.equal(field("books_out_of_step", subject, "severity || '|' || title"), "high|The books are out of step: balance cache wrong");

    owner(`update account_balances set balance = balance - 1 where account_id = ${lit(vault)};`);
    sync(false);
    assert.equal(alertsOf("books_out_of_step", subject), "open/true", "only the deep run can say the books are fine again");
    sync(true);
    assert.equal(alertsOf("books_out_of_step", subject), "cleared/false");
  } finally {
    if (health() !== "") owner(`update account_balances set balance = balance - 1 where account_id = ${lit(vault)};`);
  }
  assert.equal(health(), "");
});

test("the alerts hold together, and the books are still sound", () => {
  sync(true);
  assert.equal(app("select count(*) from (select kind, subject from alerts where active group by kind, subject having count(*) > 1) d;"), "0");
  // Every open alert is about something that is wrong right now, and everything wrong right now has an alert.
  assert.equal(
    app(
      `select count(*) from alerts a where a.active
       and not exists (select 1 from gs_current_problems(now(), true) p where p.kind = a.kind and p.subject = a.subject);`,
    ),
    "0",
  );
  assert.equal(
    app(
      `select count(*) from gs_current_problems(now(), true) p
       where not exists (select 1 from alerts a where a.active and a.kind = p.kind and a.subject = p.subject);`,
    ),
    "0",
  );
  assert.equal(health(), "");
});
