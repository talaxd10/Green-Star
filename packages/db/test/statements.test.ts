// Statements, proven against a real Postgres: read from the ledger, in order,
// always ending on the balance, and kept exactly as they were made.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { iqd, officePayment, usd, walletPayment } from "@green-star/domain";
import { lit } from "../src/index.ts";
import { USER, app, appAs, appNoActor, charge, customerBalance, health, makeTrusted, newCustomer, owner, post, refused, setRate } from "./helpers.ts";

// The statement tests keep to their own days so no other test file changes their rates.
setRate("2027-01-07", 145000);
const at = (day: number, hour = 9) => new Date(Date.UTC(2027, 0, day, hour));

let n = 0;
function newUser(role: "ceo" | "owner" | "monitor"): string {
  const id = randomUUID();
  const who = role === "monitor" ? `null, ${lit(`stmtscreen${++n}`)}` : `${lit(`+96473${(40000000 + ++n).toString()}`)}, null`;
  app(`insert into users (id, name, role, phone, sign_in_name, created_by) values (${lit(id)}, ${lit(`Statement ${role}`)}, ${lit(role)}, ${who}, ${lit(USER)});`);
  return id;
}

/** "line_no:what:change:balance" per line, with r for a reversal. */
const lines = (customerId: string, corrections = false) =>
  app(
    `select coalesce(string_agg(line_no || ':' || what || case when is_reversal then '(r)' else '' end || ':' || change_usd_cents || ':' || balance_after_usd_cents, ' ' order by line_no), '')
     from gs_customer_statement(${lit(customerId)}, ${corrections});`,
  );

const lastBalance = (customerId: string, corrections = false) =>
  BigInt(
    app(
      `select coalesce((select balance_after_usd_cents from gs_customer_statement(${lit(customerId)}, ${corrections}) order by line_no desc limit 1), 0);`,
    ),
  );

const reverse = (entryId: string, when = at(20)) =>
  app(`select gs_reverse_entry(${lit(entryId)}, ${lit(USER)}, 'entered by mistake', ${lit(randomUUID())}, ${lit(when.toISOString())});`);

const record = (customerId: string, balance: bigint | number | null, id = randomUUID(), who = USER, summary = "You owe something.") =>
  `select gs_record_statement(${lit(id)}, ${lit(customerId)}, ${lit(who)}, null, ${
    balance === null ? `'{}'::jsonb` : `jsonb_build_object('balanceUsdCents', ${balance})`
  }, ${lit(summary)});`;

test("a statement is the customer's lines in the order they happened, each with the balance after it", () => {
  const customer = newCustomer("Statement Reader");
  const first = charge(customer, 31000n, at(5));
  // Entered later, but it happened before the first charge.
  const earlier = charge(customer, 8500n, at(3));
  post(officePayment({ customerId: customer, received: usd(10000n) }), at(6));
  post(walletPayment({ customerId: customer, received: iqd(145000n), ratePer100: 145000, wallet: "fib" }), at(7));

  assert.equal(lines(customer), "1:file_confirmed:8500:8500 2:file_confirmed:31000:39500 3:office_payment:-10000:29500 4:wallet_payment:-10000:19500");
  assert.equal(customerBalance(customer), 19500n);

  const detail = (lineNo: number, columns: string) => app(`select ${columns} from gs_customer_statement(${lit(customer)}) where line_no = ${lineNo};`);
  const code = (shipmentId: string) => app(`select code from shipments where id = ${lit(shipmentId)};`);
  assert.equal(detail(1, "shipment_code || '|' || consignment_id || '|' || day || '|' || (method is null)"), `${code(earlier.shipmentId)}|${earlier.consignmentId}|2027-01-03|true`);
  assert.equal(detail(2, "shipment_code || '|' || day"), `${code(first.shipmentId)}|2027-01-05`);
  assert.equal(detail(3, "method || '|' || received_amount || '|' || received_currency || '|' || (iqd_per_100_usd is null) || '|' || (shipment_code is null)"), "office_cash|10000|USD|true|true");
  assert.equal(detail(4, "method || '|' || received_amount || '|' || received_currency || '|' || iqd_per_100_usd"), "fib|145000|IQD|145000");

  // Another customer's lines are not on it.
  const other = newCustomer("Someone Else");
  charge(other, 999n, at(4));
  assert.equal(lines(other), "1:file_confirmed:999:999");
  assert.equal(lines(customer).split(" ").length, 4);
  assert.equal(lines(newCustomer("Nothing Yet")), "");
});

test("a mistake and its reversal are left off together, and the statement still ends on the balance", () => {
  const customer = newCustomer("Corrected Account");
  charge(customer, 20000n, at(3));
  const wrong = post(officePayment({ customerId: customer, received: usd(15000n) }), at(4));
  post(officePayment({ customerId: customer, received: usd(5000n) }), at(5));
  reverse(wrong, at(6));

  assert.equal(lines(customer), "1:file_confirmed:20000:20000 2:office_payment:-5000:15000");
  assert.equal(
    lines(customer, true),
    "1:file_confirmed:20000:20000 2:office_payment:-15000:5000 3:office_payment:-5000:0 4:office_payment(r):15000:15000",
  );
  assert.equal(customerBalance(customer), 15000n);
  assert.equal(lastBalance(customer), 15000n);
  assert.equal(lastBalance(customer, true), 15000n);
  assert.equal(
    app(`select string_agg(is_correction::text, ',' order by line_no) from gs_customer_statement(${lit(customer)}, true);`),
    "false,true,false,true",
  );

  // The line that takes a payment back says what it took back: how it was paid, and how much.
  assert.equal(
    app(
      `select string_agg(coalesce(method::text, '-') || ':' || coalesce(received_amount::text, '-'), ',' order by line_no)
       from gs_customer_statement(${lit(customer)}, true);`,
    ),
    "-:-,office_cash:15000,office_cash:5000,office_cash:15000",
  );

  // A charge taken back by cancelling the consignment goes the same way.
  const { consignmentId } = charge(customer, 7000n, at(8));
  assert.equal(lastBalance(customer), 22000n);
  app(`select gs_cancel_consignment(${lit(consignmentId)}, ${lit(USER)}, 'Goods belonged to someone else');`);
  assert.equal(lines(customer), "1:file_confirmed:20000:20000 2:office_payment:-5000:15000");
  assert.equal(lines(customer, true).split(" ").length, 6);
  // Both the charge and the line that took it back say which file it was.
  assert.equal(app(`select count(*) from gs_customer_statement(${lit(customer)}, true) where what = 'file_confirmed' and shipment_code is null;`), "0");
  assert.equal(app(`select count(*) from gs_customer_statement(${lit(customer)}, true) where what = 'file_confirmed' and is_correction;`), "2");
  assert.equal(lastBalance(customer, true), 15000n);
  assert.equal(customerBalance(customer), 15000n);
});

test("random accounts: the statement always ends on the balance, with and without corrections", () => {
  let seed = 20270107;
  // The high bits: the low bits of this kind of generator repeat after a few steps.
  const random = (max: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed >>> 12) % max;
  };
  const did = { charges: 0, payments: 0, reversals: 0 };
  for (let account = 0; account < 4; account += 1) {
    const customer = newCustomer(`Random Account ${account}`);
    const payments: string[] = [];
    let day = 1;
    for (let step = 0; step < 14; step += 1) {
      day += random(2);
      const pick = random(10);
      if (pick < 4) {
        charge(customer, BigInt(1000 + random(50000)), at(Math.min(day, 28), random(12)));
        did.charges += 1;
      } else if (pick < 7 || payments.length === 0) {
        payments.push(post(officePayment({ customerId: customer, received: usd(BigInt(100 + random(20000))) }), at(Math.min(day, 28), 12 + random(6))));
        did.payments += 1;
      } else {
        reverse(payments.splice(random(payments.length), 1)[0] as string, at(Math.min(day, 28), 20));
        did.reversals += 1;
      }
    }
    const balance = customerBalance(customer);
    for (const corrections of [false, true]) {
      assert.equal(lastBalance(customer, corrections), balance, `account ${account}, corrections ${corrections}`);
      // Each line's balance is the one before it plus its own change, and the lines are in order.
      assert.equal(
        app(
          `select count(*) from (
             select balance_after_usd_cents - change_usd_cents as before,
                    coalesce(lag(balance_after_usd_cents) over (order by line_no), 0) as previous,
                    happened_at, lag(happened_at) over (order by line_no) as previous_at,
                    line_no, row_number() over (order by line_no) as expected_no
             from gs_customer_statement(${lit(customer)}, ${corrections})) s
           where before <> previous or happened_at < previous_at or line_no <> expected_no;`,
        ),
        "0",
      );
    }
    // Without corrections, nothing on it was ever taken back.
    assert.equal(app(`select count(*) from gs_customer_statement(${lit(customer)}) where is_correction;`), "0");
  }
  // The test did what its name says: all three kinds of step, several times each.
  assert.ok(did.charges >= 8 && did.payments >= 8 && did.reversals >= 5, JSON.stringify(did));
  assert.equal(health(), "");
});

test("a statement made to send is kept with the ledger's balance, and one that says another balance is refused", () => {
  const customer = newCustomer("Sent A Statement");
  charge(customer, 31000n, at(3));
  post(officePayment({ customerId: customer, received: usd(10000n) }), at(4));
  const count = () => app(`select count(*) from statements where customer_id = ${lit(customer)};`);

  refused(() => app(record(customer, 31000)), /statement_stale/);
  refused(() => app(record(customer, 0)), /statement_stale/);
  refused(() => app(record(customer, null)), /statement_stale/);
  refused(() => app(`select gs_record_statement(${lit(randomUUID())}, ${lit(customer)}, ${lit(USER)}, null, '[21000]'::jsonb, 'x');`), /statement_stale/);
  refused(() => app(`select gs_record_statement(null, ${lit(customer)}, ${lit(USER)}, null, '{}'::jsonb, 'x');`), /statement_id_required/);
  refused(() => app(record(customer, 21000, randomUUID(), USER, "   ")), /statements_summary_not_blank/);
  refused(() => app(record(randomUUID(), 0)), /customer_not_found/);
  assert.equal(count(), "0");

  const id = randomUUID();
  app(`select gs_record_statement(${lit(id)}, ${lit(customer)}, ${lit(USER)}, '2027-01-01', jsonb_build_object('balanceUsdCents', 21000, 'lines', jsonb_build_array()), 'You owe $210.00.');`);
  assert.equal(
    app(`select balance_usd_cents || '|' || from_day || '|' || summary || '|' || created_by || '|' || (snapshot ->> 'balanceUsdCents') || '|' || (sent_at is null) from statements where id = ${lit(id)};`),
    `21000|2027-01-01|You owe $210.00.|${USER}|21000|true`,
  );
  // The same request again is one statement, even after the account has moved on.
  post(officePayment({ customerId: customer, received: usd(1000n) }), at(5));
  app(record(customer, 21000, id));
  assert.equal(count(), "1");
  // The id of one customer's statement is not taken for another's.
  const other = newCustomer("Another Customer");
  refused(() => app(record(other, 0, id)), /statement_id_reused/);

  // A customer who was merged away gets no statement.
  const duplicate = newCustomer("Merged Away");
  app(`select gs_merge_customer(${lit(duplicate)}, ${lit(other)});`);
  refused(() => app(record(duplicate, 0)), /customer_not_found/);
});

test("a statement is marked as sent once, and nothing else about it ever changes", () => {
  const customer = newCustomer("Locked Statement");
  charge(customer, 5000n, at(3));
  const id = randomUUID();
  app(record(customer, 5000, id));
  const sent = () => app(`select coalesce(sent_at::text, '-') || '|' || coalesce(sent_by::text, '-') from statements where id = ${lit(id)};`);
  assert.equal(sent(), "-|-");

  refused(() => app(`select gs_mark_statement_sent(${lit(randomUUID())}, ${lit(USER)});`), /statement_not_found/);
  app(`select gs_mark_statement_sent(${lit(id)}, ${lit(USER)});`);
  const first = sent();
  assert.match(first, new RegExp(`^20.*\\|${USER}$`));
  app(`select gs_mark_statement_sent(${lit(id)}, ${lit(USER)});`);
  assert.equal(sent(), first, "the second time changes nothing");

  // The application can only read statements. They change through the two functions.
  refused(() => app(`update statements set summary = 'You owe nothing' where id = ${lit(id)};`), /permission denied/);
  refused(() => app(`delete from statements where id = ${lit(id)};`), /permission denied/);
  refused(
    () => app(`insert into statements (id, customer_id, balance_usd_cents, snapshot, summary, created_by) values (${lit(randomUUID())}, ${lit(customer)}, 1, '{}', 'x', ${lit(USER)});`),
    /permission denied/,
  );
  // And the rules hold for the schema owner too.
  refused(() => owner(`update statements set summary = 'You owe nothing' where id = ${lit(id)};`), /statement_locked/);
  refused(() => owner(`update statements set balance_usd_cents = 0 where id = ${lit(id)};`), /statement_locked/);
  refused(() => owner(`update statements set snapshot = '{}' where id = ${lit(id)};`), /statement_locked/);
  refused(() => owner(`update statements set sent_at = null, sent_by = null where id = ${lit(id)};`), /statement_locked/);
  refused(() => owner(`update statements set sent_at = now() - interval '1 year' where id = ${lit(id)};`), /statement_locked/);
  refused(() => owner(`delete from statements where id = ${lit(id)};`), /ledger_immutable/);
  refused(() => owner("truncate statements;"), /ledger_immutable/);
  assert.equal(sent(), first);
});

test("only the CEO makes a statement or marks it sent, under his own name", () => {
  const customer = newCustomer("Whose Statement");
  charge(customer, 4000n, at(3));
  const id = randomUUID();
  app(record(customer, 4000, id));

  for (const role of ["owner", "monitor"] as const) {
    const who = newUser(role);
    refused(() => appAs(who)(record(customer, 4000, randomUUID(), who)), /ceo_only/);
    refused(() => appAs(who)(record(customer, 4000, randomUUID(), USER)), /ceo_only/);
    refused(() => appAs(who)(`select gs_mark_statement_sent(${lit(id)}, ${lit(who)});`), /ceo_only/);
    refused(() => appAs(who)(`select gs_mark_statement_sent(${lit(id)}, ${lit(USER)});`), /ceo_only/);
  }
  refused(() => appNoActor(record(customer, 4000)), /actor_required/);
  refused(() => appNoActor(`select gs_mark_statement_sent(${lit(id)}, ${lit(USER)});`), /actor_required/);
  const second = newUser("ceo");
  refused(() => appAs(second)(record(customer, 4000)), /actor_mismatch/);
  refused(() => appAs(second)(`select gs_mark_statement_sent(${lit(id)}, ${lit(USER)});`), /actor_mismatch/);
  assert.equal(app(`select count(*) from statements where customer_id = ${lit(customer)};`), "1");
  assert.equal(app(`select sent_at is null from statements where id = ${lit(id)};`), "t");

  appAs(second)(`select gs_mark_statement_sent(${lit(id)}, ${lit(second)});`);
  assert.equal(app(`select sent_by from statements where id = ${lit(id)};`), second);
  // Switched off again, so the other test files find one CEO, as they expect.
  app(`update users set active = false where id = ${lit(second)};`);
});

test("the list of who to send a statement to: trusted customers who owe, and when each was last sent one", () => {
  const owes = newCustomer("Trusted And Owes");
  makeTrusted(owes, 100000n);
  charge(owes, 30000n, at(3));
  const paidUp = newCustomer("Trusted And Paid Up");
  makeTrusted(paidUp);
  charge(paidUp, 2000n, at(3));
  post(officePayment({ customerId: paidUp, received: usd(2000n) }), at(4));
  const payFirst = newCustomer("Pay First And Owes");
  charge(payFirst, 2000n, at(3));

  const row = (customerId: string) =>
    app(
      `select coalesce((select display_name || '|' || balance_usd_cents || '|' || due || '|' || coalesce(last_statement_id::text, '-') || '|' || coalesce(last_sent_balance_usd_cents::text, '-')
                        from statement_list where customer_id = ${lit(customerId)}), 'not listed');`,
    );
  assert.equal(row(owes), "Trusted And Owes|30000|true|-|-");
  assert.equal(row(paidUp), "not listed");
  assert.equal(row(payFirst), "not listed");

  // Made, but not sent: he is still due one.
  const made = randomUUID();
  app(record(owes, 30000, made));
  assert.equal(row(owes), "Trusted And Owes|30000|true|-|-");
  app(`select gs_mark_statement_sent(${lit(made)}, ${lit(USER)});`);
  assert.equal(row(owes), `Trusted And Owes|30000|false|${made}|30000`);

  // One sent six days ago still covers the week. One sent seven days ago does not.
  const sentDaysAgo = (customerId: string, days: number) => {
    const id = randomUUID();
    owner(
      `insert into statements (id, customer_id, balance_usd_cents, snapshot, summary, created_by, as_of, sent_at, sent_by)
       values (${lit(id)}, ${lit(customerId)}, 1, '{}', 'x', ${lit(USER)}, now() - interval '${days} days', now() - interval '${days} days', ${lit(USER)});`,
    );
    return id;
  };
  const weekAgo = newCustomer("Sent A Week Ago");
  makeTrusted(weekAgo);
  charge(weekAgo, 1000n, at(3));
  const old = sentDaysAgo(weekAgo, 7);
  assert.equal(row(weekAgo), `Sent A Week Ago|1000|true|${old}|1`);
  const sixDays = newCustomer("Sent Six Days Ago");
  makeTrusted(sixDays);
  charge(sixDays, 1000n, at(3));
  sentDaysAgo(sixDays, 30);
  const recent = sentDaysAgo(sixDays, 6);
  assert.equal(row(sixDays), `Sent Six Days Ago|1000|false|${recent}|1`, "the latest one sent is the one that counts");

  assert.equal(health(), "");
});
