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

  const ran = migrate(url);
  assert.equal(ran[0], "0010_only_the_ceo.sql");

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
  assert.equal(sql("select count(*) from customers;"), "1");
  sql("insert into users (name, phone) values ('Second CEO', '+9647700000003');");
  assert.equal(sql("select role from users where name = 'Second CEO';"), "ceo");

  // What the office screen showed went with it.
  refused(() => sql("select monitor_widgets from settings;"), /does not exist/);
  refused(() => sql("select gs_widgets_valid('{files}');"), /does not exist/);
  assert.equal(sql("select held_in_car_days || '|' || wallet_check_days from settings;"), "3|7");
  assert.equal(sql("select count(*) from gs_ledger_health();"), "0");
});
