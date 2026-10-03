// Who can change what, proven against a real Postgres.
// "The owner sees everything" and changes nothing; the monitor is a screen.

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
  newCustomer,
  owner,
  refused,
} from "./helpers.ts";

const HASH = "scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g";
let phoneCounter = 0;
const nextPhone = () => `+96477${(10000000 + ++phoneCounter).toString()}`;

function newUser(role: "ceo" | "owner" | "monitor", name = `Test ${role}`): string {
  const id = randomUUID();
  if (role === "monitor") {
    app(`insert into users (id, name, role, sign_in_name, created_by)
         values (${lit(id)}, ${lit(name)}, 'monitor', ${lit(`screen${++phoneCounter}`)}, ${lit(USER)});`);
  } else {
    app(`insert into users (id, name, role, phone, created_by)
         values (${lit(id)}, ${lit(name)}, ${lit(role)}, ${lit(nextPhone())}, ${lit(USER)});`);
  }
  return id;
}

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
  // Outside the ledger, a name that is not a user is refused by the foreign key.
  const driver = randomUUID();
  app(`insert into drivers (id, name) values (${lit(driver)}, 'Karwan');`);
  refused(
    () => app(`insert into rounds (driver_id, created_by) values (${lit(driver)}, ${lit(stranger)});`),
    /rounds_created_by_fk/,
  );
  refused(
    () => app(`insert into source_files (filename, storage_key, sha256, uploaded_by)
               values ('x.xlsx', 'files/x', ${lit("a".repeat(64))}, ${lit(stranger)});`),
    /source_files_uploaded_by_fk/,
  );
  assert.equal(customerBalance(customerId), 0n);
});

test("the application must say who is acting", () => {
  const customerId = newCustomer();
  refused(() => appNoActor(paymentSql(USER, customerId)), /actor_required/);
  refused(
    () => appNoActor(`insert into users (name, role, phone) values ('Nobody', 'owner', ${lit(nextPhone())});`),
    /actor_required/,
  );
  refused(() => appAs(randomUUID())(paymentSql(USER, customerId)), /actor_unknown/);
  refused(
    () => owner(`set gs.actor = 'not-a-uuid'; insert into users (name, role, phone) values ('Bad', 'owner', ${lit(nextPhone())});`),
    /actor_invalid/,
  );
  assert.equal(customerBalance(customerId), 0n);
});

test("only the CEO posts money: the owner and the monitor never can", () => {
  const customerId = newCustomer();
  const ownerUser = newUser("owner");
  const monitor = newUser("monitor");

  for (const who of [ownerUser, monitor]) {
    // Under his own name, and under the CEO's name.
    refused(() => appAs(who)(paymentSql(who, customerId)), /ceo_only/);
    refused(() => appAs(who)(paymentSql(USER, customerId)), /ceo_only/);
  }
  assert.equal(customerBalance(customerId), 0n);

  // The same through the functions that run with the schema owner's rights.
  const shipment = randomUUID();
  app(draftShipmentSql(shipment, [[customerId, 5000n]]));
  refused(() => appAs(ownerUser)(confirmSql(shipment, new Date("2026-10-03T08:00:00Z"))), /ceo_only/);
  assert.equal(app(`select status from shipments where id = ${lit(shipment)};`), "draft");
  assert.equal(customerBalance(customerId), 0n);

  // The CEO can.
  app(confirmSql(shipment, new Date("2026-10-03T08:00:00Z")));
  app(paymentSql(USER, customerId));
  assert.equal(customerBalance(customerId), 4000n);
});

test("a CEO who is switched off can post nothing", () => {
  const customerId = newCustomer();
  const second = newUser("ceo", "Second CEO");
  appAs(second)(paymentSql(second, customerId));
  assert.equal(customerBalance(customerId), -1000n);

  app(`update users set active = false where id = ${lit(second)};`);
  refused(() => appAs(second)(paymentSql(second, customerId)), /actor_unknown/);
  assert.equal(customerBalance(customerId), -1000n);
});

test("users are added and changed only by a CEO", () => {
  const ownerUser = newUser("owner");
  const asOwner = appAs(ownerUser);
  refused(
    () => asOwner(`insert into users (name, role, phone, created_by) values ('Friend', 'owner', ${lit(nextPhone())}, ${lit(ownerUser)});`),
    /ceo_only/,
  );
  refused(() => asOwner(`update users set name = 'Boss' where id = ${lit(ownerUser)};`), /ceo_only/);
  refused(() => asOwner(`update users set active = false where id = ${lit(USER)};`), /ceo_only/);
  assert.equal(app(`select name || ' ' || active from users where id = ${lit(ownerUser)};`), "Test owner true");
});

test("a person has a phone, the monitor has a name, and neither is used twice", () => {
  const phone = nextPhone();
  app(`insert into users (name, role, phone, created_by) values ('Owner one', 'owner', ${lit(phone)}, ${lit(USER)});`);
  refused(
    () => app(`insert into users (name, role, phone, created_by) values ('Owner two', 'owner', ${lit(phone)}, ${lit(USER)});`),
    /users_phone_key/,
  );
  refused(() => app(`insert into users (name, role, created_by) values ('No phone', 'owner', ${lit(USER)});`), /users_people_have_a_phone/);
  refused(
    () => app(`insert into users (name, role, phone, created_by) values ('Local', 'owner', '0770 123 4567', ${lit(USER)});`),
    /users_phone_format/,
  );
  refused(() => app(`insert into users (name, role, created_by) values ('Screen', 'monitor', ${lit(USER)});`), /users_monitor_has_a_name/);
  refused(
    () => app(`insert into users (name, role, sign_in_name, created_by) values ('Screen', 'monitor', 'Office TV', ${lit(USER)});`),
    /users_sign_in_name_format/,
  );
  refused(() => app(`insert into users (name, role, phone, created_by) values (' ', 'owner', ${lit(nextPhone())}, ${lit(USER)});`), /users_name_not_blank/);
});

test("a user keeps his role and is never deleted", () => {
  const ownerUser = newUser("owner");
  // The application has no right to do either.
  refused(() => app(`update users set role = 'ceo' where id = ${lit(ownerUser)};`), /permission denied/);
  refused(() => app(`delete from users where id = ${lit(ownerUser)};`), /permission denied/);
  // Nor does anyone else.
  refused(() => owner(`update users set role = 'ceo' where id = ${lit(ownerUser)};`), /user_locked/);
  refused(() => owner(`delete from users where id = ${lit(ownerUser)};`), /user_kept/);
  assert.equal(app(`select role from users where id = ${lit(ownerUser)};`), "owner");
});

test("there is always an active CEO", () => {
  const second = newUser("ceo", "Second CEO");
  app(`update users set active = false where id = ${lit(second)};`);   // one is left
  assert.equal(app("select count(*) from users where role = 'ceo' and active;"), "1");
  // Through the application he cannot switch himself off at all.
  refused(() => app(`update users set active = false where id = ${lit(USER)};`), /own_account/);
  // And nobody can switch off the last one.
  refused(() => owner(`update users set active = false where id = ${lit(USER)};`), /last_ceo/);
  refused(() => owner("update users set active = false where role = 'ceo';"), /last_ceo/);
  assert.equal(app(`select active from users where id = ${lit(USER)};`), "t");
  assert.equal(app("select count(*) from users where role = 'ceo' and active;"), "1");
});

test("a password is set by the CEO or by the user himself, and is never written to the log", () => {
  const ownerUser = newUser("owner");
  const other = newUser("owner");
  const set = (userId: string, hash = HASH) =>
    `insert into user_credentials (user_id, password_hash) values (${lit(userId)}, ${lit(hash)})
     on conflict (user_id) do update set password_hash = excluded.password_hash;`;

  app(set(ownerUser));                                   // the CEO sets it
  const changed = HASH.replace(/.$/, "A");
  appAs(ownerUser)(set(ownerUser, changed));             // the user changes his own
  assert.equal(app(`select changed_by from user_credentials where user_id = ${lit(ownerUser)};`), ownerUser);

  refused(() => appAs(ownerUser)(set(other)), /ceo_only/);
  refused(() => appAs(ownerUser)(set(USER)), /ceo_only/);
  refused(() => appNoActor(set(other)), /actor_required/);
  refused(() => app(set(other, "hunter2")), /user_credentials_is_a_hash/);
  refused(() => owner(`delete from user_credentials where user_id = ${lit(ownerUser)};`), /credentials_kept/);

  const log = app(`select action || '|' || actor || '|' || coalesce(before ->> 'password', '-') || '|' || (after ->> 'password')
                   from audit_log where entity = 'user_credentials' and entity_id = ${lit(ownerUser)} order by id;`);
  assert.deepEqual(log.split("\n"), [`insert|${USER}|-|set`, `update|${ownerUser}|set|changed`]);
  const everything = app("select coalesce(string_agg(coalesce(before::text, '') || coalesce(after::text, ''), ' '), '') from audit_log;");
  assert.ok(!everything.includes("c2FsdHNhbHRzYWx0c2FsdA"), "a hash reached the audit log");
});

test("every change to a user is logged with before and after, and the log is never edited", () => {
  const id = newUser("owner", "Aram");
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
  const ownerUser = newUser("owner");
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
});

test("the books are still sound", () => {
  assert.equal(health(), "");
});
