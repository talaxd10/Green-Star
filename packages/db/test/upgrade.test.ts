// A migration that changes rows already there is proven on a database that
// has such rows: built up to the migration before it, filled, then upgraded.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { lit, psql, PsqlError, requireEnv, withActor } from "../src/index.ts";
import { migrate } from "../scripts/migrate.ts";

const base = new URL(requireEnv("DATABASE_URL"));
const name = `${base.pathname.slice(1)}_upgrade`;
assert.match(name, /^[a-z_][a-z0-9_]*test[a-z0-9_]*$/, "only ever a test database");
const admin = new URL(base);
admin.pathname = "/postgres";
const scratch = new URL(base);
scratch.pathname = `/${name}`;
const url = scratch.toString();
const sql = (text: string) => psql(url, text);
/** As the application, acting as this user. */
const appLogin = new URL(requireEnv("APP_DATABASE_URL_NO_ACTOR"));
appLogin.pathname = `/${name}`;
const appAs = (userId: string) => (text: string) => psql(withActor(appLogin.toString(), userId), text);

psql(admin.toString(), `drop database if exists ${name} with (force);`);
psql(admin.toString(), `create database ${name};`);
after(() => psql(admin.toString(), `drop database if exists ${name} with (force);`));

const refused = (run: () => unknown, pattern: RegExp) =>
  assert.throws(run, (error: unknown) => error instanceof PsqlError && pattern.test(error.stderr));

test("an office that had an owner and an office screen: both are switched off and signed out, and stay off", () => {
  migrate(url, "0009_statements.sql");
  sql(`grant green_star_app to ${decodeURIComponent(appLogin.username)}; grant connect on database ${name} to ${decodeURIComponent(appLogin.username)};`);
  const ceo = "11111111-1111-4111-8111-111111111111";
  const owner = "22222222-2222-4222-8222-222222222222";
  const screen = "33333333-3333-4333-8333-333333333333";
  sql(`insert into users (id, name, role, phone) values (${lit(ceo)}, 'Sarkar', 'ceo', '+9647700000001');
       insert into users (id, name, role, phone, created_by) values (${lit(owner)}, 'Kak Azad', 'owner', '+9647700000002', ${lit(ceo)});
       insert into users (id, name, role, sign_in_name, created_by) values (${lit(screen)}, 'Office TV', 'monitor', 'office-tv', ${lit(ceo)});
       insert into sessions (user_id, token_hash, expires_at)
       select id, sha256(convert_to(name || n, 'UTF8')), now() + interval '14 days' from users, generate_series(1, 2) n;
       update sessions set revoked_at = now() - interval '1 day', revoked_by = ${lit(ceo)}
        where token_hash = sha256(convert_to('Kak Azad2', 'UTF8'));`);
  assert.equal(sql("select count(*) from sessions where revoked_at is null;"), "5");
  // Each of them can act before the change: the owner and the screen as far as their role went.
  appAs(ceo)(`select gs_set_rate('2026-01-01', 145000, ${lit(ceo)}, true);`);
  refused(() => appAs(owner)("insert into customers (display_name) values ('By the owner');"), /ceo_only/);

  // And the office has money on the books from before: a file, a round, a customer who paid the driver
  // 89,000 dinars for $62.00 (89,900 at 1,450). Before the rounding rule that was $61.38, and 62 cents were left owed.
  const customer = "44444444-4444-4444-8444-444444444444";
  const shipment = "55555555-5555-4555-8555-555555555555";
  const consignment = "66666666-6666-4666-8666-666666666666";
  const driver = "77777777-7777-4777-8777-777777777777";
  const round = "88888888-8888-4888-8888-888888888888";
  const oldResult = "99999999-aaaa-4aaa-8aaa-999999999999";
  appAs(ceo)(`
    insert into customers (id, display_name) values (${lit(customer)}, 'From before');
    insert into shipments (id, code) values (${lit(shipment)}, 'GSSK-BEFORE');
    insert into consignments (id, shipment_id, customer_id, amount_due_usd_cents) values (${lit(consignment)}, ${lit(shipment)}, ${lit(customer)}, 6200);
    select gs_confirm_shipment(${lit(shipment)}, ${lit(ceo)}, '2026-01-01T05:00:00Z');
    insert into drivers (id, name) values (${lit(driver)}, 'Karwan');
    insert into rounds (id, driver_id, created_by) values (${lit(round)}, ${lit(driver)}, ${lit(ceo)});
    select gs_add_round_stop(${lit(round)}, ${lit(consignment)}, ${lit(ceo)});
    select gs_round_depart(${lit(round)}, ${lit(ceo)}, '2026-01-01T06:00:00Z');
    select gs_enter_round_result(${lit(oldResult)}, ${lit(round)}, ${lit(consignment)}, 'paid', ${lit(ceo)}, '2026-01-01T09:00:00Z', 89000, 'IQD', 'driver_cash');`);
  const owes = () => sql(`select balance_usd_cents from customer_balances where customer_id = ${lit(customer)};`);
  assert.equal(owes(), "62");

  const ran = migrate(url);
  assert.equal(ran[0], "0010_only_the_ceo.sql");
  assert.ok(ran.includes("0013_round_payment_parts.sql"));

  const accounts = sql("select role || ':' || active || ':' || (select count(*) from sessions s where s.user_id = u.id and s.revoked_at is null) from users u order by role;");
  assert.equal(accounts, "ceo:true:2\nowner:false:0\nmonitor:false:0");
  // A session that had already been ended keeps who ended it and when.
  assert.equal(
    sql("select revoked_by || ':' || (revoked_at < now() - interval '23 hours') from sessions where token_hash = sha256(convert_to('Kak Azad2', 'UTF8'));"),
    `${ceo}:true`,
  );
  // The ones the change ended say so themselves.
  assert.equal(sql(`select count(*) from sessions where revoked_by = user_id and user_id in (${lit(owner)}, ${lit(screen)});`), "3");

  // They stay off: nothing switches one on again, makes it a CEO, or makes another.
  for (const who of [owner, screen]) {
    refused(() => sql(`update users set active = true where id = ${lit(who)};`), /users_only_the_ceo/);
    refused(() => sql(`update users set role = 'ceo', active = true where id = ${lit(who)};`), /user_locked/);
    refused(() => sql(`update users set name = 'Renamed' where id = ${lit(who)};`), /users_only_the_ceo/);
    refused(() => sql(`delete from users where id = ${lit(who)};`), /user_kept/);
    refused(() => appAs(who)("insert into customers (display_name) values ('By a ghost');"), /actor_unknown/);
    refused(() => appAs(who)(`select gs_set_rate('2026-01-02', 145000, ${lit(who)}, true);`), /actor_unknown/);
  }
  refused(() => sql("insert into users (name, role, phone) values ('New owner', 'owner', '+9647700000009');"), /users_only_the_ceo/);
  refused(() => sql("insert into users (name, role, sign_in_name) values ('New TV', 'monitor', 'tv-two');"), /users_only_the_ceo/);

  // The CEO is untouched, what he did is still his, and he carries on.
  assert.equal(sql(`select name || ':' || active from users where id = ${lit(ceo)};`), "Sarkar:true");
  assert.equal(sql("select u.name from fx_rates r join users u on u.id = r.set_by where r.day = '2026-01-01';"), "Sarkar");
  appAs(ceo)(`select gs_set_rate('2026-01-02', 146000, ${lit(ceo)}, true);`);
  appAs(ceo)("insert into customers (display_name) values ('After');");
  assert.equal(sql("select count(*) from customers where display_name = 'After';"), "1");
  sql("insert into users (name, phone) values ('Second CEO', '+9647700000003');");
  assert.equal(sql("select role from users where name = 'Second CEO';"), "ceo");

  // The money from before is as it was: nothing already on the books is rounded after the fact.
  assert.equal(owes(), "62");
  assert.equal(sql(`select credited_usd_cents from round_results where id = ${lit(oldResult)};`), "6138");
  // The old result reads as a result with one payment, and the new settings and accounts are there.
  assert.equal(
    sql(`select jsonb_array_length(payments) || '|' || (payments -> 0 ->> 'received_amount') || '|' || (payments -> 0 ->> 'credited_usd_cents') from round_stop_details where consignment_id = ${lit(consignment)};`),
    "1|89000|6138",
  );
  assert.equal(sql("select count(*) from round_payment_entries;"), "1");
  assert.equal(sql("select dinar_rounding_iqd from settings;"), "1000");
  assert.equal(sql("select string_agg(code || ':' || balance, ' ' order by code) from account_overview where kind = 'adjustment';"), "dinar_rounding_usd:0 errors_usd:0");

  // The 62 cents from before can be let go with an Error entry, and that can be taken back.
  const error = appAs(ceo)(`select gs_post_entry('error_correction', '2026-01-01T10:00:00Z', ${lit(ceo)}, 'upgrade-error', jsonb_build_array(
    jsonb_build_object('account_id', gs_account('errors_usd'), 'currency', 'USD', 'amount', 62),
    jsonb_build_object('account_id', gs_customer_account(${lit(customer)}), 'currency', 'USD', 'amount', -62)));`);
  assert.equal(owes(), "0");
  assert.equal(sql(`select status from consignments where id = ${lit(consignment)};`), "delivered_paid");
  appAs(ceo)(`select gs_reverse_entry(${lit(error)}, ${lit(ceo)}, 'entered again the new way', 'upgrade-error-back', '2026-01-01T10:30:00Z');`);
  assert.equal(owes(), "62");

  // The stop is entered again the new way: $50 and 17,000 dinars for the other $12.00 (17,400 exactly).
  appAs(ceo)(`select gs_enter_round_result(gen_random_uuid(), ${lit(round)}, ${lit(consignment)}, 'paid', ${lit(ceo)}, '2026-01-01T09:00:00Z', 5000, 'USD', 'driver_cash', null,
                 '[{"amount": 17000, "currency": "IQD", "method": "driver_cash"}]'::jsonb);`);
  assert.equal(owes(), "0");
  assert.equal(sql(`select voided_at is not null from round_results where id = ${lit(oldResult)};`), "t");
  assert.equal(sql("select string_agg(part_no || ':' || credited_usd_cents || ':' || voided, ' ' order by voided desc, part_no) from round_payment_entries;"), "1:6138:true 1:5000:false 2:1200:false");
  assert.equal(sql("select balance from account_overview where code = 'dinar_rounding_usd';"), "28");
  assert.equal(sql(`select string_agg(currency || ':' || collected, ' ' order by currency) from round_cash where round_id = ${lit(round)};`), "USD:5000 IQD:17000");

  // What the office screen showed went with it.
  refused(() => sql("select monitor_widgets from settings;"), /does not exist/);
  refused(() => sql("select gs_widgets_valid('{files}');"), /does not exist/);
  assert.equal(sql("select held_in_car_days || '|' || wallet_check_days from settings;"), "3|7");
  assert.equal(sql("select count(*) from gs_ledger_health();"), "0");
});
