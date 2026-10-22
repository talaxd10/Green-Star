// Starting balances, proven against a real Postgres: what a customer owed
// before is paid first, a credit pays his next file, the vault and the China
// account start from what San says, typing one again replaces it, and nobody
// posts or takes one back by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { officePayment, usd } from "@green-star/domain";
import { lit } from "../src/index.ts";
import { USER, app, appAs, appNoActor, charge, customerBalance, health, newCeo, newCustomer, owner, post, refused, retire, switchedOff } from "./helpers.ts";

const at = (day = 1, hour = 9) => new Date(Date.UTC(2027, 2, day, hour));

/** Sets a starting balance the way the API does. */
const startSql = (what: string, amount: bigint | number, customerId: string | null = null, id = randomUUID(), user = USER) =>
  `select gs_set_starting_balance(${lit(id)}, ${lit(user)}, ${lit(what)}, ${amount}, ${customerId === null ? "null" : lit(customerId)}, ${lit(at().toISOString())});`;
const start = (what: string, amount: bigint | number, customerId: string | null = null, id = randomUUID()) => app(startSql(what, amount, customerId, id));

const on = (code: string) => BigInt(app(`select coalesce((select balance from account_overview where code = ${lit(code)}), 0);`));
const standing = (accountSql: string) =>
  app(`select coalesce(string_agg(amount::text, ' '), '') from starting_balances where account_id = ${accountSql};`);
const remaining = (consignmentId: string) => BigInt(app(`select remaining_usd_cents from consignment_money where consignment_id = ${lit(consignmentId)};`));
const startingConsignment = (customerId: string) =>
  app(`select c.id from consignments c join shipments s on s.id = c.shipment_id
       where s.opening and c.customer_id = ${lit(customerId)} and c.status <> 'cancelled';`);

test("what a customer owed before is a file of its own, and his payments pay it first", () => {
  const customer = newCustomer("Owed Before");
  // A file from China confirmed long before the starting balance was typed in:
  // what he owed before still counts as older.
  const { consignmentId: file } = charge(customer, 10000n, new Date("2026-01-05T09:00:00Z"));
  start("customer", 50000n, customer);
  assert.equal(customerBalance(customer), 60000n);
  const before = startingConsignment(customer);
  assert.notEqual(before, "", "the debt from before is a consignment");
  assert.equal(app(`select s.code || '|' || s.status || '|' || s.opening from shipments s where s.opening;`), "Starting balances|confirmed|true");
  assert.equal(app(`select count(*) from journal_entries e join journal_lines l on l.entry_id = e.id where e.kind = 'opening_balance' and l.account_id = gs_account('china_payable');`), "0", "nothing is owed to China for it");

  post(officePayment({ customerId: customer, received: usd(50000n) }), at(3));
  assert.equal(remaining(before), 0n, "the oldest is paid first");
  assert.equal(remaining(file), 10000n);
  assert.equal(customerBalance(customer), 10000n);
  assert.equal(health(), "");
});

test("a credit he had pays his next file", () => {
  const customer = newCustomer("Credit Before");
  start("customer", -20000n, customer);
  assert.equal(customerBalance(customer), -20000n);
  assert.equal(startingConsignment(customer), "", "a credit is not a file");
  const { consignmentId } = charge(customer, 15000n, at(2));
  assert.equal(remaining(consignmentId), 0n);
  assert.equal(customerBalance(customer), -5000n);
  assert.equal(health(), "");
});

test("money he paid before his starting debt was typed in pays it", () => {
  const customer = newCustomer("Paid Ahead");
  post(officePayment({ customerId: customer, received: usd(10000n) }), at(2));
  assert.equal(customerBalance(customer), -10000n);
  start("customer", 50000n, customer);
  assert.equal(customerBalance(customer), 40000n);
  assert.equal(remaining(startingConsignment(customer)), 40000n);
  assert.equal(health(), "");
});

test("typing one again replaces it, the same request again changes nothing, and 0 clears it", () => {
  const customer = newCustomer("Typed Again");
  const account = `gs_customer_account(${lit(customer)})`;
  const first = randomUUID();
  const entry = start("customer", 50000n, customer, first);
  assert.equal(start("customer", 99999n, customer, first), entry, "the same request is the same entry");
  assert.equal(customerBalance(customer), 50000n);
  assert.equal(start("customer", 50000n, customer), entry, "the same amount again changes nothing");

  start("customer", 30000n, customer);
  assert.equal(customerBalance(customer), 30000n);
  assert.equal(standing(account), "30000");
  assert.equal(app(`select count(*) from consignments c join shipments s on s.id = c.shipment_id where s.opening and c.customer_id = ${lit(customer)} and c.status = 'cancelled';`), "1");

  start("customer", -10000n, customer);
  assert.equal(customerBalance(customer), -10000n);
  assert.equal(startingConsignment(customer), "");
  assert.equal(start("customer", 0n, customer), "");
  assert.equal(customerBalance(customer), 0n);
  assert.equal(standing(account), "");
  // Every step is on the books: three set, three taken back.
  assert.equal(app(`select count(*) from journal_entries e join journal_lines l on l.entry_id = e.id where l.account_id = ${account} and (e.kind = 'opening_balance' or e.reverses_id in (select id from journal_entries where kind = 'opening_balance'));`), "6");
  assert.equal(health(), "");
});

test("the vault and the China account start from what San says", () => {
  const vault = { usd: on("vault_usd"), iqd: on("vault_iqd") };
  const china = on("china_payable");
  start("vault_usd", 100000n);
  start("vault_iqd", 1500000n);
  start("china", 250000n);
  assert.equal(on("vault_usd") - vault.usd, 100000n);
  assert.equal(on("vault_iqd") - vault.iqd, 1500000n);
  assert.equal(on("china_payable") - china, -250000n, "what is owed to China");
  start("china", 200000n);
  assert.equal(on("china_payable") - china, -200000n);
  assert.equal(standing("gs_account('china_payable')"), "-200000");
  start("vault_usd", 0n);
  assert.equal(on("vault_usd"), vault.usd);

  refused(() => start("vault_usd", -1n), /amount_invalid/);
  refused(() => start("china", -1n), /amount_invalid/);
  refused(() => start("wallet_fib_usd", 100n), /starting_balance_invalid/);
  refused(() => start("vault_usd", 100n, newCustomer()), /starting_balance_invalid/);
  refused(() => start("customer", 100n), /customer_not_found/);
  refused(() => app(`select gs_set_starting_balance(${lit(randomUUID())}, ${lit(USER)}, 'vault_usd', null);`), /amount_invalid/);
  refused(() => start("customer", 100n, randomUUID()), /customer_not_found/);
  assert.equal(health(), "");
});

test("nobody posts or takes back a starting balance by hand", () => {
  const customer = newCustomer("By Hand");
  const lines = (account: string, amount: number, against = "opening_balances_usd") =>
    `jsonb_build_array(jsonb_build_object('account_id', ${account}, 'currency', 'USD', 'amount', ${amount}),
                       jsonb_build_object('account_id', gs_account(${lit(against)}), 'currency', 'USD', 'amount', ${-amount}))`;
  const byHand = (account: string, amount: number, against?: string) =>
    `select gs_post_entry('opening_balance', now(), ${lit(USER)}, ${lit(randomUUID())}, ${lines(account, amount, against)}, 'by hand');`;

  refused(() => app(byHand(`gs_customer_account(${lit(customer)})`, 5000)), /starting_balance_by_function/);
  const entry = start("customer", -5000n, customer);
  refused(() => app(`select gs_reverse_entry(${lit(entry)}, ${lit(USER)}, 'by hand', ${lit(randomUUID())});`), /starting_balance_by_function/);
  assert.equal(customerBalance(customer), -5000n);

  // Even the owner, who is past that guard, keeps to the shape.
  refused(() => owner(byHand(`gs_customer_account(${lit(customer)})`, 5000, "errors_usd")), /entry_shape: a opening_balance entry cannot move the errors_usd account/);
  refused(
    () => owner(`select gs_post_entry('opening_balance', now(), ${lit(USER)}, ${lit(randomUUID())}, jsonb_build_array(
      jsonb_build_object('account_id', gs_customer_account(${lit(customer)}), 'currency', 'USD', 'amount', 5000),
      jsonb_build_object('account_id', gs_account('vault_usd'), 'currency', 'USD', 'amount', 5000),
      jsonb_build_object('account_id', gs_account('opening_balances_usd'), 'currency', 'USD', 'amount', -10000)), 'two accounts');`),
    /entry_shape: a starting balance is one amount on one account/,
  );
  refused(
    () => owner(`select gs_post_entry('opening_balance', now(), ${lit(USER)}, ${lit(randomUUID())}, jsonb_build_array(
      jsonb_build_object('account_id', gs_customer_account(${lit(customer)}), 'currency', 'USD', 'amount', 5000),
      jsonb_build_object('account_id', gs_customer_account(${lit(newCustomer())}), 'currency', 'USD', 'amount', 5000),
      jsonb_build_object('account_id', gs_account('opening_balances_usd'), 'currency', 'USD', 'amount', -10000)), 'two customers');`),
    /entry_shape: a starting balance is one amount on one account/,
  );
  refused(() => owner(byHand("gs_account('vault_usd')", -5000)), /entry_shape: a opening_balance entry cannot move a vault account down/);
});

test("only an active CEO sets a starting balance, under his own name", () => {
  const customer = newCustomer("Who Sets");
  const off = switchedOff();
  refused(() => appAs(off)(startSql("customer", 100n, customer, randomUUID(), off)), /actor_unknown/);
  refused(() => appNoActor(startSql("customer", 100n, customer)), /actor_required/);
  const other = newCeo();
  refused(() => appAs(other)(startSql("customer", 100n, customer)), /actor_mismatch/);
  retire(other);
  assert.equal(customerBalance(customer), 0n);
});
