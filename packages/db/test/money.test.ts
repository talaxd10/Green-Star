// Money at the office, proven against a real Postgres: what each kind of
// entry may move, today's rate, the daily vault close and the China account.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cashOut,
  currencyExchange,
  currencyExchangeToDinars,
  iqd,
  isRateJump,
  notesFor,
  officePayment,
  sentToChina,
  usd,
  walletPayment,
  type NoteCount,
} from "@green-star/domain";
import { lit } from "../src/index.ts";
import {
  APP,
  USER,
  app,
  balances,
  charge,
  customerBalance,
  enterResult,
  handIn,
  health,
  newCustomer,
  owner,
  post,
  refused,
  roundOut,
  setRate,
} from "./helpers.ts";

// The money tests keep to their own days so no other test file changes their rates.
const DAY = new Date("2026-12-01T12:00:00Z");
const NEXT_DAY = new Date("2026-12-02T12:00:00Z");
setRate("2026-12-01", 145000);
setRate("2026-12-02", 147000);

const entryCount = () => app("select count(*) from journal_entries;");

const raw = (kind: string, lines: readonly (readonly [string, "USD" | "IQD", number])[], extra = "") =>
  app(`select gs_post_entry(${lit(kind)}, ${lit(DAY.toISOString())}, ${lit(USER)}, ${lit(randomUUID())}, jsonb_build_array(
         ${lines.map(([account, currency, amount]) => `jsonb_build_object('account_id', ${account}, 'currency', '${currency}', 'amount', ${amount})`).join(",\n         ")})${extra});`);

const expected = (currency: "USD" | "IQD") => BigInt(app(`select gs_vault_expected(${lit(currency)});`));

// Each close is a minute after the one before, the way real closes follow each other.
let closeClock = Date.parse("2026-12-03T12:00:00Z");
const nextCloseTime = () => new Date((closeClock += 60_000));

function closeSql(counted: { usd?: NoteCount; iqd?: NoteCount; note?: string; at?: Date; id?: string }): string {
  const json = (notes: NoteCount | undefined) => (notes ? `${lit(JSON.stringify(notes))}::jsonb` : "null");
  return `select gs_close_vault(${lit(counted.id ?? randomUUID())}, ${lit(USER)}, ${lit((counted.at ?? nextCloseTime()).toISOString())}, ${json(counted.usd)}, ${json(counted.iqd)}, ${counted.note === undefined ? "null" : lit(counted.note)});`;
}
const closeVault = (counted: Parameters<typeof closeSql>[0]) => app(closeSql(counted));

/**
 * Other test files leave the vault's ledger at any amount, even one no notes
 * can make. Counting an empty box, with a note, starts a test from zero.
 */
function emptyVault(at?: Date): void {
  closeVault({ note: "Test setup: start from an empty box", ...(at ? { at } : {}) });
  assert.equal(expected("USD"), 0n);
  assert.equal(expected("IQD"), 0n);
}

/** Puts whole notes into the vault so later tests have something to count. */
function fundVault(usdCents: bigint, dinars: bigint): void {
  const customer = newCustomer("Vault funding");
  if (usdCents > 0n) post(officePayment({ customerId: customer, received: usd(usdCents) }), DAY);
  if (dinars > 0n) post(officePayment({ customerId: customer, received: iqd(dinars), ratePer100: 145000 }), DAY);
}

test("a customer's account goes down only against money that really arrived", () => {
  const customer = `gs_customer_account(${lit(newCustomer())})`;
  const other = `gs_customer_account(${lit(newCustomer())})`;
  const before = entryCount();

  // The write-off that must not exist: crediting a customer out of an expense, or out of thin air.
  refused(() => raw("office_payment", [["gs_account('expense_other_usd')", "USD", 8500], [customer, "USD", -8500]]), /entry_shape/);
  refused(() => raw("office_payment", [["gs_account('china_payable')", "USD", 8500], [customer, "USD", -8500]]), /entry_shape/);
  refused(() => raw("cash_out", [["gs_account('expense_other_usd')", "USD", 8500], [customer, "USD", -8500]], ", 'Forgive the debt'"), /entry_shape/);
  refused(() => raw("sent_to_china", [["gs_account('china_payable')", "USD", 8500], [customer, "USD", -8500]]), /entry_shape/);
  refused(() => raw("currency_exchange", [["gs_account('vault_usd')", "USD", 8500], [customer, "USD", -8500]]), /entry_shape/);
  // Moving a debt from one customer to another is not a payment either.
  refused(() => raw("office_payment", [[other, "USD", 8500], [customer, "USD", -8500]]), /entry_shape/);
  // An office payment lands in the vault, a wallet payment in a wallet.
  refused(() => raw("office_payment", [["gs_account('wallet_fib_usd')", "USD", 8500], [customer, "USD", -8500]]), /entry_shape/);
  refused(() => raw("wallet_payment", [["gs_account('vault_usd')", "USD", 8500], [customer, "USD", -8500]]), /entry_shape/);
  // Money does not go back out to a customer as a "payment".
  refused(() => raw("office_payment", [["gs_account('vault_usd')", "USD", -8500], [customer, "USD", 8500]]), /entry_shape/);
  // Cash out comes from the vault and goes to an expense; China is paid from the vault.
  refused(() => raw("cash_out", [["gs_account('expense_other_usd')", "USD", 100], ["gs_account('wallet_fib_usd')", "USD", -100]], ", 'x'"), /entry_shape/);
  refused(() => raw("cash_out", [["gs_account('vault_usd')", "USD", 100], ["gs_account('expense_other_usd')", "USD", -100]], ", 'x'"), /entry_shape/);
  refused(() => raw("sent_to_china", [["gs_account('china_payable')", "USD", -100], ["gs_account('vault_usd')", "USD", 100]]), /entry_shape/);
  // One payment is one customer and one amount in one currency.
  refused(
    () => raw("office_payment", [["gs_account('vault_usd')", "USD", 200], [customer, "USD", -100], [other, "USD", -100]]),
    /entry_shape: a office_payment entry is for one customer/,
  );
  refused(
    () => raw("office_payment", [["gs_account('vault_usd')", "USD", 100], ["gs_account('vault_usd')", "USD", 100], [customer, "USD", -200]]),
    /entry_shape: a office_payment entry is one amount in one currency/,
  );
  assert.equal(entryCount(), before, "a refused entry must not post anything");

  // Every kind the app builds still posts.
  const real = newCustomer();
  post(officePayment({ customerId: real, received: usd(8500) }), DAY);
  post(officePayment({ customerId: real, received: iqd(123250), ratePer100: 145000 }), DAY);
  post(walletPayment({ customerId: real, wallet: "zaincash", received: iqd(145000), ratePer100: 145000 }), DAY);
  post(cashOut({ category: "fuel_car", amount: iqd(25000), reason: "Fuel" }), DAY);
  post(sentToChina({ amountUsdCents: 5000n }), DAY);
  post(currencyExchange({ iqdGiven: 145000n, usdCentsReceived: 10000n }), DAY);
  const reversed = post(currencyExchangeToDinars({ usdCentsGiven: 10000n, iqdReceived: 145000n }), DAY);
  // A reversal mirrors its entry, so it moves the same accounts the other way.
  app(`select gs_reverse_entry(${lit(reversed)}, ${lit(USER)}, 'Exchange did not happen', ${lit(randomUUID())});`);
  refused(() => owner("update entry_shapes set direction = 0;"), /ledger_immutable/);
  assert.equal(health(), "");
});

test("the day's rate is set in one place, logged, and a typing mistake is caught", () => {
  const day = "2026-12-10";
  const set = (rate: number, confirm = false) => app(`select gs_set_rate(${lit(day)}, ${rate}, ${lit(USER)}${confirm ? ", true" : ""});`);
  const rate = () => app(`select iqd_per_100_usd from fx_rates where day = ${lit(day)};`);

  // Not by hand.
  refused(() => app(`insert into fx_rates (day, iqd_per_100_usd, set_by) values (${lit(day)}, 145000, ${lit(USER)});`), /permission denied/);
  refused(() => app(`update fx_rates set iqd_per_100_usd = 1 where day = '2026-12-01';`), /permission denied/);
  refused(() => set(0), /rate_invalid/);

  // 1,450 typed instead of 145,000: far from yesterday's rate, so it is asked again.
  assert.equal(isRateJump(147000, 1450), true);
  refused(() => set(1450), /rate_jump/);
  set(146500);
  assert.equal(rate(), "146500");
  set(146500); // the same again: nothing to log
  // A real jump is allowed once it is confirmed.
  refused(() => set(180000), /rate_jump/);
  set(180000, true);
  set(146000, true);
  assert.equal(
    app(`select string_agg(coalesce(rate_before::text, '-') || '>' || rate_after, ' ' order by id) from fx_rate_changes where day = ${lit(day)};`),
    "->146500 146500>180000 180000>146000",
  );
  refused(() => owner(`delete from fx_rate_changes where day = ${lit(day)};`), /ledger_immutable/);

  // A dinar payment entered before the rate was changed stands at the rate it used, and is listed.
  const customer = newCustomer();
  const at = new Date("2026-12-10T09:00:00Z");
  const payment = post(officePayment({ customerId: customer, received: iqd(146000), ratePer100: 146000 }), at);
  const stale = () => app(`select used_rate || '>' || day_rate from payments_at_old_rate where entry_id = ${lit(payment)};`);
  assert.equal(stale(), "");
  set(147000);
  assert.equal(stale(), "146000>147000");
  assert.equal(customerBalance(customer), -10000n);
  // It is fixed the only way anything is fixed: reversed and entered again.
  app(`select gs_reverse_entry(${lit(payment)}, ${lit(USER)}, 'Rate was changed', ${lit(randomUUID())});`);
  post(officePayment({ customerId: customer, received: iqd(146000), ratePer100: 147000 }), at);
  assert.equal(stale(), "");
  assert.equal(customerBalance(customer), -9932n); // 146,000 IQD at 1,470 is $99.32
});

test("every payment can be read back with how it was paid", () => {
  setRate("2026-12-01", 145000);
  const customer = newCustomer();
  const { consignmentId } = charge(customer, 30000n, new Date("2026-12-01T05:00:00Z"));
  const round = roundOut([consignmentId]);
  enterResult({ roundId: round, consignmentId, outcome: "paid", received: { amount: 123250, currency: "IQD" }, at: DAY });
  const office = post(officePayment({ customerId: customer, received: usd(5000) }), DAY);
  post(walletPayment({ customerId: customer, wallet: "fastpay", received: usd(2500) }), DAY);
  app(`select gs_reverse_entry(${lit(office)}, ${lit(USER)}, 'Typed twice', ${lit(randomUUID())});`);
  app(`insert into attachments (entry_id, kind, storage_key, uploaded_by) values (${lit(office)}, 'payment_receipt', ${lit(`receipts/${office}.jpg`)}, ${lit(USER)});`);
  refused(() => app(`insert into attachments (kind, storage_key, uploaded_by) values ('payment_receipt', ${lit(randomUUID())}, ${lit(USER)});`), /attachments_belongs_somewhere/);

  assert.equal(
    app(`select string_agg(method || ' ' || received_amount || ' ' || received_currency || ' = ' || credited_usd_cents
                           || coalesce(' at ' || iqd_per_100_usd, '') || case when reversed then ' reversed' else '' end
                           || case when round_id is not null then ' on a round' else '' end
                           || case when paid_for_consignment_id is not null then ' for its consignment' else '' end,
                           ' | ' order by credited_usd_cents)
         from payments where customer_id = ${lit(customer)};`),
    "fastpay 2500 USD = 2500 | office_cash 5000 USD = 5000 reversed | driver_cash 123250 IQD = 8500 at 145000 on a round for its consignment",
  );
});

test("the vault is closed by counting it; expected is the last count plus what was entered since", () => {
  emptyVault(new Date("2026-11-30T12:00:00Z"));
  fundVault(50000n, 1450000n);
  const customer = newCustomer();
  /** expected now, the last close's difference, and ledger + noted gap = expected */
  const status = (currency: "USD" | "IQD") =>
    app(`select expected_now || ',' || last_difference || ',' || (ledger_balance + noted_gap = expected_now)
         from vault_status where currency = ${lit(currency)};`);
  const usdBefore = expected("USD");
  const iqdBefore = expected("IQD");
  const entries = entryCount();

  // A typo cannot become money, and a gap needs a note.
  refused(() => closeVault({ usd: { 300: 1 } }), /note_unknown/);
  const short = notesFor("USD", usdBefore - 5000n);
  const dinars = notesFor("IQD", iqdBefore);
  refused(() => closeVault({ usd: short, iqd: dinars }), /gap_note_required/);
  refused(() => closeVault({ usd: short, iqd: dinars, note: " " }), /gap_note_required/);

  // Monday: $50.00 short. It is recorded with its note; nothing is posted to the ledger.
  const monday = randomUUID();
  closeVault({ id: monday, usd: short, iqd: dinars, note: "A $50 note is missing", at: DAY });
  closeVault({ id: monday, usd: short, iqd: dinars, note: "A $50 note is missing", at: DAY }); // the same request again
  assert.equal(app(`select count(*) from vault_closes where id = ${lit(monday)};`), "1");
  assert.equal(entryCount(), entries);
  assert.equal(
    app(`select usd_counted || '/' || usd_expected || '/' || usd_difference || ' ' || iqd_difference from vault_close_details where close_id = ${lit(monday)};`),
    `${usdBefore - 5000n}/${usdBefore}/-5000 0`,
  );
  // From now on the vault is expected to hold what was counted.
  assert.equal(expected("USD"), usdBefore - 5000n);
  assert.equal(status("USD"), `${usdBefore - 5000n},-5000,true`);
  // A close cannot be slipped in before one that is already there.
  refused(() => closeVault({ usd: short, iqd: dinars, at: new Date("2026-11-30T13:00:00Z") }), /close_out_of_order/);

  // Tuesday: a round is handed in, a customer pays at the office, fuel is paid, dinars are changed.
  const { consignmentId } = charge(customer, 20000n, new Date("2026-12-01T05:00:00Z"));
  const round = roundOut([consignmentId]);
  enterResult({ roundId: round, consignmentId, outcome: "paid", received: { amount: 20000, currency: "USD" }, at: NEXT_DAY });
  assert.equal(expected("USD"), usdBefore - 5000n); // still with the driver
  handIn(round, { usd: { 10000: 2 }, at: NEXT_DAY });
  post(officePayment({ customerId: customer, received: iqd(147000), ratePer100: 147000 }), NEXT_DAY);
  post(cashOut({ category: "fuel_car", amount: iqd(25000), reason: "Fuel" }), NEXT_DAY);
  post(currencyExchange({ iqdGiven: 147000n, usdCentsReceived: 10000n }), NEXT_DAY);
  post(sentToChina({ amountUsdCents: 15000n }), NEXT_DAY);
  // Last count + hand-in - sent to China + exchange; last count + office payment - cash out - exchange.
  assert.equal(expected("USD"), usdBefore - 5000n + 20000n - 15000n + 10000n);
  assert.equal(expected("IQD"), iqdBefore + 147000n - 25000n - 147000n);
  // A wallet payment never touches the vault.
  post(walletPayment({ customerId: customer, wallet: "fib", received: usd(4000) }), NEXT_DAY);
  assert.equal(expected("USD"), usdBefore + 10000n);

  // He finds the $50.00 note: counted is $50.00 over, and the two gaps cancel out.
  const tuesday = closeVault({
    usd: notesFor("USD", usdBefore + 15000n),
    iqd: notesFor("IQD", iqdBefore - 25000n),
    note: "Found the $50 note behind the drawer",
    at: NEXT_DAY,
  });
  assert.equal(
    app(`select day || ' ' || usd_difference || ' ' || iqd_difference from vault_close_details where close_id = ${lit(tuesday)};`),
    "2026-12-02 5000 0",
  );
  assert.equal(status("USD"), `${usdBefore + 15000n},5000,true`);
  assert.equal(status("IQD"), `${iqdBefore - 25000n},0,true`);

  // A count is never edited. The latest one can be taken back; an older one cannot.
  refused(() => owner(`update cash_counts set counted = 1 where vault_close_id = ${lit(tuesday)};`), /ledger_immutable/);
  refused(() => app(`update vault_closes set note = 'x' where id = ${lit(tuesday)};`), /permission denied/);
  refused(() => app(`select gs_void_vault_close(${lit(monday)}, ${lit(USER)}, 'oops');`), /close_not_latest/);
  refused(() => app(`select gs_void_vault_close(${lit(tuesday)}, ${lit(USER)}, '');`), /reason_required/);
  app(`select gs_void_vault_close(${lit(tuesday)}, ${lit(USER)}, 'Counted the wrong drawer');`);
  app(`select gs_void_vault_close(${lit(tuesday)}, ${lit(USER)}, 'again');`); // already taken back: does nothing
  assert.equal(expected("USD"), usdBefore + 10000n); // back to Monday's count plus Tuesday's entries
  closeVault({ usd: notesFor("USD", usdBefore + 15000n), iqd: notesFor("IQD", iqdBefore - 25000n), note: "Found the $50 note", at: NEXT_DAY });
  assert.equal(expected("USD"), usdBefore + 15000n);
  assert.equal(health(), "");
});

test("two closes at the same moment never count against the same expected amount", async () => {
  emptyVault();
  fundVault(10000n, 0n);
  const run = (sql: string) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", APP]);
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))));
      child.stdin.end(sql);
    });
  // Both count the box as $50.00 short of what is expected now, in transactions that overlap.
  const before = expected("USD");
  const at = nextCloseTime();
  const ids = [randomUUID(), randomUUID()];
  const sql = (id: string) =>
    `begin;\n${closeSql({ id, usd: notesFor("USD", before - 5000n), note: "Short", at })}\nselect pg_sleep(0.3) is null;\ncommit;`;
  await Promise.all(ids.map((id) => run(sql(id))));
  // The second close was measured against the first one's count, so the gap is noted once, not twice.
  assert.equal(expected("USD"), before - 5000n);
  assert.equal(
    app(`select string_agg(usd_difference::text, ',' order by usd_difference) from vault_close_details where close_id in (${ids.map(lit).join(", ")});`),
    "-5000,0",
  );
});

test("the China account shows what is owed and what was sent, by day", () => {
  const before = app("select owed_usd_cents || ',' || charged_usd_cents || ',' || sent_usd_cents from china_account_summary;").split(",").map(BigInt) as [bigint, bigint, bigint];
  const a = newCustomer("A");
  const b = newCustomer("B");
  // Days of their own, later than anything else in the tests.
  const d1 = new Date("2027-01-10T09:00:00Z");
  const d2 = new Date("2027-01-11T09:00:00Z");
  const first = charge(a, 8500n, d1);
  charge(b, 31000n, d1);
  charge(b, 0n, d1); // prepaid: nothing owed to China for it
  fundVault(100000n, 0n);
  post(sentToChina({ amountUsdCents: 20000n }), d2);
  const wrong = post(sentToChina({ amountUsdCents: 7000n }), d2);
  app(`select gs_reverse_entry(${lit(wrong)}, ${lit(USER)}, 'Was not sent', ${lit(randomUUID())}, ${lit(d2.toISOString())});`);
  // A wrong charge is fixed by its consignment: it comes off what is owed to China too.
  app(`select gs_correct_consignment(${lit(first.consignmentId)}, 5800, 0, ${lit(USER)}, 'China confirmed 58');`);

  const after = app("select owed_usd_cents || ',' || charged_usd_cents || ',' || sent_usd_cents from china_account_summary;").split(",").map(BigInt) as [bigint, bigint, bigint];
  assert.deepEqual(
    [after[0] - before[0], after[1] - before[1], after[2] - before[2]],
    [5800n + 31000n - 20000n, 5800n + 31000n, 20000n],
  );
  // What we owe is the other side of the ledger's account.
  assert.equal(after[0], -(balances().get("china_payable") ?? 0n));
  // By day. The correction's reversal is dated the day it was made, so the file's own day keeps both charges.
  assert.equal(
    app("select string_agg(day || ' +' || charged_usd_cents || ' -' || sent_usd_cents, ' | ' order by day) from china_account_by_day where day >= '2027-01-10';"),
    "2027-01-10 +45300 -0 | 2027-01-11 +0 -20000",
  );
  const last = app("select owed_after_usd_cents from china_account_by_day order by day desc limit 1;");
  assert.equal(BigInt(last), after[0]);
  assert.equal(
    app(`select string_agg(shipment_code is not null || ':' || owed_change_usd_cents, ' ' order by happened_at, owed_change_usd_cents)
         from china_account where customer_id = ${lit(a)};`),
    "true:-8500 true:5800 true:8500",
  );

  // The money screen lists what left the vault, China included.
  assert.equal(
    app("select string_agg(category || ' ' || amount || ' ' || currency || case when reversed then ' reversed' else '' end, ' | ' order by amount) from cash_outs where day = '2027-01-11';"),
    "china 7000 USD reversed | china 20000 USD",
  );
  assert.equal(health(), "");
});

test("random days at the office: expected cash is always the last count plus what was entered since", () => {
  let seed = 20261201;
  const next = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) >>> 12) % n; // the high bits are the random ones
  emptyVault();
  fundVault(2000000n, 30000000n);

  // The box: what is physically in the vault. Entries move it; so does a note going missing.
  let boxUsd = expected("USD");
  let boxIqd = expected("IQD");
  // What the system should expect: the last count plus every entry since.
  let shouldExpectUsd = boxUsd;
  let shouldExpectIqd = boxIqd;
  const move = (usdCents: bigint, dinars: bigint) => {
    boxUsd += usdCents;
    boxIqd += dinars;
    shouldExpectUsd += usdCents;
    shouldExpectIqd += dinars;
  };
  const customer = newCustomer("Random office");
  let closes = 0;
  let gaps = 0;

  for (let step = 0; step < 70; step++) {
    const cents = BigInt((next(200) + 1) * 100);
    const dinars = BigInt((next(400) + 1) * 250);
    switch (next(8)) {
      case 0:
        post(officePayment({ customerId: customer, received: usd(cents) }), DAY);
        move(cents, 0n);
        break;
      case 1:
        post(officePayment({ customerId: customer, received: iqd(dinars), ratePer100: 145000 }), DAY);
        move(0n, dinars);
        break;
      case 2:
        post(cashOut({ category: "other", amount: usd(cents), reason: "Random" }), DAY);
        move(-cents, 0n);
        break;
      case 3:
        post(cashOut({ category: "driver_pay", amount: iqd(dinars), reason: "Random" }), DAY);
        move(0n, -dinars);
        break;
      case 4:
        post(sentToChina({ amountUsdCents: cents }), DAY);
        move(-cents, 0n);
        break;
      case 5:
        post(currencyExchange({ iqdGiven: dinars, usdCentsReceived: cents }), DAY);
        move(cents, -dinars);
        break;
      case 6:
        post(currencyExchangeToDinars({ usdCentsGiven: cents, iqdReceived: dinars }), DAY);
        move(-cents, dinars);
        break;
      case 7: {
        // Close. Every other time a $50 note has gone missing from the box, or an extra one turned up.
        if (closes % 2 === 1) boxUsd += next(2) === 0 ? -5000n : 5000n;
        assert.equal(expected("USD"), shouldExpectUsd);
        assert.equal(expected("IQD"), shouldExpectIqd);
        const gap = boxUsd !== shouldExpectUsd;
        closeVault({ usd: notesFor("USD", boxUsd), iqd: notesFor("IQD", boxIqd), ...(gap ? { note: "Random gap" } : {}) });
        closes += 1;
        if (gap) gaps += 1;
        // From here on the system expects what was counted.
        shouldExpectUsd = boxUsd;
        break;
      }
    }
  }
  assert.equal(expected("USD"), shouldExpectUsd);
  assert.equal(expected("IQD"), shouldExpectIqd);
  assert.ok(closes >= 5 && gaps >= 2, `expected several closes with gaps, got ${closes} closes and ${gaps} gaps`);
  assert.equal(health(), "");
});
