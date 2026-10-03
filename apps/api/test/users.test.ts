// The accounts the CEO adds, proven over the real routes against a real Postgres.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { call, nextPhone, PASSWORD, seedUser, signIn, start } from "./helpers.ts";

const h = await start();
after(() => h.close());

const ceo = await seedUser(h, "ceo", "Sarkar");
const cookie = await signIn(h, ceo);

test("the CEO adds the owner and a monitor account, and they can sign in", async () => {
  const phone = nextPhone();
  const local = `0${phone.slice(4, 7)} ${phone.slice(7, 10)} ${phone.slice(10)}`;
  const owner = await call(h.app, "POST", "/v1/users", { cookie, body: { role: "owner", name: "  Kak Azad ", phone: local, password: PASSWORD } });
  assert.equal(owner.status, 201);
  assert.equal(owner.body.name, "Kak Azad");
  assert.equal(owner.body.phone, phone, "the phone is stored in international form");
  assert.equal(owner.body.role, "owner");
  assert.equal(owner.body.active, true);
  assert.equal(owner.body.hasPassword, true);
  assert.deepEqual(owner.body.sessions, []);

  const name = `tv${Date.now().toString(36)}`;
  const monitor = await call(h.app, "POST", "/v1/users", { cookie, body: { role: "monitor", name: "Office TV", signInName: name.toUpperCase(), password: PASSWORD } });
  assert.equal(monitor.status, 201);
  assert.equal(monitor.body.signInName, name);
  assert.equal(monitor.body.phone, null);

  assert.equal((await call(h.app, "POST", "/v1/auth/login", { body: { phone, password: PASSWORD } })).body.user.role, "owner");
  assert.equal((await call(h.app, "POST", "/v1/auth/login", { body: { phone: name, password: PASSWORD } })).body.user.role, "monitor");

  const { rows } = await h.owner.query("select created_by from users where id = any($1)", [[owner.body.id, monitor.body.id]]);
  assert.deepEqual(rows.map((r) => r.created_by), [ceo.id, ceo.id]);
});

test("a second CEO cannot be added through the app", async () => {
  const reply = await call(h.app, "POST", "/v1/users", { cookie, body: { role: "ceo", name: "Me too", phone: nextPhone(), password: PASSWORD } });
  assert.equal(reply.status, 400);
  assert.equal(reply.body.code, "invalid_request");
});

test("what is typed is checked: phone, name, sign-in name and password", async () => {
  const good = { role: "owner", name: "Azad", phone: nextPhone(), password: PASSWORD };
  const cases: [Record<string, unknown>, string, RegExp][] = [
    [{ ...good, phone: "12345" }, "phone", /not a phone number/],
    [{ ...good, name: "   " }, "name", /Enter a name/],
    [{ ...good, password: "too short" }, "password", /at least 10/],
    [{ ...good, password: "x".repeat(201) }, "password", /at most 200/],
    [{ ...good, signInName: "tv" }, "_", /./],
    [{ role: "monitor", name: "TV", signInName: "office tv", password: PASSWORD }, "signInName", /no spaces/],
    [{ role: "monitor", name: "TV", signInName: "1tv", password: PASSWORD }, "signInName", /starting with a letter/],
    [{ role: "monitor", name: "TV", phone: nextPhone(), signInName: "screen", password: PASSWORD }, "_", /./],
  ];
  for (const [body, field, message] of cases) {
    const reply = await call(h.app, "POST", "/v1/users", { cookie, body });
    assert.equal(reply.status, 400, JSON.stringify(body));
    assert.match(reply.body.fields[field] ?? "", message, `${JSON.stringify(body)} -> ${JSON.stringify(reply.body)}`);
  }
  const count = await h.owner.query("select count(*)::int as n from users where name in ('Azad', 'TV')");
  assert.equal(count.rows[0].n, 0, "a refused request adds nobody");
});

test("a phone number or a sign-in name has one account", async () => {
  const phone = nextPhone();
  const first = await call(h.app, "POST", "/v1/users", { cookie, body: { role: "owner", name: "First", phone, password: PASSWORD } });
  assert.equal(first.status, 201);
  const second = await call(h.app, "POST", "/v1/users", { cookie, body: { role: "owner", name: "Second", phone: `0${phone.slice(4)}`, password: PASSWORD } });
  assert.equal(second.status, 409);
  assert.deepEqual(second.body, { code: "phone_taken", message: "That phone number already has an account" });
  const own = await call(h.app, "POST", "/v1/users", { cookie, body: { role: "owner", name: "Clone", phone: ceo.phone, password: PASSWORD } });
  assert.equal(own.body.code, "phone_taken");

  const name = `screen${Date.now().toString(36)}`;
  assert.equal((await call(h.app, "POST", "/v1/users", { cookie, body: { role: "monitor", name: "TV", signInName: name, password: PASSWORD } })).status, 201);
  const again = await call(h.app, "POST", "/v1/users", { cookie, body: { role: "monitor", name: "TV 2", signInName: name, password: PASSWORD } });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "name_taken");

  // A user refused half-way leaves nothing behind.
  assert.equal((await h.owner.query("select count(*)::int as n from users where name in ('Second', 'Clone', 'TV 2')")).rows[0].n, 0);
});

test("the list shows every account and the devices signed in to it, and never a password", async () => {
  const owner = await seedUser(h, "owner", "Listed owner");
  await signIn(h, owner, { headers: { "user-agent": "Chrome on Windows" } });
  await signIn(h, owner, { headers: { "user-agent": "Safari on iPhone" } });

  const reply = await call(h.app, "GET", "/v1/users", { cookie });
  assert.equal(reply.status, 200);
  const listed = reply.body.users.find((u: { id: string }) => u.id === owner.id);
  assert.equal(listed.name, "Listed owner");
  assert.deepEqual(listed.sessions.map((s: { device: string }) => s.device).sort(), ["Chrome on Windows", "Safari on iPhone"]);
  assert.ok(listed.sessions.every((s: { current: boolean }) => !s.current));

  const me = reply.body.users.find((u: { id: string }) => u.id === ceo.id);
  assert.equal(me.sessions.filter((s: { current: boolean }) => s.current).length, 1, "the device asking is marked");
  assert.equal(reply.body.users[0].role, "ceo", "the CEO is listed first");

  const text = JSON.stringify(reply.body);
  assert.ok(!text.includes("scrypt") && !/password_hash|token/i.test(text), "no hash and no token leaves the API");
});

test("switching a user off signs him out everywhere; switching him on lets him back in", async () => {
  const owner = await seedUser(h, "owner");
  const a = await signIn(h, owner);
  const b = await signIn(h, owner);

  const off = await call(h.app, "PATCH", `/v1/users/${owner.id}`, { cookie, body: { active: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.active, false);
  assert.deepEqual(off.body.sessions, []);
  for (const session of [a, b]) assert.equal((await call(h.app, "GET", "/v1/me", { cookie: session })).status, 401);
  assert.equal((await call(h.app, "POST", "/v1/auth/login", { body: { phone: owner.phone, password: PASSWORD } })).status, 401);

  const on = await call(h.app, "PATCH", `/v1/users/${owner.id}`, { cookie, body: { active: true } });
  assert.equal(on.body.active, true);
  assert.equal((await call(h.app, "GET", "/v1/me", { cookie: a })).status, 401, "the old sessions stay ended");
  assert.equal((await call(h.app, "POST", "/v1/auth/login", { body: { phone: owner.phone, password: PASSWORD } })).status, 200);
});

test("setting a user's password signs him out and the old one stops working", async () => {
  const owner = await seedUser(h, "owner");
  const session = await signIn(h, owner);
  const next = "the CEO chose this one";

  const reply = await call(h.app, "PATCH", `/v1/users/${owner.id}`, { cookie, body: { name: "Renamed", password: next } });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.name, "Renamed");
  assert.equal((await call(h.app, "GET", "/v1/me", { cookie: session })).status, 401);
  assert.equal((await call(h.app, "POST", "/v1/auth/login", { body: { phone: owner.phone, password: PASSWORD } })).status, 401);
  assert.equal((await call(h.app, "POST", "/v1/auth/login", { body: { phone: owner.phone, password: next } })).status, 200);

  // Renaming alone signs nobody out.
  const kept = await signIn(h, { ...owner, password: next });
  await call(h.app, "PATCH", `/v1/users/${owner.id}`, { cookie, body: { name: "Renamed again" } });
  assert.equal((await call(h.app, "GET", "/v1/me", { cookie: kept })).body.user.name, "Renamed again");
});

test("the CEO cannot switch himself off, and keeps his own device when he sets his password here", async () => {
  const off = await call(h.app, "PATCH", `/v1/users/${ceo.id}`, { cookie, body: { active: false } });
  assert.equal(off.status, 422);
  assert.equal(off.body.code, "own_account");
  assert.equal((await call(h.app, "GET", "/v1/me", { cookie })).status, 200);

  const other = await signIn(h, ceo);
  const set = await call(h.app, "PATCH", `/v1/users/${ceo.id}`, { cookie, body: { password: PASSWORD } });
  assert.equal(set.status, 200);
  assert.equal((await call(h.app, "GET", "/v1/me", { cookie })).status, 200);
  assert.equal((await call(h.app, "GET", "/v1/me", { cookie: other })).status, 401);
});

test("the CEO signs out one device and the others stay", async () => {
  const owner = await seedUser(h, "owner");
  const lost = await signIn(h, owner);
  const kept = await signIn(h, owner);
  const lostId = (await call(h.app, "GET", "/v1/me", { cookie: lost })).body.session.id;

  assert.equal((await call(h.app, "DELETE", `/v1/sessions/${lostId}`, { cookie })).status, 204);
  assert.equal((await call(h.app, "GET", "/v1/me", { cookie: lost })).status, 401);
  assert.equal((await call(h.app, "GET", "/v1/me", { cookie: kept })).status, 200);
  const { rows } = await h.owner.query("select revoked_by from sessions where id = $1", [lostId]);
  assert.equal(rows[0].revoked_by, ceo.id, "the session says who ended it");

  assert.equal((await call(h.app, "DELETE", `/v1/sessions/${lostId}`, { cookie })).status, 204, "ending it twice is not an error");
  const missing = await call(h.app, "DELETE", `/v1/sessions/${randomUUID()}`, { cookie });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "not_found");
});

test("an address that names a user or a device needs a real id", async () => {
  const notAnId = await call(h.app, "PATCH", "/v1/users/42", { cookie, body: { name: "x" } });
  assert.equal(notAnId.status, 400);
  const nobody = await call(h.app, "PATCH", `/v1/users/${randomUUID()}`, { cookie, body: { name: "x" } });
  assert.equal(nobody.status, 404);
  const nothing = await call(h.app, "PATCH", `/v1/users/${ceo.id}`, { cookie, body: {} });
  assert.equal(nothing.status, 400);
  assert.equal(nothing.body.fields._, "Nothing to change");
  const role = await call(h.app, "PATCH", `/v1/users/${ceo.id}`, { cookie, body: { role: "owner" } });
  assert.equal(role.status, 400, "a role cannot be changed");
});

test("every change the CEO makes to a user is in the audit log under his name", async () => {
  const made = await call(h.app, "POST", "/v1/users", { cookie, body: { role: "owner", name: "Audited", phone: nextPhone(), password: PASSWORD } });
  await call(h.app, "PATCH", `/v1/users/${made.body.id}`, { cookie, body: { name: "Audited twice", active: false } });

  const { rows } = await h.owner.query(
    "select entity, action, actor, before ->> 'name' as before, after ->> 'name' as after, after ->> 'active' as active from audit_log where entity_id = $1 order by id",
    [made.body.id],
  );
  assert.deepEqual(rows, [
    { entity: "users", action: "insert", actor: ceo.id, before: null, after: "Audited", active: "true" },
    { entity: "user_credentials", action: "insert", actor: ceo.id, before: null, after: null, active: null },
    { entity: "users", action: "update", actor: ceo.id, before: "Audited", after: "Audited twice", active: "false" },
  ]);
});
