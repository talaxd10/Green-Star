// The ledger's guarantees, proven against a real Postgres.
// Every statement here runs as the application's role unless it says "owner".

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cashOut,
  currencyExchange,
  driverCollected,
  fileConfirmed,
  iqd,
  officePayment,
  roundHandedIn,
  sentToChina,
  usd,
  walletPayment,
  type EntryDraft,
} from "@green-star/domain";
import { lit, renderPost } from "../src/index.ts";
import {
  USER,
  app,
  balances,
  charge,
  confirmSql,
  customerBalance,
  draftShipmentSql,
  health,
  keyOf,
  newCustomer,
  owner,
  post,
  refused,
  setRate,
} from "./helpers.ts";

test("a balanced entry posts and the balances follow", () => {
  const customerId = newCustomer();
  const id = post(officePayment({ customerId, received: usd(8500) }));
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(customerBalance(customerId), -8500n);
  assert.equal(app(`select count(*) from journal_lines where entry_id = ${lit(id)};`), "2");
});

test("an entry that does not sum to zero is refused and writes nothing", () => {
  const key = randomUUID();
  const before = app("select count(*) from journal_entries;");
  refused(
    () =>
      app(`select gs_post_entry('sent_to_china', now(), ${lit(USER)}, ${lit(key)}, jsonb_build_array(
             jsonb_build_object('account_id', gs_account('china_payable'), 'currency', 'USD', 'amount', 1000),
             jsonb_build_object('account_id', gs_account('vault_usd'), 'currency', 'USD', 'amount', -999)));`),
    /entry_unbalanced/,
  );
  assert.equal(app("select count(*) from journal_entries;"), before);
  assert.equal(app(`select count(*) from journal_entries where idempotency_key = ${lit(key)};`), "0");
});

test("lines inserted by hand are still checked at commit", () => {
  refused(
    () =>
      app(`begin;
           insert into journal_entries (id, kind, happened_at, created_by, idempotency_key)
             values ('aaaaaaaa-0000-4000-8000-000000000001', 'sent_to_china', now(), ${lit(USER)}, ${lit(randomUUID())});
           insert into journal_lines (entry_id, account_id, currency, amount)
             values ('aaaaaaaa-0000-4000-8000-000000000001', gs_account('vault_usd'), 'USD', -500),
                    ('aaaaaaaa-0000-4000-8000-000000000001', gs_account('china_payable'), 'USD', 400);
           commit;`),
    /entry_unbalanced/,
  );
  refused(
    () =>
      app(`insert into journal_entries (kind, happened_at, created_by, idempotency_key)
           values ('sent_to_china', now(), ${lit(USER)}, ${lit(randomUUID())});`),
    /entry_incomplete/,
  );
});

test("the same idempotency key posts once", () => {
  const customerId = newCustomer();
  const key = randomUUID();
  const draft = officePayment({ customerId, received: usd(4000) });
  const first = post(draft, undefined, key);
  const second = post(draft, undefined, key);
  assert.equal(second, first);
  assert.equal(app(`select count(*) from journal_entries where idempotency_key = ${lit(key)};`), "1");
  assert.equal(app(`select balance_usd_cents from customer_balances where customer_id = ${lit(customerId)};`), "-4000");
});

test("nothing in the ledger can be edited or deleted", () => {
  const id = post(officePayment({ customerId: newCustomer(), received: usd(100) }));
  // The app role has no permission at all.
  refused(() => app(`update journal_lines set amount = 1 where entry_id = ${lit(id)};`), /permission denied/);
  refused(() => app(`delete from journal_lines where entry_id = ${lit(id)};`), /permission denied/);
  refused(() => app(`update journal_entries set reason = 'x' where id = ${lit(id)};`), /permission denied/);
  refused(() => app(`delete from journal_entries where id = ${lit(id)};`), /permission denied/);
  refused(() => app("update account_balances set balance = 0;"), /permission denied/);
  // Even the owner role is stopped by the triggers.
  refused(() => owner(`update journal_lines set amount = 1 where entry_id = ${lit(id)};`), /ledger_immutable/);
  refused(() => owner(`delete from journal_entries where id = ${lit(id)};`), /ledger_immutable/);
  refused(() => owner("truncate journal_lines;"), /ledger_immutable/);
});

test("an entry cannot grow after it is posted", () => {
  const id = post(officePayment({ customerId: newCustomer(), received: usd(100) }));
  refused(
    () =>
      app(`insert into journal_lines (entry_id, account_id, currency, amount)
           values (${lit(id)}, gs_account('vault_usd'), 'USD', 50),
                  (${lit(id)}, gs_account('china_payable'), 'USD', -50);`),
    /entry_closed/,
  );
});

test("a line's currency must match its account", () => {
  refused(
    () =>
      app(`select gs_post_entry('sent_to_china', now(), ${lit(USER)}, ${lit(randomUUID())}, jsonb_build_array(
             jsonb_build_object('account_id', gs_account('china_payable'), 'currency', 'IQD', 'amount', 1000),
             jsonb_build_object('account_id', gs_account('vault_iqd'), 'currency', 'IQD', 'amount', -1000)));`),
    /journal_lines_account_currency/,
  );
});

test("dinar payments need the day's rate and convert to the cent", () => {
  const customerId = newCustomer();
  const day = new Date("2026-03-05T08:00:00Z");
  const draft = officePayment({ customerId, received: iqd(123250), ratePer100: 145000 });

  refused(() => post(draft, day), /rate_missing: set the dinar rate for 2026-03-05 first/);

  setRate("2026-03-05", 146000);
  refused(() => post(draft, day), /rate_mismatch/);

  setRate("2026-03-05", 145000);
  post(draft, day);
  assert.equal(app(`select balance_usd_cents from customer_balances where customer_id = ${lit(customerId)};`), "-8500");

  // Right rate, wrong arithmetic: 123,250 IQD credited as $86.00.
  refused(
    () =>
      app(`select gs_post_entry('office_payment', ${lit(day.toISOString())}, ${lit(USER)}, ${lit(randomUUID())}, jsonb_build_array(
             jsonb_build_object('account_id', gs_account('vault_iqd'), 'currency', 'IQD', 'amount', 123250),
             jsonb_build_object('account_id', gs_account('exchange_clearing_iqd'), 'currency', 'IQD', 'amount', -123250),
             jsonb_build_object('account_id', gs_account('exchange_clearing_usd'), 'currency', 'USD', 'amount', 8600),
             jsonb_build_object('account_id', gs_customer_account(${lit(customerId)}), 'currency', 'USD', 'amount', -8600)),
           null, 145000);`),
    /conversion_mismatch/,
  );
});

test("the Baghdad day decides which rate applies", () => {
  // 22:30 UTC on 9 March is 01:30 on 10 March in Baghdad.
  setRate("2026-03-09", 150000);
  setRate("2026-03-10", 145000);
  const late = new Date("2026-03-09T22:30:00Z");
  refused(
    () => post(officePayment({ customerId: newCustomer(), received: iqd(150000), ratePer100: 150000 }), late),
    /rate_mismatch: the rate for 2026-03-10 is 145000/,
  );
  post(officePayment({ customerId: newCustomer(), received: iqd(145000), ratePer100: 145000 }), late);
});

test("a mistake is fixed by an exact reversal, once", () => {
  const customerId = newCustomer();
  setRate("2026-03-12", 147000);
  const day = new Date("2026-03-12T09:00:00Z");
  const id = post(officePayment({ customerId, received: iqd(91250), ratePer100: 147000 }), day);
  assert.equal(app(`select balance_usd_cents from customer_balances where customer_id = ${lit(customerId)};`), "-6207");

  refused(
    () => app(`select gs_reverse_entry(${lit(id)}, ${lit(USER)}, '', ${lit(randomUUID())});`),
    /journal_entries_reason_required/,
  );

  const key = randomUUID();
  const reversal = app(`select gs_reverse_entry(${lit(id)}, ${lit(USER)}, 'Entered on the wrong customer', ${lit(key)});`);
  assert.equal(app(`select balance_usd_cents from customer_balances where customer_id = ${lit(customerId)};`), "0");
  assert.equal(app(`select reverses_id from journal_entries where id = ${lit(reversal)};`), id);

  // A retry with the same key is the same reversal, not a second one.
  assert.equal(app(`select gs_reverse_entry(${lit(id)}, ${lit(USER)}, 'Entered on the wrong customer', ${lit(key)});`), reversal);

  refused(
    () => app(`select gs_reverse_entry(${lit(id)}, ${lit(USER)}, 'again', ${lit(randomUUID())});`),
    /already_reversed/,
  );
  refused(
    () => app(`select gs_reverse_entry(${lit(reversal)}, ${lit(USER)}, 'undo the undo', ${lit(randomUUID())});`),
    /reversal_invalid: a reversal cannot be reversed/,
  );
});

test("a reversal that is not the exact mirror is refused", () => {
  const id = post(sentToChina({ amountUsdCents: 5000n }));
  refused(
    () =>
      app(`select gs_post_entry('reversal', now(), ${lit(USER)}, ${lit(randomUUID())}, jsonb_build_array(
             jsonb_build_object('account_id', gs_account('china_payable'), 'currency', 'USD', 'amount', -4000),
             jsonb_build_object('account_id', gs_account('vault_usd'), 'currency', 'USD', 'amount', 4000)),
           'partial undo', null, ${lit(id)});`),
    /reversal_invalid: entry .* is not the exact mirror/,
  );
});

test("cash out needs a reason, and there is no way to post a discount", () => {
  refused(
    () =>
      app(`select gs_post_entry('cash_out', now(), ${lit(USER)}, ${lit(randomUUID())}, jsonb_build_array(
             jsonb_build_object('account_id', gs_account('expense_fuel_car_iqd'), 'currency', 'IQD', 'amount', 25000),
             jsonb_build_object('account_id', gs_account('vault_iqd'), 'currency', 'IQD', 'amount', -25000)));`),
    /journal_entries_reason_required/,
  );
  refused(
    () =>
      app(`select gs_post_entry('discount', now(), ${lit(USER)}, ${lit(randomUUID())}, '[]'::jsonb);`),
    /invalid input value for enum entry_kind/,
  );
  assert.equal(app("select count(*) from accounts where code ilike '%discount%' or code ilike '%write%';"), "0");
});

test("accounts keep their identity", () => {
  refused(() => app("delete from accounts where code = 'vault_usd';"), /permission denied/);
  refused(() => owner("delete from accounts where code = 'vault_usd';"), /account_immutable/);
  refused(() => owner("update accounts set currency = 'IQD' where code = 'vault_usd';"), /account_immutable/);
  refused(
    () => app(`insert into accounts (kind, currency, customer_id, name) values ('customer', 'IQD', ${lit(newCustomer())}, 'x');`),
    /accounts_customer_in_usd/,
  );
});

test("the board's round 14 comes out exactly", () => {
  // Rate today: 1,450 IQD per $1. Four customers on one round.
  setRate("2026-10-02", 145000);
  const day = new Date("2026-10-02T12:00:00Z");
  const round = randomUUID();
  const rebwar = newCustomer("Rebwar A.");
  const shvan = newCustomer("Shvan K.");
  const dara = newCustomer("Dara M.");
  const hemn = newCustomer("Hemn S.");
  const before = balances();

  // One file with all four customers, confirmed in one go.
  const file = randomUUID();
  app(`${draftShipmentSql(file, [[rebwar, 8500n], [shvan, 4000n], [dara, 31000n], [hemn, 6200n]])}\n${confirmSql(file, day)}`);
  // Rebwar paid 123,250 IQD. Shvan's goods are held. Dara is on account. Hemn was delivered, not paid.
  post(driverCollected({ roundId: round, customerId: rebwar, received: iqd(123250), ratePer100: 145000 }), day);
  // The driver hands in 123,250 IQD and no dollars.
  post(roundHandedIn({ roundId: round, countedUsdCents: 0n, countedIqd: 123250n }), day);

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
  assert.equal(health(), "");
});

test("a short hand-in leaves the gap on the round", () => {
  const round = randomUUID();
  const customerId = newCustomer();
  charge(customerId, 10000n);
  post(driverCollected({ roundId: round, customerId, received: usd(10000) }));
  post(roundHandedIn({ roundId: round, countedUsdCents: 9500n, countedIqd: 0n }));
  assert.equal(balances().get(`driver:${round}:USD`), 500n);
});

test("random payments in both currencies always balance", () => {
  let seed = 20261002;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const pick = <T>(items: readonly T[]): T => items[next(items.length)]!;

  const days = [
    { at: new Date("2026-04-01T09:00:00Z"), day: "2026-04-01", rate: 147250 },
    { at: new Date("2026-04-02T09:00:00Z"), day: "2026-04-02", rate: 152750 },
    { at: new Date("2026-04-03T21:30:00Z"), day: "2026-04-04", rate: 131000 },
  ];
  for (const d of days) setRate(d.day, d.rate);

  const customers = Array.from({ length: 8 }, () => newCustomer());
  const rounds = Array.from({ length: 3 }, () => randomUUID());
  const start = balances();
  const model = new Map<string, bigint>();
  const apply = (draft: EntryDraft, sign: bigint) => {
    for (const line of draft.lines) {
      const key = keyOf(line.account);
      model.set(key, (model.get(key) ?? 0n) + sign * line.amount);
    }
  };

  const posted: { id: string; draft: EntryDraft; reversed: boolean }[] = [];
  let entries = 0;
  let clock = 0;

  for (let batch = 0; batch < 8; batch++) {
    const statements: string[] = [];
    const pending: ({ draft: EntryDraft } | { reverse: number } | { charge: true })[] = [];

    for (let i = 0; i < 60; i++) {
      const d = pick(days);
      const dinars = BigInt((next(4000) + 1) * 250);
      const cents = BigInt(next(500000) + 1);
      const customerId = pick(customers);
      const roundId = pick(rounds);
      const inDinars = next(2) === 0;
      const received = inDinars ? iqd(dinars) : usd(cents);
      const rate = inDinars ? { ratePer100: d.rate } : {};
      let draft: EntryDraft;

      switch (next(9)) {
        case 0: {
          // A charge goes through a file. A prepaid one ($0) posts nothing.
          const amount = BigInt(next(3) === 0 ? 0 : next(90000) + 1);
          const file = randomUUID();
          clock += 1;
          statements.push(`${draftShipmentSql(file, [[customerId, amount]])}\n${confirmSql(file, new Date(d.at.getTime() + clock))}`);
          pending.push({ charge: true });
          const charged = fileConfirmed({ customerId, amountDueUsdCents: amount });
          if (charged) apply(charged, 1n);
          continue;
        }
        case 1:
          draft = driverCollected({ roundId, customerId, received, ...rate });
          break;
        case 2:
          draft = officePayment({ customerId, received, ...rate });
          break;
        case 3:
          draft = walletPayment({ customerId, wallet: pick(["fib", "fastpay", "zaincash"] as const), received, ...rate });
          break;
        case 4:
          draft = roundHandedIn({ roundId, countedUsdCents: BigInt(next(2) * (next(50000) + 1)), countedIqd: dinars });
          break;
        case 5:
          draft = sentToChina({ amountUsdCents: cents });
          break;
        case 6:
          draft = cashOut({
            category: pick(["driver_pay", "fuel_car", "customs_airport", "rent_salaries", "other"] as const),
            amount: received,
            reason: "Random test",
          });
          break;
        case 7:
          draft = currencyExchange({ iqdGiven: dinars, usdCentsReceived: cents });
          break;
        case 8: {
          const candidates = posted.map((p, index) => ({ p, index })).filter((c) => !c.p.reversed);
          if (candidates.length > 0) {
            const { p, index } = pick(candidates);
            p.reversed = true;
            statements.push(
              `select gs_reverse_entry(${lit(p.id)}, ${lit(USER)}, 'Random test reversal', ${lit(randomUUID())});`,
            );
            pending.push({ reverse: index });
            apply(p.draft, -1n);
          }
          continue;
        }
        default:
          throw new Error("unreachable");
      }
      statements.push(renderPost(draft, { happenedAt: d.at, createdBy: USER, idempotencyKey: randomUUID() }));
      pending.push({ draft });
      apply(draft, 1n);
    }

    const ids = app(statements.join("\n")).split("\n").filter(Boolean);
    assert.equal(ids.length, pending.length);
    pending.forEach((item, index) => {
      if ("draft" in item) posted.push({ id: ids[index]!, draft: item.draft, reversed: false });
    });
    entries += ids.length;
  }

  assert.ok(entries > 350, `expected a few hundred entries, posted ${entries}`);

  const end = balances();
  for (const [key, expected] of model) {
    const actual = (end.get(key) ?? 0n) - (start.get(key) ?? 0n);
    assert.equal(actual, expected, `balance of ${key}`);
  }
  for (const [key, value] of end) {
    if (!model.has(key)) assert.equal(value, start.get(key) ?? 0n, `untouched account ${key} moved`);
  }
  assert.equal(app("select string_agg(currency || ':' || total, ',' order by currency) from (select currency, sum(amount) as total from journal_lines group by currency) t;"), "USD:0,IQD:0");
  assert.equal(health(), "");
});
