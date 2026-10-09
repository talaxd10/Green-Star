// Dinar rounding and the Error entry, proven against a real Postgres: dinars
// that come to what is owed settle it, nothing else is rounded, and what
// rounding gave or took is on the books.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dinarCredit, errorCorrection, iqd, iqdToUsdCents, officePayment, usd, usdCentsToIqd, walletPayment, type EntryDraft } from "@green-star/domain";
import { lit, renderPost } from "../src/index.ts";
import { USER, app, appAs, appNoActor, charge, customerBalance, health, newCeo, newCustomer, owner, post, refused, retire, setRate, switchedOff } from "./helpers.ts";

// These tests keep to their own days, so no other test file changes their rates.
const RATE = 157000;                       // 1,570 per dollar: the CEO's example
setRate("2027-02-03", RATE);
const at = (hour = 9, day = 3) => new Date(Date.UTC(2027, 1, day, hour));

/** What is on one of the fixed accounts. */
const on = (code: string) => BigInt(app(`select coalesce((select balance from account_overview where code = ${lit(code)}), 0);`));
const remaining = (consignmentId: string) => BigInt(app(`select remaining_usd_cents from consignment_money where consignment_id = ${lit(consignmentId)};`));

/** Posts a payment for one consignment. */
const postFor = (draft: EntryDraft, consignmentId: string, when = at()) =>
  app(renderPost(draft, { happenedAt: when, createdBy: USER, idempotencyKey: randomUUID(), forConsignment: consignmentId }));

/** A dinar payment at the office, credited as given. */
const dinars = (customerId: string, amount: bigint, creditUsdCents?: bigint, rate = RATE) =>
  officePayment({ customerId, received: iqd(amount), ratePer100: rate, ...(creditUsdCents === undefined ? {} : { rounding: { creditUsdCents } }) });

/**
 * An entry posted line by line, the way a broken or dishonest application
 * could send it: nothing but the database stands in the way.
 */
function raw(kind: string, lines: readonly (readonly [string, "USD" | "IQD", bigint])[], rate: number | null = null, when = at()): string {
  const account = (ref: string) => (ref.includes("-") ? `gs_customer_account(${lit(ref)}::uuid)` : `gs_account(${lit(ref)})`);
  const built = lines.map(([ref, currency, amount]) => `jsonb_build_object('account_id', ${account(ref)}, 'currency', ${lit(currency)}, 'amount', ${amount})`).join(", ");
  return `select gs_post_entry(${lit(kind)}::entry_kind, ${lit(when.toISOString())}::timestamptz, ${lit(USER)}, ${lit(randomUUID())}, jsonb_build_array(${built}), 'sent by hand', ${rate ?? "null"});`;
}

test("the CEO's example: he owes $533, pays $400 in dollars and 209,000 IQD, and owes nothing", () => {
  const customer = newCustomer("Mixed Payer");
  const { consignmentId } = charge(customer, 53300n, at(5));
  const before = { rounding: on("dinar_rounding_usd"), iqd: on("vault_iqd"), usd: on("vault_usd"), clearing: on("exchange_clearing_usd") };

  post(officePayment({ customerId: customer, received: usd(40000n) }), at());
  assert.equal(customerBalance(customer), 13300n);
  // 133 x 1,570 = 208,810. He hands over 209,000.
  assert.equal(usdCentsToIqd(13300n, RATE), 208810n);
  const entry = post(dinars(customer, 209000n, 13300n), at());

  assert.equal(customerBalance(customer), 0n);
  assert.equal(remaining(consignmentId), 0n);
  assert.equal(on("vault_usd") - before.usd, 40000n);
  assert.equal(on("vault_iqd") - before.iqd, 209000n, "every dinar he handed over is in the vault");
  assert.equal(on("exchange_clearing_usd") - before.clearing, 13312n, "and passed through at exactly what it is worth");
  assert.equal(on("dinar_rounding_usd") - before.rounding, -12n, "the 12 cents are on the rounding account");
  assert.equal(
    app(`select method || '|' || received_amount || '|' || received_currency || '|' || iqd_per_100_usd || '|' || credited_usd_cents from payments where entry_id = ${lit(entry)};`),
    "office_cash|209000|IQD|157000|13300",
  );
  assert.equal(app(`select gained_usd_cents || '|' || reversed from dinar_rounding where entry_id = ${lit(entry)};`), "12|false");
  assert.equal(health(), "");
});

test("dinars a little short settle it too, and the exact amount needs no rounding at all", () => {
  const short = newCustomer("Short By 500");
  charge(short, 13300n, at(5));
  const rounding = on("dinar_rounding_usd");
  post(dinars(short, 208310n, 13300n), at());          // 500 dinars under: worth $132.68
  assert.equal(customerBalance(short), 0n);
  assert.equal(on("dinar_rounding_usd") - rounding, 32n, "rounding took 32 cents");

  const exact = newCustomer("To The Dinar");
  charge(exact, 13300n, at(5));
  const entry = post(dinars(exact, 208810n), at());
  assert.equal(customerBalance(exact), 0n);
  assert.equal(app(`select count(*) from dinar_rounding where entry_id = ${lit(entry)};`), "0");

  // Not asked to round, the same 209,000 is worth what it converts to, and the 12 cents are his credit.
  const plain = newCustomer("Not Rounded");
  charge(plain, 13300n, at(5));
  post(dinars(plain, 209000n), at());
  assert.equal(customerBalance(plain), -12n);
  assert.equal(health(), "");
});

test("the arithmetic in the database is the arithmetic in the app", () => {
  let seed = 11;
  const next = (max: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed >>> 12) % max;
  };
  const rows: string[] = [];
  const expected: string[] = [];
  let settled = 0;
  const either = [0, 0];
  for (let run = 0; run < 1200; run += 1) {
    const rate = 130000 + next(30000);
    const first = BigInt(next(4) === 0 ? 0 : 1 + next(200000));
    // Often only a few cents more than the goods: then the dinars can settle either, and the nearer one wins.
    const all = first + BigInt(next(3) === 0 ? 0 : next(2) === 0 ? 1 + next(60) : 1 + next(200000));
    const target = next(3) === 0 ? all : first;
    const amount = next(2) === 0 ? usdCentsToIqd(target, rate) - 700n + BigInt(next(1400)) : BigInt(250 * (1 + next(3000)));
    if (amount <= 0n) continue;
    rows.push(`(${rows.length}, ${amount}::bigint, ${rate}, ${first}::bigint, ${all}::bigint)`);
    const credit = dinarCredit(amount, rate, [first, all]);
    if (credit !== iqdToUsdCents(amount, rate)) settled += 1;
    if (dinarCredit(amount, rate, [first]) === first && dinarCredit(amount, rate, [all]) === all && first !== all && first > 0n) either[credit === first ? 0 : 1] = (either[credit === first ? 0 : 1] as number) + 1;
    expected.push(`${credit}|${usdCentsToIqd(first, rate)}`);
  }
  assert.ok(settled > 50 && settled < rows.length - 50, `${settled} of ${rows.length} settled`);
  assert.ok((either[0] as number) >= 5 && (either[1] as number) >= 5, `could settle either: ${either[0]} went to the goods, ${either[1]} to everything`);
  const got = app(
    `select gs_dinar_credit(d, r, f, a) || '|' || gs_usd_cents_to_iqd(f, r)
     from (values ${rows.join(", ")}) as t (n, d, r, f, a) order by n;`,
  ).split("\n");
  assert.deepEqual(got, expected);
});

test("dinars are rounded only when they settle what is owed", () => {
  // He owes more than the dinars come to: a part payment is exact.
  const owesMore = newCustomer("Owes More");
  charge(owesMore, 20000n, at(5));
  refused(() => post(dinars(owesMore, 209000n, 13300n), at()), /rounding_invalid: dinars are rounded only when they settle what is owed/);
  // A little more than they come to: not settled either.
  const nearly = newCustomer("Nearly");
  charge(nearly, 13350n, at(5));
  refused(() => post(dinars(nearly, 209000n, 13300n), at()), /rounding_invalid/);
  // He owes nothing: there is nothing to settle.
  const nothing = newCustomer("Owes Nothing");
  refused(() => post(dinars(nothing, 209000n, 13300n), at()), /rounding_invalid/);
  for (const customer of [owesMore, nearly, nothing]) {
    assert.equal(app(`select count(*) from payments where customer_id = ${lit(customer)};`), "0", "a refused payment leaves nothing");
  }

  // Everything he owes, over two files.
  const two = newCustomer("Two Files");
  const a = charge(two, 6000n, at(4)).consignmentId;
  const b = charge(two, 7300n, at(5)).consignmentId;
  post(dinars(two, 209000n, 13300n), at());
  assert.deepEqual([customerBalance(two), remaining(a), remaining(b)], [0n, 0n, 0n]);

  // Or the one consignment the money is for, while an older one stays owed.
  const older = newCustomer("Older Stays");
  const old = charge(older, 6700n, at(4)).consignmentId;
  const now = charge(older, 13300n, at(5)).consignmentId;
  refused(() => post(dinars(older, 209000n, 13300n), at()), /rounding_invalid/);      // not said what it is for
  refused(() => postFor(dinars(older, 209000n, 13300n), old), /rounding_invalid/);    // for the wrong one
  postFor(dinars(older, 209000n, 13300n), now);
  assert.deepEqual([customerBalance(older), remaining(old), remaining(now)], [6700n, 6700n, 0n]);
  assert.equal(health(), "");
});

test("dinars that could settle the goods or everything settle the nearer one, at the door and at the office", () => {
  // $62.00 on today's goods and 30 cents left from an older file. At 1,570: $62.00 is 97,340 IQD, $62.30 is 97,811.
  const owing = (name: string) => {
    const customer = newCustomer(name);
    const older = charge(customer, 30n, at(4)).consignmentId;
    const today = charge(customer, 6200n, at(5)).consignmentId;
    return { customer, older, today };
  };
  assert.deepEqual([usdCentsToIqd(6200n, RATE), usdCentsToIqd(6230n, RATE)], [97340n, 97811n]);

  // 97,700 IQD: 111 from everything, 360 from the goods. Everything is settled.
  const all = owing("Nearer Everything");
  postFor(dinars(all.customer, 97700n, 6230n), all.today);
  assert.deepEqual([customerBalance(all.customer), remaining(all.today), remaining(all.older)], [0n, 0n, 0n]);

  // 97,400 IQD: 60 from the goods, 411 from everything. The goods are settled and the 30 cents stay owed.
  const goods = owing("Nearer Goods");
  postFor(dinars(goods.customer, 97400n, 6200n), goods.today);
  assert.deepEqual([customerBalance(goods.customer), remaining(goods.today), remaining(goods.older)], [30n, 0n, 30n]);

  // The database picks the same way the app does.
  assert.equal(app(`select gs_dinar_credit(97700, ${RATE}, 6200, 6230) || ' ' || gs_dinar_credit(97400, ${RATE}, 6200, 6230) || ' ' || gs_dinar_credit(97575, ${RATE}, 6200, 6230);`), "6230 6200 6200");
  assert.deepEqual([dinarCredit(97700n, RATE, [6200n, 6230n]), dinarCredit(97400n, RATE, [6200n, 6230n]), dinarCredit(97575n, RATE, [6200n, 6230n])], [6230n, 6200n, 6200n]);
  // Exactly as near to both (97,340 and 97,654 for $62.20: 97,497 is 157 from each): everything.
  assert.equal(usdCentsToIqd(6220n, RATE), 97654n);
  assert.equal(app(`select gs_dinar_credit(97497, ${RATE}, 6200, 6220);`), "6220");
  assert.equal(dinarCredit(97497n, RATE, [6200n, 6220n]), 6220n);
  assert.equal(health(), "");
});

test("whatever the application sends, rounding stays inside half a step and inside dinar payments", () => {
  const customer = newCustomer("Attacked");
  charge(customer, 13300n, at(5));

  // A thousand dinars short, credited in full: more than half a step.
  refused(
    () => app(raw("office_payment", [["vault_iqd", "IQD", 208000n], ["exchange_clearing_iqd", "IQD", -208000n], ["exchange_clearing_usd", "USD", 13248n], [customer, "USD", -13300n], ["dinar_rounding_usd", "USD", 52n]], RATE)),
    /rounding_too_large/,
  );
  // The dinars do not pass through at what they are worth: the old rule still stands.
  refused(
    () => app(raw("office_payment", [["vault_iqd", "IQD", 209000n], ["exchange_clearing_iqd", "IQD", -209000n], ["exchange_clearing_usd", "USD", 13300n], [customer, "USD", -13300n]], RATE)),
    /conversion_mismatch/,
  );
  // Dollars are never rounded.
  refused(() => app(raw("office_payment", [["vault_usd", "USD", 13288n], [customer, "USD", -13300n], ["dinar_rounding_usd", "USD", 12n]])), /rounding_invalid: only a payment in dinars is rounded/);
  refused(() => app(raw("wallet_payment", [["wallet_fib_usd", "USD", 13312n], [customer, "USD", -13300n], ["dinar_rounding_usd", "USD", -12n]])), /rounding_invalid/);
  // A payment cannot reach the errors account, and nothing else reaches either.
  refused(
    () => app(raw("office_payment", [["vault_iqd", "IQD", 209000n], ["exchange_clearing_iqd", "IQD", -209000n], ["exchange_clearing_usd", "USD", 13312n], [customer, "USD", -13300n], ["errors_usd", "USD", -12n]], RATE)),
    /entry_shape: a office_payment entry cannot move the errors_usd account/,
  );
  refused(() => app(raw("cash_out", [["dinar_rounding_usd", "USD", 5000n], ["vault_usd", "USD", -5000n]])), /entry_shape/);
  refused(() => app(raw("sent_to_china", [["china_payable", "USD", 5000n], ["errors_usd", "USD", -5000n]])), /entry_shape/);
  refused(() => app(raw("currency_exchange", [["vault_usd", "USD", 5000n], ["dinar_rounding_usd", "USD", -5000n]])), /entry_shape/);
  // The application cannot write the two accounts' balances either.
  refused(() => app("update account_balances set balance = 0 where account_id = gs_account('dinar_rounding_usd');"), /permission denied/);

  assert.equal(customerBalance(customer), 13300n);
  // The honest one goes through.
  app(raw("office_payment", [["vault_iqd", "IQD", 209000n], ["exchange_clearing_iqd", "IQD", -209000n], ["exchange_clearing_usd", "USD", 13312n], [customer, "USD", -13300n], ["dinar_rounding_usd", "USD", -12n]], RATE));
  assert.equal(customerBalance(customer), 0n);
  assert.equal(health(), "");
});

test("the rounding step is in Settings: a smaller one settles less, and 0 switches rounding off", () => {
  assert.equal(app("select dinar_rounding_iqd from settings;"), "1000");
  refused(() => app("update settings set dinar_rounding_iqd = -1;"), /settings_dinar_rounding/);
  refused(() => app("update settings set dinar_rounding_iqd = 10001;"), /settings_dinar_rounding/);
  refused(() => app("update settings set dinar_rounding_iqd = null;"), /null value/);
  refused(() => appNoActor("update settings set dinar_rounding_iqd = 250;"), /actor_required/);
  refused(() => appAs(switchedOff())("update settings set dinar_rounding_iqd = 250;"), /actor_unknown/);
  assert.equal(app("select dinar_rounding_iqd from settings;"), "1000");

  const customer = newCustomer("Step Of 250");
  charge(customer, 13300n, at(5));
  try {
    app("update settings set dinar_rounding_iqd = 250;");
    assert.equal(
      app("select actor || '|' || (before ->> 'dinar_rounding_iqd') || '|' || (after ->> 'dinar_rounding_iqd') from audit_log where entity = 'settings' order by id desc limit 1;"),
      `${USER}|1000|250`,
    );
    // 209,000 is 190 over: more than 125.
    assert.equal(app(`select gs_dinar_credit(209000, ${RATE}, 13300, 13300);`), "13312");
    refused(() => post(dinars(customer, 209000n, 13300n), at()), /rounding_too_large/);
    assert.equal(app(`select gs_dinar_credit(208750, ${RATE}, 13300, 13300);`), "13300");

    app("update settings set dinar_rounding_iqd = 0;");
    assert.equal(app(`select gs_dinar_credit(208750, ${RATE}, 13300, 13300);`), "13296");
    refused(() => post(dinars(customer, 208750n, 13300n), at()), /rounding_too_large/);
    assert.equal(app(`select gs_dinar_credit(208810, ${RATE}, 13300, 13300);`), "13300", "the exact amount is still the exact amount");
  } finally {
    app("update settings set dinar_rounding_iqd = 1000;");
  }
  post(dinars(customer, 209000n, 13300n), at());
  assert.equal(customerBalance(customer), 0n);
});

test("a rounded payment is reversed like any other, and its rounding goes with it", () => {
  const customer = newCustomer("Reversed Rounding");
  const { consignmentId } = charge(customer, 13300n, at(5));
  const before = { rounding: on("dinar_rounding_usd"), iqd: on("vault_iqd") };
  const entry = post(dinars(customer, 209000n, 13300n), at());
  assert.equal(on("dinar_rounding_usd") - before.rounding, -12n);

  app(`select gs_reverse_entry(${lit(entry)}, ${lit(USER)}, 'Typed for the wrong customer', ${lit(randomUUID())}, ${lit(at(10).toISOString())});`);
  assert.deepEqual([customerBalance(customer), remaining(consignmentId)], [13300n, 13300n]);
  assert.equal(on("dinar_rounding_usd"), before.rounding);
  assert.equal(on("vault_iqd"), before.iqd);
  assert.equal(app(`select reversed from dinar_rounding where entry_id = ${lit(entry)};`), "t");
  assert.equal(health(), "");

  // And he can pay again.
  post(dinars(customer, 208500n, 13300n), at(11));
  assert.equal(customerBalance(customer), 0n);
});

test("a wallet payment in dinars is rounded the same way", () => {
  const customer = newCustomer("FIB In Dinars");
  charge(customer, 13300n, at(5));
  const wallet = on("wallet_fib_iqd");
  post(walletPayment({ customerId: customer, wallet: "fib", received: iqd(209000n), ratePer100: RATE, rounding: { creditUsdCents: 13300n } }), at());
  assert.equal(customerBalance(customer), 0n);
  assert.equal(on("wallet_fib_iqd") - wallet, 209000n);
});

test("an Error entry takes a small amount off what he owes, and closes his file like a payment", () => {
  const customer = newCustomer("Five Dollars Short");
  const { consignmentId } = charge(customer, 53300n, at(5));
  post(officePayment({ customerId: customer, received: usd(52800n) }), at());
  assert.deepEqual([customerBalance(customer), remaining(consignmentId)], [500n, 500n]);
  const errors = on("errors_usd");
  const cash = { usd: on("vault_usd"), iqd: on("vault_iqd") };

  const entry = post(errorCorrection({ customerId: customer, amountUsdCents: 500n, reason: "Short at the door, let go" }), at(10));
  assert.deepEqual([customerBalance(customer), remaining(consignmentId)], [0n, 0n]);
  assert.equal(on("errors_usd") - errors, 500n, "what was let go is on the errors account");
  assert.deepEqual([on("vault_usd"), on("vault_iqd")], [cash.usd, cash.iqd], "no money moved");
  assert.equal(
    app(`select customer_name || '|' || amount_usd_cents || '|' || note || '|' || reversed || '|' || created_by from error_entries where entry_id = ${lit(entry)};`),
    `Five Dollars Short|500|Short at the door, let go|false|${USER}`,
  );
  assert.equal(app(`select kind || '|' || credit_usd_cents || '|' || allocated_usd_cents from customer_payments where entry_id = ${lit(entry)};`), "error_correction|500|500");
  // It is not a payment: it is not on the list of money that came in.
  assert.equal(app(`select count(*) from payments where entry_id = ${lit(entry)};`), "0");
  // His statement shows it as its own line and ends on nothing owed.
  assert.equal(
    app(`select string_agg(what || ':' || change_usd_cents || ':' || balance_after_usd_cents, ' ' order by line_no) from gs_customer_statement(${lit(customer)});`),
    "file_confirmed:53300:53300 office_payment:-52800:500 error_correction:-500:0",
  );
  assert.equal(health(), "");

  // Reversed like any other entry: he owes the $5 again.
  app(`select gs_reverse_entry(${lit(entry)}, ${lit(USER)}, 'He paid it after all', ${lit(randomUUID())}, ${lit(at(11).toISOString())});`);
  assert.deepEqual([customerBalance(customer), remaining(consignmentId)], [500n, 500n]);
  assert.equal(on("errors_usd"), errors);
  assert.equal(app(`select reversed from error_entries where entry_id = ${lit(entry)};`), "t");
  assert.equal(health(), "");
});

test("an Error entry has no limit, and never takes off more than he owes", () => {
  const customer = newCustomer("Owes Two Hundred");
  charge(customer, 20000n, at(5));
  // $150 at once: there is no limit any more (the CEO, October 2026).
  post(errorCorrection({ customerId: customer, amountUsdCents: 15000n }), at());
  post(errorCorrection({ customerId: customer, amountUsdCents: 3000n }), at());
  assert.equal(customerBalance(customer), 2000n);
  // He owes $20.00 now: $30.00 cannot come off. That would be credit for money that never came.
  refused(() => post(errorCorrection({ customerId: customer, amountUsdCents: 3000n }), at()), /error_more_than_owed: he owes \$20\.00/);
  post(errorCorrection({ customerId: customer, amountUsdCents: 2000n }), at());
  assert.equal(customerBalance(customer), 0n);
  refused(() => post(errorCorrection({ customerId: customer, amountUsdCents: 1n }), at()), /error_more_than_owed/);

  // A customer who owes nothing, or is in credit, has nothing to take off.
  const paidUp = newCustomer("In Credit");
  post(officePayment({ customerId: paidUp, received: usd(5000n) }), at());
  refused(() => post(errorCorrection({ customerId: paidUp, amountUsdCents: 100n }), at()), /error_more_than_owed/);
  assert.equal(customerBalance(paidUp), -5000n);

  // It does not move money or touch two customers, and adding needs a consignment.
  const other = newCustomer("Other");
  charge(other, 1000n, at(5));
  refused(() => app(raw("error_correction", [[other, "USD", 100n], ["errors_usd", "USD", -100n]])), /error_needs_consignment/);
  refused(() => app(raw("error_correction", [["vault_usd", "USD", 100n], [other, "USD", -100n]])), /entry_shape/);
  refused(() => app(raw("error_correction", [["dinar_rounding_usd", "USD", 100n], [other, "USD", -100n]])), /entry_shape: a error_correction entry cannot move the dinar_rounding_usd account/);
  const third = newCustomer("Third");
  charge(third, 1000n, at(5));
  refused(() => app(raw("error_correction", [["errors_usd", "USD", 200n], [other, "USD", -100n], [third, "USD", -100n]])), /entry_shape: a error_correction entry is for one customer/);
  refused(() => app(raw("error_correction", [["errors_usd", "USD", 100n], ["china_payable", "USD", -100n]])), /entry_shape/);
  assert.deepEqual([customerBalance(other), customerBalance(third)], [1000n, 1000n]);
  assert.equal(health(), "");
});

test("an Error entry adds to what he owes, onto one of his consignments, and payments pay it", () => {
  const customer = newCustomer("Charged Too Little");
  const first = charge(customer, 10000n, at(4)).consignmentId;
  const second = charge(customer, 20000n, at(5)).consignmentId;
  const errors = on("errors_usd");

  // $12.50 too little on the second file.
  const added = postFor(errorCorrection({ customerId: customer, amountUsdCents: 1250n, add: true, reason: "Forgot the extra carton" }), second);
  assert.equal(customerBalance(customer), 31250n);
  assert.deepEqual([remaining(first), remaining(second)], [10000n, 21250n], "it is owed on the consignment it was added to");
  assert.equal(on("errors_usd") - errors, -1250n);
  assert.equal(
    app(`select amount_usd_cents || '|' || added || '|' || consignment_id || '|' || note from error_entries where entry_id = ${lit(added)};`),
    `1250|true|${second}|Forgot the extra carton`,
  );
  assert.equal(app(`select errors_added_usd_cents from consignment_details where consignment_id = ${lit(second)};`), "1250");
  assert.equal(app(`select count(*) from customer_payments where entry_id = ${lit(added)};`), "0", "what is added is owed, not paid");
  assert.equal(health(), "");

  // Payments pay it the usual way, oldest first.
  post(officePayment({ customerId: customer, received: usd(31250n) }), at(10));
  assert.deepEqual([customerBalance(customer), remaining(first), remaining(second)], [0n, 0n, 0n]);
  assert.equal(
    app(`select string_agg(what || ':' || change_usd_cents, ' ' order by line_no) from gs_customer_statement(${lit(customer)});`),
    "file_confirmed:10000 file_confirmed:20000 error_correction:1250 office_payment:-31250",
  );
  assert.equal(health(), "");

  // Reversed, he is $12.50 in credit.
  app(`select gs_reverse_entry(${lit(added)}, ${lit(USER)}, 'Typed on the wrong customer', ${lit(randomUUID())}, ${lit(at(11).toISOString())});`);
  assert.equal(customerBalance(customer), -1250n);
  assert.deepEqual([remaining(second), on("errors_usd")], [0n, errors]);
  assert.equal(health(), "");
});

test("an Error that was added and paid, then reversed: the money that paid it goes to his next file", () => {
  const customer = newCustomer("Paid The Error");
  const first = charge(customer, 10000n, at(4)).consignmentId;
  const second = charge(customer, 20000n, at(5)).consignmentId;
  const added = postFor(errorCorrection({ customerId: customer, amountUsdCents: 5000n, add: true }), first);
  post(officePayment({ customerId: customer, received: usd(15000n) }), at(10));
  assert.deepEqual([remaining(first), remaining(second)], [0n, 20000n]);

  app(`select gs_reverse_entry(${lit(added)}, ${lit(USER)}, 'Was right the first time', ${lit(randomUUID())}, ${lit(at(11).toISOString())});`);
  assert.deepEqual([customerBalance(customer), remaining(first), remaining(second)], [15000n, 0n, 15000n], "the $50 that paid the Error now pays the second file");
  assert.equal(app(`select count(*) from allocation_releases r join allocations a on a.id = r.allocation_id where a.consignment_id = ${lit(first)};`), "1");
  assert.equal(health(), "");
});

test("an Error entry adds only to a live consignment of the same customer, which then is not cancelled on its own", () => {
  const customer = newCustomer("Error On File");
  const mine = charge(customer, 5000n, at(5)).consignmentId;
  const someoneElse = charge(newCustomer("Not Him"), 5000n, at(5)).consignmentId;
  const add = (consignmentId: string) => postFor(errorCorrection({ customerId: customer, amountUsdCents: 700n, add: true }), consignmentId);
  refused(() => add(someoneElse), /target_invalid/);
  refused(() => post(errorCorrection({ customerId: customer, amountUsdCents: 700n, add: true }), at()), /error_needs_consignment/);

  const entry = add(mine);
  refused(() => app(`select gs_cancel_consignment(${lit(mine)}, ${lit(USER)}, 'Wrong customer');`), /consignment_has_error: an Error entry added to this consignment\. Reverse it first\./);

  // Correcting the amount carries the Error over to the replacement.
  const replacement = app(`select gs_correct_consignment(${lit(mine)}, 6000, 0, ${lit(USER)}, 'Price was $60');`);
  assert.equal(customerBalance(customer), 6700n);
  assert.equal(remaining(replacement), 6700n);
  assert.equal(health(), "");

  // Reversed, the replacement can be cancelled; nothing is owed on a cancelled one.
  app(`select gs_reverse_entry(${lit(entry)}, ${lit(USER)}, 'Not an error', ${lit(randomUUID())}, ${lit(at(11).toISOString())});`);
  app(`select gs_cancel_consignment(${lit(replacement)}, ${lit(USER)}, 'Wrong customer');`);
  assert.equal(customerBalance(customer), 0n);
  refused(() => add(replacement), /error_needs_consignment/);
  assert.equal(health(), "");
});

test("there is no Error limit in Settings any more", () => {
  refused(() => app("select error_max_usd_cents from settings;"), /column "error_max_usd_cents" does not exist/);
});

test("an Error entry carries the name of the CEO who is signed in", () => {
  const customer = newCustomer("Whose Error");
  charge(customer, 1000n, at(5));
  const sql = (who: string) => renderPost(errorCorrection({ customerId: customer, amountUsdCents: 100n }), { happenedAt: at(), createdBy: who, idempotencyKey: randomUUID() });
  refused(() => appNoActor(sql(USER)), /actor_required/);
  const off = switchedOff();
  refused(() => appAs(off)(sql(off)), /actor_unknown/);
  const second = newCeo();
  refused(() => appAs(second)(sql(USER)), /actor_mismatch/);
  appAs(second)(sql(second));
  retire(second);
  assert.equal(customerBalance(customer), 900n);
  assert.equal(app(`select created_by from error_entries where customer_id = ${lit(customer)};`), second);
  // Nothing rewrites one or removes it, not even the owner of the database.
  refused(() => owner(`update journal_lines set amount = -1 where entry_id = (select entry_id from error_entries where customer_id = ${lit(customer)}) and amount < 0;`), /ledger_immutable/);
  refused(() => owner(`delete from journal_entries where id = (select entry_id from error_entries where customer_id = ${lit(customer)});`), /ledger_immutable/);
});

test("random charges, payments in both currencies, rounding and errors keep every customer straight", () => {
  setRate("2027-02-04", 147250);
  const rate = 147250;
  let seed = 2027;
  const next = (max: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed >>> 12) % max;
  };
  const customers = Array.from({ length: 6 }, (_, i) => newCustomer(`Random Rounder ${i}`));
  const rounding = on("dinar_rounding_usd");
  const errors = on("errors_usd");
  let expectedRounding = 0n;
  let expectedErrors = 0n;
  const did = { settled: 0, exact: 0, dollars: 0, errors: 0, added: 0, charged: 0 };

  for (let step = 0; step < 90; step += 1) {
    const customer = customers[next(customers.length)] as string;
    const owes = customerBalance(customer);
    const when = at(6 + next(12), 4);
    const what = owes <= 0n ? 0 : next(6);
    if (what === 0) {
      charge(customer, BigInt(1000 + next(90000)), when);
      did.charged += 1;
    } else if (what === 1) {
      post(officePayment({ customerId: customer, received: usd(BigInt(1 + next(Number(owes)))) }), when);
      did.dollars += 1;
    } else if (what === 2 && owes <= 500n) {
      post(errorCorrection({ customerId: customer, amountUsdCents: owes }), when);
      expectedErrors += owes;
      did.errors += 1;
    } else if (what === 2) {
      // Something added: onto his newest consignment still on the books.
      const target = app(`select consignment_id from consignment_money where customer_id = ${lit(customer)} and due_usd_cents > 0 order by consignment_id desc limit 1;`);
      const amount = BigInt(1 + next(2000));
      postFor(errorCorrection({ customerId: customer, amountUsdCents: amount, add: true }), target, when);
      expectedErrors -= amount;
      did.added += 1;
    } else {
      // Dinars: about what he owes rounded to the nearest 1,000 most of the time, any amount otherwise.
      const exactly = usdCentsToIqd(owes, rate);
      const amount = next(3) === 0 ? BigInt(1000 * (1 + next(150))) : ((exactly + 500n) / 1000n) * 1000n + BigInt(1000 * (next(3) - 1)) * BigInt(next(2));
      if (amount <= 0n) continue;
      const credit = dinarCredit(amount, rate, [owes]);
      const worth = iqdToUsdCents(amount, rate);
      post(officePayment({ customerId: customer, received: iqd(amount), ratePer100: rate, rounding: { creditUsdCents: credit } }), when);
      expectedRounding += credit - worth;
      if (credit === worth) did.exact += 1;
      else {
        did.settled += 1;
        assert.equal(customerBalance(customer), 0n, "a rounded payment leaves nothing owed");
      }
    }
  }
  assert.ok(did.settled >= 8 && did.exact >= 5 && did.dollars >= 5 && did.added >= 3 && did.charged >= 10, JSON.stringify(did));
  assert.equal(on("dinar_rounding_usd") - rounding, expectedRounding);
  assert.equal(on("errors_usd") - errors, expectedErrors);
  // Every customer's balance is what his files still need, less his credit.
  for (const customer of customers) {
    const owed = BigInt(app(`select coalesce(sum(remaining_usd_cents), 0) from consignment_money where customer_id = ${lit(customer)};`));
    const credit = BigInt(app(`select coalesce(sum(credit_usd_cents - allocated_usd_cents), 0) from customer_payments where customer_id = ${lit(customer)};`));
    assert.equal(customerBalance(customer), owed - credit);
  }
  assert.equal(health(), "");
});
