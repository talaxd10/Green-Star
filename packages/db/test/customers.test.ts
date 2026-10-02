// Customers, files, consignments and allocation, proven against a real Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { allocateOldestFirst, normalizeMark, normalizePhone, officePayment, usd } from "@green-star/domain";
import { lit } from "../src/index.ts";
import {
  USER,
  app,
  balances,
  charge,
  confirmSql,
  customerBalance,
  draftShipmentSql,
  health,
  newCustomer,
  owner,
  post,
  refused,
} from "./helpers.ts";

const money = (consignmentId: string) =>
  app(
    `select due_usd_cents || ',' || paid_usd_cents || ',' || remaining_usd_cents
     from consignment_money where consignment_id = ${lit(consignmentId)};`,
  );

const match = (phone: string | null, mark: string | null) =>
  app(
    `select customer_id || ',' || matched_by || ',' || conflict
     from gs_match_customer(${phone === null ? "null" : lit(phone)}, ${mark === null ? "null" : lit(mark)});`,
  );

// Each run uses its own phone numbers and marks so tests never collide.
const run = Date.now().toString().slice(-6);
let phoneCounter = 0;
const nextPhone = () => `+964770${run}${(phoneCounter++).toString().padStart(1, "0")}`.slice(0, 14).padEnd(14, "0");
const tag = `T${run}`;

test("a phone number or a mark belongs to one customer", () => {
  const a = newCustomer("Rebwar A.");
  const b = newCustomer("Shvan K.");
  const phone = nextPhone();
  app(`insert into customer_phones (customer_id, phone, is_primary) values (${lit(a)}, ${lit(phone)}, true);`);
  refused(() => app(`insert into customer_phones (customer_id, phone) values (${lit(b)}, ${lit(phone)});`), /customer_phones_phone_key/);
  refused(() => app(`insert into customer_phones (customer_id, phone) values (${lit(b)}, '0770 123 4567');`), /customer_phones_format/);
  refused(
    () => app(`insert into customer_phones (customer_id, phone, is_primary) values (${lit(a)}, ${lit(nextPhone())}, true);`),
    /customer_phones_one_primary/,
  );

  app(`insert into customer_marks (customer_id, mark) values (${lit(a)}, ${lit(`${tag} REBWAR`)});`);
  refused(() => app(`insert into customer_marks (customer_id, mark) values (${lit(b)}, ${lit(`${tag} REBWAR`)});`), /customer_marks_mark_key/);
  refused(() => app(`insert into customer_marks (customer_id, mark) values (${lit(b)}, ${lit(`${tag}  shvan`)});`), /customer_marks_normalized/);
});

test("the database and the app normalise marks and phones the same way", () => {
  for (const mark of ["  yaro   mhamad ", "Dara\tM", "GSSK 6926 / A", "x"]) {
    assert.equal(app(`select gs_normalize_mark(${lit(mark)});`), normalizeMark(mark));
  }
  const customer = newCustomer();
  const phone = normalizePhone(`0770 ${run} 9`.padEnd(13, "9"));
  assert.ok(phone);
  app(`insert into customer_phones (customer_id, phone) values (${lit(customer)}, ${lit(phone)});`);
});

test("a file row is matched by phone, then exact mark, then mark prefix", () => {
  const person = newCustomer("Dara M.");
  const agent = newCustomer("Yaro company");
  const longer = newCustomer("Yaro Express");
  const phone = nextPhone();
  app(
    `insert into customer_phones (customer_id, phone) values (${lit(person)}, ${lit(phone)});
     insert into customer_marks (customer_id, mark, match) values
       (${lit(person)}, ${lit(`${tag} DARA`)}, 'exact'),
       (${lit(agent)}, ${lit(`${tag}YARO`)}, 'prefix'),
       (${lit(longer)}, ${lit(`${tag}YARO EXPRESS`)}, 'prefix');
     update customers set kind = 'agent_company' where id in (${lit(agent)}, ${lit(longer)});`,
  );

  assert.equal(match(phone, null), `${person},phone,false`);
  assert.equal(match(null, ` ${tag.toLowerCase()}  dara `), `${person},mark,false`);
  // The agent company's mark changes on every file.
  assert.equal(match(null, `${tag}YARO MHAMAD`), `${agent},mark_prefix,false`);
  assert.equal(match(null, `${tag}yaro osman`), `${agent},mark_prefix,false`);
  assert.equal(match(null, `${tag}YARO`), `${agent},mark_prefix,false`);
  // The longest prefix wins.
  assert.equal(match(null, `${tag}YARO EXPRESS 12`), `${longer},mark_prefix,false`);
  // A prefix matches whole words only.
  assert.equal(match(null, `${tag}YAROSLAV`), "");
  // Phone wins over mark, and the disagreement is reported for the review screen.
  assert.equal(match(phone, `${tag}YARO OSMAN`), `${person},phone,true`);
  // Nothing known: no row, so it goes to review.
  assert.equal(match(nextPhone(), `${tag} NOBODY`), "");
  assert.equal(match(null, null), "");
});

test("trust and limits change only through the logged function", () => {
  const customer = newCustomer("Dara M.");
  refused(() => app(`update customers set trust = 'trusted' where id = ${lit(customer)};`), /permission denied/);
  refused(() => app(`update customers set credit_limit_usd_cents = 1 where id = ${lit(customer)};`), /permission denied/);
  refused(
    () => app(`insert into customers (display_name, trust) values ('Sneaky', 'trusted');`),
    /permission denied/,
  );
  refused(
    () => app(`select gs_set_customer_trust(${lit(customer)}, 'pay_first', 5000, ${lit(USER)}, 'China office');`),
    /limit_not_allowed/,
  );
  refused(
    () => app(`select gs_set_customer_trust(${lit(customer)}, 'trusted', 50000, ${lit(USER)}, ' ');`),
    /customer_trust_changes_asked_by_not_blank/,
  );

  app(`select gs_set_customer_trust(${lit(customer)}, 'trusted', 50000, ${lit(USER)}, 'China office', 'Phone call');`);
  app(`select gs_set_customer_trust(${lit(customer)}, 'trusted', 50000, ${lit(USER)}, 'China office');`); // no change, no log
  app(`select gs_set_customer_trust(${lit(customer)}, 'trusted', 80000, ${lit(USER)}, 'China office');`);
  assert.equal(app(`select trust || ',' || credit_limit_usd_cents from customers where id = ${lit(customer)};`), "trusted,80000");
  assert.equal(
    app(
      `select string_agg(trust_before || '>' || trust_after || ':' || coalesce(limit_before::text, '-') || '>' || coalesce(limit_after::text, '-'), ' ' order by id)
       from customer_trust_changes where customer_id = ${lit(customer)};`,
    ),
    "pay_first>trusted:->50000 trusted>trusted:50000>80000",
  );
  refused(() => app(`delete from customer_trust_changes where customer_id = ${lit(customer)};`), /permission denied/);
  refused(() => owner(`delete from customer_trust_changes where customer_id = ${lit(customer)};`), /ledger_immutable/);
});

test("the same file cannot be imported twice", () => {
  const sha = randomUUID().replaceAll("-", "").padEnd(64, "a");
  const insert = `insert into source_files (filename, storage_key, sha256, uploaded_by) values ('GSSK6926.xlsx', 'files/x', ${lit(sha)}, ${lit(USER)});`;
  app(insert);
  refused(() => app(insert), /source_files_sha256_key/);
  refused(
    () => app(`insert into source_files (filename, storage_key, sha256, uploaded_by) values ('a.xlsx', 'files/y', 'not-a-hash', ${lit(USER)});`),
    /source_files_sha256_format/,
  );
});

test("confirming a file charges each customer once; prepaid posts nothing", () => {
  const dara = newCustomer("Dara M.");
  const hemn = newCustomer("Hemn S.");
  const prepaid = newCustomer("Prepaid P.");
  app(`select gs_set_customer_trust(${lit(dara)}, 'trusted', 100000, ${lit(USER)}, 'China office');`);
  const file = randomUUID();
  const [cDara, cHemn, cPrepaid] = [randomUUID(), randomUUID(), randomUUID()];
  const at = new Date("2026-05-01T09:00:00Z");
  const before = balances();
  app(draftShipmentSql(file, [[dara, 31000n, cDara], [hemn, 6200n, cHemn], [prepaid, 0n, cPrepaid]]));

  // A draft charges nobody.
  assert.equal(customerBalance(dara), 0n);

  assert.equal(app(confirmSql(file, at)), "3");
  assert.equal(app(confirmSql(file, at)), "0"); // already confirmed: does nothing
  assert.equal(customerBalance(dara), 31000n);
  assert.equal(customerBalance(hemn), 6200n);
  assert.equal(customerBalance(prepaid), 0n);
  assert.equal((balances().get("china_payable") ?? 0n) - (before.get("china_payable") ?? 0n), -37200n);
  assert.equal(app(`select count(*) from journal_entries where idempotency_key in (${lit(`charge:${cDara}`)}, ${lit(`charge:${cHemn}`)}, ${lit(`charge:${cPrepaid}`)});`), "2");
  assert.equal(
    app(`select string_agg(trust_at_time::text, ',' order by amount_due_usd_cents desc) from consignments where shipment_id = ${lit(file)};`),
    "trusted,pay_first,pay_first",
  );
  assert.equal(app(`select status from shipments where id = ${lit(file)};`), "confirmed");
  assert.equal(money(cPrepaid), "0,0,0");

  const empty = randomUUID();
  app(`insert into shipments (id, code) values (${lit(empty)}, ${lit(`GSSK-EMPTY-${run}`)});`);
  refused(() => app(confirmSql(empty, at)), /shipment_empty/);
  assert.equal(health(), "");
});

test("a confirmed file is locked", () => {
  const customer = newCustomer();
  const other = newCustomer();
  const { shipmentId, consignmentId } = charge(customer, 8500n);

  refused(() => app(`update consignments set amount_due_usd_cents = 1 where id = ${lit(consignmentId)};`), /consignment_locked/);
  refused(() => app(`update consignments set customer_id = ${lit(other)} where id = ${lit(consignmentId)};`), /consignment_locked/);
  refused(() => app(`delete from consignments where id = ${lit(consignmentId)};`), /consignment_locked/);
  refused(
    () => app(`insert into consignments (shipment_id, customer_id, amount_due_usd_cents) values (${lit(shipmentId)}, ${lit(other)}, 100);`),
    /shipment_locked/,
  );
  refused(
    () => app(`insert into shipment_lines (shipment_id, row_no, raw) values (${lit(shipmentId)}, 1, '{}');`),
    /shipment_locked/,
  );
  refused(() => app(`update consignments set charge_entry_id = null where id = ${lit(consignmentId)};`), /permission denied/);
  refused(() => app(`update consignments set status = 'cancelled' where id = ${lit(consignmentId)};`), /cancel_needs_reversal/);
  refused(() => app(`update shipments set status = 'draft' where id = ${lit(shipmentId)};`), /shipments_confirmed_fields/);

  // The delivery side of a consignment can still move.
  app(`update consignments set status = 'on_round', cartons_received = 3 where id = ${lit(consignmentId)};`);
  app(`update shipments set status = 'on_rounds' where id = ${lit(shipmentId)};`);
});

test("a draft file can still be edited", () => {
  const customer = newCustomer();
  const file = randomUUID();
  const consignment = randomUUID();
  app(draftShipmentSql(file, [[customer, 5000n, consignment]]));
  app(`insert into shipment_lines (shipment_id, consignment_id, row_no, mark, collect_usd_cents, raw)
       values (${lit(file)}, ${lit(consignment)}, 1, 'DARA', 5000, '{"A": "DARA"}');`);
  app(`update consignments set amount_due_usd_cents = 5200, other_charges_usd_cents = 200 where id = ${lit(consignment)};`);
  refused(() => app(`update consignments set other_charges_usd_cents = 9999 where id = ${lit(consignment)};`), /consignments_other_within_amount/);
  refused(
    () => app(`insert into consignments (shipment_id, customer_id, amount_due_usd_cents) values (${lit(file)}, ${lit(customer)}, 100);`),
    /consignments_one_per_customer_per_file/,
  );
  app(`delete from shipment_lines where shipment_id = ${lit(file)}; delete from consignments where id = ${lit(consignment)};`);
});

test("a charge can only be posted by confirming a file", () => {
  const customer = newCustomer();
  refused(
    () =>
      app(`select gs_post_entry('file_confirmed', now(), ${lit(USER)}, ${lit(randomUUID())}, jsonb_build_array(
             jsonb_build_object('account_id', gs_customer_account(${lit(customer)}), 'currency', 'USD', 'amount', 5000),
             jsonb_build_object('account_id', gs_account('china_payable'), 'currency', 'USD', 'amount', -5000)));`),
    /charge_needs_consignment/,
  );
  const { consignmentId } = charge(customer, 5000n);
  const chargeEntry = app(`select charge_entry_id from consignments where id = ${lit(consignmentId)};`);
  refused(
    () => app(`select gs_reverse_entry(${lit(chargeEntry)}, ${lit(USER)}, 'undo', ${lit(randomUUID())});`),
    /charge_needs_consignment/,
  );
  refused(() => app(`select gs_charge_consignment(${lit(consignmentId)}, ${lit(USER)}, now());`), /permission denied/);
  refused(() => app(`insert into allocations (entry_id, consignment_id, amount_usd_cents) values (${lit(chargeEntry)}, ${lit(consignmentId)}, 1);`), /permission denied/);
});

test("the late payer from three files ago: a payment clears the oldest file first", () => {
  const customer = newCustomer("Late payer");
  const f1 = charge(customer, 4000n, new Date("2026-09-01T09:00:00Z"));
  const f3 = charge(customer, 6200n, new Date("2026-09-20T09:00:00Z"));
  const f2 = charge(customer, 8500n, new Date("2026-09-10T09:00:00Z")); // entered last, but an older file

  const expected = allocateOldestFirst(10000n, [
    { id: f1.consignmentId, remainingUsdCents: 4000n, confirmedAt: new Date("2026-09-01T09:00:00Z") },
    { id: f2.consignmentId, remainingUsdCents: 8500n, confirmedAt: new Date("2026-09-10T09:00:00Z") },
    { id: f3.consignmentId, remainingUsdCents: 6200n, confirmedAt: new Date("2026-09-20T09:00:00Z") },
  ]);
  const payment = post(officePayment({ customerId: customer, received: usd(10000) }));
  const actual = app(
    `select consignment_id || '=' || amount_usd_cents from allocations where entry_id = ${lit(payment)} order by id;`,
  ).split("\n");
  assert.deepEqual(actual, expected.allocations.map((a) => `${a.consignmentId}=${a.amountUsdCents}`));

  assert.equal(money(f1.consignmentId), "4000,4000,0");
  assert.equal(money(f2.consignmentId), "8500,6000,2500");
  assert.equal(money(f3.consignmentId), "6200,0,6200");
  assert.equal(customerBalance(customer), 8700n);

  // He pays more than he owes: the rest stays on his account as credit...
  post(officePayment({ customerId: customer, received: usd(10000) }));
  assert.equal(money(f2.consignmentId), "8500,8500,0");
  assert.equal(money(f3.consignmentId), "6200,6200,0");
  assert.equal(customerBalance(customer), -1300n);

  // ...and pays toward his next file by itself the moment it is confirmed.
  const f4 = charge(customer, 5000n, new Date("2026-10-01T09:00:00Z"));
  assert.equal(money(f4.consignmentId), "5000,1300,3700");
  assert.equal(customerBalance(customer), 3700n);
  assert.equal(health(), "");
});

test("reversing a payment reopens what it had paid", () => {
  const customer = newCustomer();
  const file = charge(customer, 6000n);
  const wrong = post(officePayment({ customerId: customer, received: usd(6000) }));
  assert.equal(money(file.consignmentId), "6000,6000,0");

  app(`select gs_reverse_entry(${lit(wrong)}, ${lit(USER)}, 'Entered on the wrong customer', ${lit(randomUUID())});`);
  assert.equal(money(file.consignmentId), "6000,0,6000");
  assert.equal(customerBalance(customer), 6000n);

  post(officePayment({ customerId: customer, received: usd(2500) }));
  assert.equal(money(file.consignmentId), "6000,2500,3500");
  assert.equal(health(), "");
});

test("cancelling a consignment reverses its charge and frees the money paid on it", () => {
  const customer = newCustomer();
  const first = charge(customer, 4000n, new Date("2026-09-01T09:00:00Z"));
  const second = charge(customer, 7000n, new Date("2026-09-05T09:00:00Z"));
  post(officePayment({ customerId: customer, received: usd(5000) }));
  assert.equal(money(first.consignmentId), "4000,4000,0");
  assert.equal(money(second.consignmentId), "7000,1000,6000");

  refused(() => app(`select gs_cancel_consignment(${lit(first.consignmentId)}, ${lit(USER)}, '  ');`), /reason_required/);
  app(`select gs_cancel_consignment(${lit(first.consignmentId)}, ${lit(USER)}, 'Goods belonged to another customer');`);
  app(`select gs_cancel_consignment(${lit(first.consignmentId)}, ${lit(USER)}, 'again');`); // already cancelled: does nothing

  assert.equal(app(`select status from consignments where id = ${lit(first.consignmentId)};`), "cancelled");
  assert.equal(money(first.consignmentId), "0,0,0");
  // The $40.00 that had paid the cancelled consignment now pays the other one.
  assert.equal(money(second.consignmentId), "7000,5000,2000");
  assert.equal(customerBalance(customer), 2000n);
  refused(() => app(`update consignments set status = 'listed' where id = ${lit(first.consignmentId)};`), /consignment_locked/);
  assert.equal(health(), "");
});

test("a wrong amount is corrected by a replacement consignment", () => {
  const customer = newCustomer();
  const file = charge(customer, 8500n);
  post(officePayment({ customerId: customer, received: usd(8500) }));
  assert.equal(customerBalance(customer), 0n);

  // The file should have said $58.00, not $85.00.
  const replacement = app(
    `select gs_correct_consignment(${lit(file.consignmentId)}, 5800, 0, ${lit(USER)}, 'File said 85, China confirmed 58');`,
  );
  assert.notEqual(replacement, file.consignmentId);
  assert.equal(money(file.consignmentId), "0,0,0");
  assert.equal(money(replacement), "5800,5800,0");
  assert.equal(customerBalance(customer), -2700n); // he overpaid by $27.00
  assert.equal(app(`select count(*) from consignments where shipment_id = ${lit(file.shipmentId)} and status <> 'cancelled';`), "1");
  refused(
    () => app(`select gs_correct_consignment(${lit(file.consignmentId)}, 100, 0, ${lit(USER)}, 'again');`),
    /consignment_cancelled/,
  );
  assert.equal(health(), "");
});

test("a trusted customer over his own limit is listed", () => {
  const customer = newCustomer("Dara M.");
  app(`select gs_set_customer_trust(${lit(customer)}, 'trusted', 30000, ${lit(USER)}, 'China office');`);
  charge(customer, 31000n);
  assert.equal(
    app(`select balance_usd_cents || ',' || over_by_usd_cents from customers_over_limit where customer_id = ${lit(customer)};`),
    "31000,1000",
  );
  post(officePayment({ customerId: customer, received: usd(1000) }));
  assert.equal(app(`select count(*) from customers_over_limit where customer_id = ${lit(customer)};`), "0");
});

test("random charges, payments, reversals, cancellations and corrections keep every customer straight", () => {
  let seed = 9261002;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const pick = <T>(items: readonly T[]): T => items[next(items.length)]!;

  const customers = Array.from({ length: 5 }, (_, i) => newCustomer(`Random ${i}`));
  const live: { id: string; customer: string }[] = [];
  const payments: string[] = [];
  const expected = new Map<string, bigint>(customers.map((c) => [c, 0n]));
  const bump = (customer: string, by: bigint) => expected.set(customer, (expected.get(customer) ?? 0n) + by);
  const amounts = new Map<string, bigint>();
  const paid = new Map<string, { customer: string; cents: bigint }>();
  let clock = Date.parse("2026-06-01T09:00:00Z");

  for (let step = 0; step < 220; step++) {
    clock += 60_000;
    const at = new Date(clock);
    const customer = pick(customers);
    switch (next(6)) {
      case 0:
      case 1: {
        const cents = BigInt(next(4) === 0 ? 0 : next(60000) + 1);
        const { consignmentId } = charge(customer, cents, at);
        live.push({ id: consignmentId, customer });
        amounts.set(consignmentId, cents);
        bump(customer, cents);
        break;
      }
      case 2:
      case 3: {
        const cents = BigInt(next(80000) + 1);
        const id = post(officePayment({ customerId: customer, received: usd(cents) }), at);
        payments.push(id);
        paid.set(id, { customer, cents });
        bump(customer, -cents);
        break;
      }
      case 4: {
        if (payments.length === 0) break;
        const index = next(payments.length);
        const id = payments.splice(index, 1)[0]!;
        app(`select gs_reverse_entry(${lit(id)}, ${lit(USER)}, 'Random reversal', ${lit(randomUUID())});`);
        const p = paid.get(id)!;
        bump(p.customer, p.cents);
        break;
      }
      case 5: {
        if (live.length === 0) break;
        const index = next(live.length);
        const target = live.splice(index, 1)[0]!;
        const old = amounts.get(target.id)!;
        if (next(2) === 0) {
          app(`select gs_cancel_consignment(${lit(target.id)}, ${lit(USER)}, 'Random cancel');`);
          bump(target.customer, -old);
        } else {
          const cents = BigInt(next(60000));
          const replacement = app(`select gs_correct_consignment(${lit(target.id)}, ${cents}, 0, ${lit(USER)}, 'Random correction');`);
          live.push({ id: replacement, customer: target.customer });
          amounts.set(replacement, cents);
          bump(target.customer, cents - old);
        }
        break;
      }
    }
  }

  for (const customer of customers) {
    assert.equal(customerBalance(customer), expected.get(customer), `balance of ${customer}`);
    // After allocation, a customer never has both an unpaid consignment and unused credit.
    const [owed, credit] = app(
      `select coalesce((select sum(remaining_usd_cents) from consignment_money where customer_id = ${lit(customer)}), 0)
              || ',' ||
              coalesce((select sum(credit_usd_cents - allocated_usd_cents) from customer_payments where customer_id = ${lit(customer)}), 0);`,
    ).split(",").map(BigInt) as [bigint, bigint];
    assert.equal(owed - credit, expected.get(customer));
    assert.ok(owed === 0n || credit === 0n, `customer ${customer} has ${owed} owed and ${credit} unused credit`);
  }
  assert.equal(app("select count(*) from consignment_money where paid_usd_cents > due_usd_cents or remaining_usd_cents < 0;"), "0");
  assert.equal(health(), "");
});
