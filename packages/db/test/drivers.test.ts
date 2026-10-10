// The driver's own account, his receipts, change at the door, and the
// delivery costs, proven against a real Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cashOut, usd } from "@green-star/domain";
import { lit, renderPost } from "../src/index.ts";
import { USER, app, charge, customerBalance, enterResult, handIn, health, newCustomer, newDriver, newRound, post, refused, roundOut, setRate } from "./helpers.ts";

// These tests keep to their own days.
const RATE = 150000; // 1,500 per dollar: $10 is 15,000 IQD
setRate("2026-08-04", RATE);
setRate("2026-08-05", 152000);
const at = (hour = 9, day = 4) => new Date(Date.UTC(2026, 7, day, hour));

const on = (code: string) => BigInt(app(`select coalesce((select balance from account_overview where code = ${lit(code)}), 0);`));
const holds = (driverId: string, currency: "USD" | "IQD" = "IQD") =>
  BigInt(app(`select ${currency === "USD" ? "holds_usd_cents" : "holds_iqd"} from driver_accounts where driver_id = ${lit(driverId)};`));

/** Money given, a receipt, or money back. Returns the entry. */
function money(what: string, driverId: string, currency: "USD" | "IQD", amount: bigint | number, more: { category?: string; roundId?: string; city?: string; note?: string; when?: Date; key?: string } = {}): string {
  const v = (x: string | undefined) => (x === undefined ? "null" : lit(x));
  return app(
    `select gs_driver_money(${lit(more.key ?? randomUUID())}, ${lit(what)}, ${lit(driverId)}, ${lit(currency)}, ${amount}, ${lit(USER)}, ${lit((more.when ?? at()).toISOString())}, ${v(more.category)}, ${v(more.roundId)}, ${v(more.city)}, ${v(more.note)});`,
  );
}

test("the driver is given money from the vault, brings back receipts, and gives back what is left", () => {
  const driver = newDriver("Hemin");
  const round = newRound([], driver);
  const vault = on("vault_iqd");
  const fuel = on("expense_fuel_car_iqd");

  const key = randomUUID();
  const given = money("advance", driver, "IQD", 500000, { roundId: round, note: "For the Erbil trip", key });
  assert.equal(money("advance", driver, "IQD", 500000, { roundId: round, key }), given, "the same request again is the same entry");
  assert.equal(holds(driver), 500000n);
  assert.equal(on("vault_iqd") - vault, -500000n, "it left the vault");

  money("expense", driver, "IQD", 40000, { category: "fuel_car", roundId: round, city: "Erbil" });
  money("expense", driver, "IQD", 75000, { category: "transport", roundId: round, city: "Erbil", note: "Goods sent on to Erbil" });
  money("expense", driver, "IQD", 10000, { category: "workers" });
  assert.equal(holds(driver), 375000n);
  assert.equal(on("expense_fuel_car_iqd") - fuel, 40000n);
  money("return", driver, "IQD", 300000);
  assert.equal(holds(driver), 75000n, "he keeps the rest for the next round");
  assert.equal(on("vault_iqd") - vault, -200000n);

  assert.equal(
    app(`select string_agg(kind || ':' || amount || ':' || balance_after || ':' || coalesce(category, '-') || ':' || coalesce(city, '-'), ' ' order by happened_at, created_at, line_id) from driver_account_lines where driver_id = ${lit(driver)};`),
    "driver_advance:500000:500000:-:- driver_expense:-40000:460000:fuel_car:Erbil driver_expense:-75000:385000:transport:Erbil driver_expense:-10000:375000:workers:- driver_return:-300000:75000:-:-",
  );
  assert.equal(app(`select count(*) from driver_account_lines where driver_id = ${lit(driver)} and round_id = ${lit(round)};`), "3");

  // A wrong receipt is reversed and entered again; nothing is edited.
  const wrong = money("expense", driver, "IQD", 99000, { category: "car_parts" });
  app(`select gs_reverse_entry(${lit(wrong)}, ${lit(USER)}, 'Typed 99,000 for 9,000', ${lit(randomUUID())}, ${lit(at(10).toISOString())});`);
  money("expense", driver, "IQD", 9000, { category: "car_parts" });
  assert.equal(holds(driver), 66000n);
  assert.equal(app(`select reversed from driver_account_lines where entry_id = ${lit(wrong)};`), "t");
  refused(() => app(`update expense_details set city = 'Duhok' where entry_id = ${lit(wrong)};`), /permission denied|ledger_immutable|forbid|cannot be changed/);

  // He can spend more than he holds: then the office owes him.
  money("expense", driver, "USD", 2500, { category: "car_parts" });
  assert.equal(holds(driver, "USD"), -2500n);
  assert.equal(health(), "");
});

test("the driver's account moves only the ways it is meant to", () => {
  const driver = newDriver("Rules");
  refused(() => money("expense", driver, "IQD", 1000), /category_invalid/);
  refused(() => money("expense", driver, "IQD", 1000, { category: "lunch" }), /category_invalid/);
  refused(() => money("advance", driver, "IQD", 0), /amount_invalid/);
  refused(() => money("bonus", driver, "IQD", 1000), /driver_money_invalid/);
  refused(() => money("advance", randomUUID(), "IQD", 1000), /driver_not_found/);
  const off = newDriver("Switched off driver");
  app(`update drivers set active = false where id = ${lit(off)};`);
  refused(() => money("advance", off, "IQD", 1000), /driver_inactive/);

  // Nothing else can move it: not a cash out, not a payment, not by hand.
  money("advance", driver, "IQD", 50000);
  const float = app(`select id from accounts where kind = 'driver_float' and driver_id = ${lit(driver)} and currency = 'IQD';`);
  const raw = (kind: string, a: string, b: string) =>
    app(`select gs_post_entry(${lit(kind)}::entry_kind, now(), ${lit(USER)}, ${lit(randomUUID())}, jsonb_build_array(
      jsonb_build_object('account_id', ${a}, 'currency', 'IQD', 'amount', -1000),
      jsonb_build_object('account_id', ${b}, 'currency', 'IQD', 'amount', 1000)), 'by hand');`);
  refused(() => raw("cash_out", lit(float), "gs_account('expense_other_iqd')"), /entry_shape/);
  refused(() => raw("currency_exchange", lit(float), "gs_account('vault_iqd')"), /entry_shape/);
  refused(() => raw("driver_expense", "gs_account('vault_iqd')", "gs_account('expense_other_iqd')"), /entry_shape/);
  refused(() => app(`insert into accounts (kind, currency, name) values ('driver_float', 'IQD', 'Nobody');`), /accounts_system_has_code|accounts_driver_float_has_driver/);
  assert.equal(holds(driver), 50000n);
  assert.equal(health(), "");
});

test("change at the door: $500 for $490 of goods, 15,000 IQD back from the driver's account, and he owes nothing", () => {
  const customer = newCustomer("Paid Five Hundred");
  const { consignmentId } = charge(customer, 49000n, at(5));
  const driver = newDriver("Change Giver");
  const round = newRound([consignmentId], driver);
  app(`select gs_round_depart(${lit(round)}, ${lit(USER)}, ${lit(at(6).toISOString())});`);
  money("advance", driver, "IQD", 500000);

  const result = enterResult({ roundId: round, consignmentId, outcome: "paid", received: { amount: 50000, currency: "USD" }, change: 15000, at: at(11) });
  assert.equal(customerBalance(customer), 0n);
  assert.equal(holds(driver), 485000n, "the 15,000 came off his account");
  assert.equal(app(`select collected from round_cash where round_id = ${lit(round)} and currency = 'USD';`), "50000", "the round's cash is the $500 he took");
  assert.equal(app(`select coalesce((select collected from round_cash where round_id = ${lit(round)} and currency = 'IQD'), 0);`), "0");
  assert.equal(app(`select credited_usd_cents || '|' || change_iqd from round_results where id = ${lit(result)};`), "49000|15000");
  assert.equal(app(`select (payments -> 0 ->> 'change_iqd') from round_stop_details where consignment_id = ${lit(consignmentId)};`), "15000");
  assert.equal(app(`select kind || ':' || amount || ':' || customer_name from driver_account_lines where driver_id = ${lit(driver)} and kind = 'driver_collected';`), "driver_collected:-15000:Paid Five Hundred");
  assert.equal(health(), "");

  // He hands in the $500; the change is not round cash.
  handIn(round, { usd: { 10000: 5 }, at: at(15) });
  assert.equal(app(`select gap from round_cash where round_id = ${lit(round)} and currency = 'USD';`), "0");

  // Taking the result back puts the change back on his account.
  const again = newCustomer("Taken Back");
  const second = charge(again, 49000n, at(5)).consignmentId;
  const round2 = newRound([second], driver);
  app(`select gs_round_depart(${lit(round2)}, ${lit(USER)}, ${lit(at(6).toISOString())});`);
  const r2 = enterResult({ roundId: round2, consignmentId: second, outcome: "paid", received: { amount: 50000, currency: "USD" }, change: 15000, at: at(11) });
  assert.equal(holds(driver), 470000n);
  app(`select gs_void_round_result(${lit(r2)}, ${lit(USER)}, 'Wrong stop');`);
  assert.equal(holds(driver), 485000n);
  assert.equal(customerBalance(again), 49000n);
  assert.equal(health(), "");
});

test("change that comes near what he owes settles it; the cents go to Dinar rounding", () => {
  // At 1,520 per dollar, 15,000 IQD is $9.87: exactly he paid $490.13. It settles $490.00.
  const customer = newCustomer("Rounded Change");
  const { consignmentId } = charge(customer, 49000n, at(5, 5));
  const driver = newDriver("Rounder");
  const round = newRound([consignmentId], driver);
  app(`select gs_round_depart(${lit(round)}, ${lit(USER)}, ${lit(at(6, 5).toISOString())});`);
  const rounding = on("dinar_rounding_usd");
  enterResult({ roundId: round, consignmentId, outcome: "paid", received: { amount: 50000, currency: "USD" }, change: 15000, at: at(11, 5) });
  assert.equal(customerBalance(customer), 0n);
  assert.equal(on("dinar_rounding_usd") - rounding, -13n, "13 cents the rounding gave");
  assert.equal(holds(driver), -15000n, "he gave change from his own pocket: the office owes him");

  // Change far from what he owes is not rounded: he is in credit for the difference.
  const other = newCustomer("Too Much Change");
  const c2 = charge(other, 40000n, at(5, 5)).consignmentId;
  const round2 = newRound([c2], driver);
  app(`select gs_round_depart(${lit(round2)}, ${lit(USER)}, ${lit(at(6, 5).toISOString())});`);
  enterResult({ roundId: round2, consignmentId: c2, outcome: "paid", received: { amount: 50000, currency: "USD" }, change: 15000, at: at(11, 5) });
  assert.equal(customerBalance(other), -9013n, "$500 less $9.87 is $490.13: $90.13 in credit");
  assert.equal(health(), "");
});

test("change is given only in dinars, on dollars paid to the round's own driver, and less than the dollars", () => {
  const customer = newCustomer("Change Rules");
  const { consignmentId } = charge(customer, 49000n, at(5));
  const round = roundOut([consignmentId], at(6));
  const stop = { roundId: round, consignmentId, outcome: "paid" as const, at: at(11) };
  refused(() => enterResult({ ...stop, received: { amount: 735000, currency: "IQD" }, change: 15000 }), /change_invalid: change is given back in dinars, on dollars the driver took/);
  refused(() => enterResult({ ...stop, received: { amount: 50000, currency: "USD", method: "fib" }, change: 15000 }), /change_invalid/);
  refused(() => enterResult({ ...stop, received: { amount: 50000, currency: "USD" }, change: 0 }), /change_invalid/);
  refused(() => enterResult({ ...stop, received: { amount: 1000, currency: "USD" }, change: 15000 }), /change_invalid: 15000 IQD of change is worth as much as the \$10\.00 he paid/);
  // A round carried by a transport office has no driver to give change.
  const carrier = randomUUID();
  app(`insert into carriers (id, name, kind) values (${lit(carrier)}, 'Erbil office', 'transport_office');`);
  const office = randomUUID();
  const goods = charge(newCustomer("By Carrier"), 49000n, at(5)).consignmentId;
  app(`insert into rounds (id, carrier_id, created_by) values (${lit(office)}, ${lit(carrier)}, ${lit(USER)});
       select gs_add_round_stop(${lit(office)}, ${lit(goods)}, ${lit(USER)});
       select gs_round_depart(${lit(office)}, ${lit(USER)}, ${lit(at(6).toISOString())});`);
  refused(() => enterResult({ roundId: office, consignmentId: goods, outcome: "paid", received: { amount: 50000, currency: "USD" }, change: 15000, at: at(11) }), /this round has no driver/);
  assert.equal(customerBalance(customer), 49000n);
  assert.equal(health(), "");
});

test("every expense is read in one list, in dollars at the day's rate, with its city and round", () => {
  const driver = newDriver("Costs");
  const round = newRound([], driver);
  const fuel = money("expense", driver, "IQD", 30000, { category: "fuel_car", roundId: round, city: "Sulaymaniyah", when: at(9, 4) });
  // Paid from the vault at the office: it can say the same.
  const key = randomUUID();
  app(
    `begin;
     ${renderPost(cashOut({ category: "transport", amount: usd(4000n), reason: "Erbil transport company" }), { happenedAt: at(10, 4), createdBy: USER, idempotencyKey: key })}
     select gs_note_expense((select id from journal_entries where idempotency_key = ${lit(key)}), ${lit(round)}, 'Erbil');
     commit;`,
  );
  refused(() => app(`select gs_note_expense(${lit(fuel)}, null, 'Erbil');`), /entry_closed/);
  // Rent is an expense, not a delivery cost.
  post(cashOut({ category: "rent_salaries", amount: usd(50000n), reason: "Rent" }), at(11, 4));

  assert.equal(
    app(`select string_agg(category || ':' || delivery || ':' || currency || ':' || amount || ':' || usd_cents || ':' || coalesce(city, '-') || ':' || paid_from, ' ' order by happened_at)
         from expense_lines where day = '2026-08-04' and (driver_id = ${lit(driver)} or paid_from = 'vault');`),
    "fuel_car:true:IQD:30000:2000:Sulaymaniyah:driver transport:true:USD:4000:4000:Erbil:vault rent_salaries:false:USD:50000:50000:-:vault",
  );
  // A day with no rate is counted at the nearest one.
  money("expense", driver, "IQD", 15000, { category: "fuel_car", when: new Date(Date.UTC(2026, 7, 9, 9)) });
  assert.equal(app(`select usd_cents from expense_lines where day = '2026-08-09';`), "987", "at 1,520, the nearest day before");
  // A reversal is the exact mirror in dollars too.
  assert.equal(app(`select sum(usd_cents) from expense_lines where entry_id = ${lit(fuel)} or reverses_id = ${lit(fuel)};`), "2000");
  app(`select gs_reverse_entry(${lit(fuel)}, ${lit(USER)}, 'Not ours', ${lit(randomUUID())}, ${lit(at(12, 4).toISOString())});`);
  assert.equal(app(`select sum(usd_cents) from expense_lines where entry_id = ${lit(fuel)} or reverses_id = ${lit(fuel)};`), "0");
  assert.equal(health(), "");
});
