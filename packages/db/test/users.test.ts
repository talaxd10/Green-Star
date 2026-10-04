// Who can change what, proven against a real Postgres.
// One kind of account: the CEO's. Nothing else can sign in or be made.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { officePayment, usd } from "@green-star/domain";
import { lit, renderPost } from "../src/index.ts";
import {
  USER,
  app,
  appAs,
  appNoActor,
  confirmSql,
  customerBalance,
  draftShipmentSql,
  health,
  newCeo,
  newCustomer,
  owner,
  refused,
  retire,
  switchedOff,
} from "./helpers.ts";

const HASH = "scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g";
let phoneCounter = 0;
const nextPhone = () => `+96477${(10000000 + ++phoneCounter).toString()}`;

const paymentSql = (createdBy: string, customerId: string) =>
  renderPost(officePayment({ customerId, received: usd(1000) }), {
    happenedAt: new Date("2026-10-03T09:00:00Z"),
    createdBy,
    idempotencyKey: randomUUID(),
  });

test("every name on the books is a real user", () => {
  const customerId = newCustomer();
  const stranger = randomUUID();
  // The entry names someone who is not the one acting.
  refused(() => app(paymentSql(stranger, customerId)), /actor_mismatch/);
  // Outside the ledger it is the same: the application can only name the one acting,
  const driver = randomUUID();
  app(`insert into drivers (id, name) values (${lit(driver)}, 'Karwan');`);
  const roundSql = `insert into rounds (driver_id, created_by) values (${lit(driver)}, ${lit(stranger)});`;
  const fileSql = `insert into source_files (filename, storage_key, sha256, uploaded_by)
                   values ('x.xlsx', 'files/x', ${lit("a".repeat(64))}, ${lit(stranger)});`;
  refused(() => app(roundSql), /actor_mismatch/);
  refused(() => app(fileSql), /actor_mismatch/);
  // and nobody at all can write a name that is not a user.
  refused(() => owner(roundSql), /rounds_created_by_fk/);
  refused(() => owner(fileSql), /source_files_uploaded_by_fk/);
  assert.equal(customerBalance(customerId), 0n);
});

test("the application must say who is acting", () => {
  const customerId = newCustomer();
  refused(() => appNoActor(paymentSql(USER, customerId)), /actor_required/);
  refused(
    () => appNoActor(`insert into users (name, role, phone) values ('Nobody', 'ceo', ${lit(nextPhone())});`),
    /actor_required/,
  );
  refused(() => appAs(randomUUID())(paymentSql(USER, customerId)), /actor_unknown/);
  refused(
    () => owner(`set gs.actor = 'not-a-uuid'; insert into users (name, role, phone) values ('Bad', 'ceo', ${lit(nextPhone())});`),
    /actor_invalid/,
  );
  assert.equal(customerBalance(customerId), 0n);
});

test("no account can be made that is not a CEO's", () => {
  const before = app("select count(*) from users;");
  const owner1 = `insert into users (name, role, phone, created_by) values ('The owner', 'owner', ${lit(nextPhone())}, ${lit(USER)});`;
  const screen = `insert into users (name, role, sign_in_name, created_by) values ('Office TV', 'monitor', 'office-tv', ${lit(USER)});`;
  refused(() => app(owner1), /users_only_the_ceo/);
  refused(() => app(screen), /users_only_the_ceo/);
  // Not by hand either.
  refused(() => owner(owner1), /users_only_the_ceo/);
  refused(() => owner(screen), /users_only_the_ceo/);
  assert.equal(app("select count(*) from users;"), before);
  assert.equal(app("select count(*) from users where role <> 'ceo';"), "0");
  // An account is a CEO's unless it says otherwise, and it cannot say otherwise.
  const id = randomUUID();
  app(`insert into users (id, name, phone, created_by) values (${lit(id)}, 'By default', ${lit(nextPhone())}, ${lit(USER)});`);
  assert.equal(app(`select role from users where id = ${lit(id)};`), "ceo");
  retire(id);
});

test("money is posted by an active CEO acting under his own name", () => {
  const customerId = newCustomer();
  const shipment = randomUUID();
  app(draftShipmentSql(shipment, [[customerId, 5000n]]));
  const off = switchedOff();
  // Under his own name, and under the CEO's name.
  refused(() => appAs(off)(paymentSql(off, customerId)), /actor_unknown/);
  refused(() => appAs(off)(paymentSql(USER, customerId)), /actor_unknown/);
  // The same through the functions that run with the schema owner's rights.
  refused(() => appAs(off)(confirmSql(shipment, new Date("2026-10-03T08:00:00Z"))), /actor_unknown/);
  assert.equal(app(`select status from shipments where id = ${lit(shipment)};`), "draft");
  assert.equal(customerBalance(customerId), 0n);

  // The CEO can.
  app(confirmSql(shipment, new Date("2026-10-03T08:00:00Z")));
  app(paymentSql(USER, customerId));
  assert.equal(customerBalance(customerId), 4000n);
});

test("a CEO who is switched off can post nothing", () => {
  const customerId = newCustomer();
  const second = newCeo();
  appAs(second)(paymentSql(second, customerId));
  assert.equal(customerBalance(customerId), -1000n);

  app(`update users set active = false where id = ${lit(second)};`);
  refused(() => appAs(second)(paymentSql(second, customerId)), /actor_unknown/);
  assert.equal(customerBalance(customerId), -1000n);
});

test("an account that is switched off can add or change no account", () => {
  const off = switchedOff("Was here once");
  const asOff = appAs(off);
  refused(
    () => asOff(`insert into users (name, role, phone, created_by) values ('Friend', 'ceo', ${lit(nextPhone())}, ${lit(off)});`),
    /actor_unknown/,
  );
  refused(() => asOff(`update users set name = 'Boss' where id = ${lit(off)};`), /actor_unknown/);
  refused(() => asOff(`update users set active = true where id = ${lit(off)};`), /actor_unknown/);
  refused(() => asOff(`update users set active = false where id = ${lit(USER)};`), /actor_unknown/);
  assert.equal(app(`select name || ' ' || active from users where id = ${lit(off)};`), "Was here once false");
});

test("an account has a name and a phone, and a phone is used once", () => {
  const phone = nextPhone();
  const first = randomUUID();
  app(`insert into users (id, name, role, phone, created_by) values (${lit(first)}, 'One', 'ceo', ${lit(phone)}, ${lit(USER)});`);
  refused(
    () => app(`insert into users (name, role, phone, created_by) values ('Two', 'ceo', ${lit(phone)}, ${lit(USER)});`),
    /users_phone_key/,
  );
  refused(() => app(`insert into users (name, role, created_by) values ('No phone', 'ceo', ${lit(USER)});`), /users_people_have_a_phone/);
  refused(
    () => app(`insert into users (name, role, phone, created_by) values ('Local', 'ceo', '0770 123 4567', ${lit(USER)});`),
    /users_phone_format/,
  );
  // A sign-in name was the office screen's. A person signs in with his phone.
  refused(
    () => app(`insert into users (name, role, phone, sign_in_name, created_by) values ('Named', 'ceo', ${lit(nextPhone())}, 'office-tv', ${lit(USER)});`),
    /users_monitor_has_a_name/,
  );
  refused(() => app(`insert into users (name, role, phone, created_by) values (' ', 'ceo', ${lit(nextPhone())}, ${lit(USER)});`), /users_name_not_blank/);
  retire(first);
});

test("an account is never deleted, and never becomes another kind", () => {
  const second = newCeo();
  // The application has no right to do either.
  refused(() => app(`update users set role = 'owner' where id = ${lit(second)};`), /permission denied/);
  refused(() => app(`delete from users where id = ${lit(second)};`), /permission denied/);
  // Nor does anyone else.
  refused(() => owner(`update users set role = 'owner' where id = ${lit(second)};`), /user_locked/);
  refused(() => owner(`delete from users where id = ${lit(second)};`), /user_kept/);
  assert.equal(app(`select role from users where id = ${lit(second)};`), "ceo");
  retire(second);
});

test("there is always an active CEO", () => {
  const second = newCeo();
  retire(second);   // one is left
  assert.equal(app("select count(*) from users where role = 'ceo' and active;"), "1");
  // Through the application he cannot switch himself off at all.
  refused(() => app(`update users set active = false where id = ${lit(USER)};`), /own_account/);
  // And nobody can switch off the last one.
  refused(() => owner(`update users set active = false where id = ${lit(USER)};`), /last_ceo/);
  refused(() => owner("update users set active = false where role = 'ceo';"), /last_ceo/);
  assert.equal(app(`select active from users where id = ${lit(USER)};`), "t");
  assert.equal(app("select count(*) from users where role = 'ceo' and active;"), "1");
});

test("a password is set by an active account, and is never written to the log", () => {
  const second = newCeo();
  const off = switchedOff();
  const set = (userId: string, hash = HASH) =>
    `insert into user_credentials (user_id, password_hash) values (${lit(userId)}, ${lit(hash)})
     on conflict (user_id) do update set password_hash = excluded.password_hash;`;

  app(set(second));                                   // the CEO sets it
  const changed = HASH.replace(/.$/, "A");
  appAs(second)(set(second, changed));                // the account changes its own
  assert.equal(app(`select changed_by from user_credentials where user_id = ${lit(second)};`), second);

  refused(() => appAs(off)(set(off)), /actor_unknown/);
  refused(() => appAs(off)(set(second)), /actor_unknown/);
  refused(() => appNoActor(set(second)), /actor_required/);
  refused(() => app(set(second, "hunter2")), /user_credentials_is_a_hash/);
  refused(() => owner(`delete from user_credentials where user_id = ${lit(second)};`), /credentials_kept/);

  const log = app(`select action || '|' || actor || '|' || coalesce(before ->> 'password', '-') || '|' || (after ->> 'password')
                   from audit_log where entity = 'user_credentials' and entity_id = ${lit(second)} order by id;`);
  assert.deepEqual(log.split("\n"), [`insert|${USER}|-|set`, `update|${second}|set|changed`]);
  const everything = app("select coalesce(string_agg(coalesce(before::text, '') || coalesce(after::text, ''), ' '), '') from audit_log;");
  assert.ok(!everything.includes("c2FsdHNhbHRzYWx0c2FsdA"), "a hash reached the audit log");
  retire(second);
});

test("every change to a user is logged with before and after, and the log is never edited", () => {
  const id = newCeo("Aram");
  app(`update users set name = 'Aram H.' where id = ${lit(id)};`);
  app(`update users set name = 'Aram H.' where id = ${lit(id)};`);   // changes nothing: not logged
  app(`update users set active = false where id = ${lit(id)};`);

  const rows = app(`select action || '|' || actor || '|' || coalesce(before ->> 'name', '-') || '|' || (after ->> 'name') || '|' || (after ->> 'active')
                    from audit_log where entity = 'users' and entity_id = ${lit(id)} order by id;`).split("\n");
  assert.deepEqual(rows, [
    `insert|${USER}|-|Aram|true`,
    `update|${USER}|Aram|Aram H.|true`,
    `update|${USER}|Aram H.|Aram H.|false`,
  ]);

  refused(() => app("update audit_log set actor = null;"), /permission denied/);
  refused(() => app("delete from audit_log;"), /permission denied/);
  refused(() => app(`insert into audit_log (action, entity) values ('insert', 'users');`), /permission denied/);
  refused(() => owner("update audit_log set actor = null;"), /ledger_immutable/);
  refused(() => owner("delete from audit_log;"), /ledger_immutable/);
  refused(() => owner("truncate audit_log;"), /ledger_immutable/);
});

test("a session belongs to one user and one device, and can only end", () => {
  const ownerUser = newCeo();
  const id = randomUUID();
  const token = `decode(${lit("ab".repeat(32))}, 'hex')`;
  app(`insert into sessions (id, user_id, token_hash, device, expires_at) values (${lit(id)}, ${lit(ownerUser)}, ${token}, 'Chrome on Windows', now() + interval '14 days');`);
  refused(
    () => app(`insert into sessions (user_id, token_hash, expires_at) values (${lit(USER)}, ${token}, now() + interval '1 day');`),
    /sessions_token_hash_key/,
  );
  refused(
    () => app(`insert into sessions (user_id, token_hash, expires_at) values (${lit(USER)}, decode('abcd', 'hex'), now() + interval '1 day');`),
    /sessions_token_hash_is_sha256/,
  );

  app(`update sessions set last_seen_at = now(), expires_at = now() + interval '14 days' where id = ${lit(id)};`);
  refused(() => app(`update sessions set user_id = ${lit(USER)} where id = ${lit(id)};`), /permission denied/);
  refused(() => owner(`update sessions set user_id = ${lit(USER)} where id = ${lit(id)};`), /session_locked/);
  refused(() => owner(`delete from sessions where id = ${lit(id)};`), /session_kept/);

  app(`update sessions set revoked_at = now(), revoked_by = ${lit(USER)} where id = ${lit(id)};`);
  refused(() => app(`update sessions set revoked_at = null, revoked_by = null where id = ${lit(id)};`), /session_locked/);
  refused(() => app("update sign_in_attempts set succeeded = true;"), /permission denied/);
  retire(ownerUser);
});

test("the books are still sound", () => {
  assert.equal(health(), "");
});
