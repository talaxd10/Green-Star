// The CEO's account and its devices, proven over the real routes against a real Postgres.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { call, nextPhone, PASSWORD, seedUser, signIn, start } from "./helpers.ts";

const h = await start();
after(() => h.close());

const ceo = await seedUser(h, "Sarkar");
const cookie = await signIn(h, ceo);

test("no account is added, changed or switched off from the app: the system is the CEO's alone", async () => {
  const before = (await h.owner.query("select count(*)::int as n from users")).rows[0].n;
  const gone: [string, string, unknown][] = [
    ["POST", "/v1/users", { name: "Kak Azad", phone: nextPhone(), password: PASSWORD }],
    ["POST", "/v1/users", { role: "owner", name: "Kak Azad", phone: nextPhone(), password: PASSWORD }],
    ["POST", "/v1/users", { role: "monitor", name: "Office TV", signInName: "officetv", password: PASSWORD }],
    ["PATCH", `/v1/users/${ceo.id}`, { name: "Renamed" }],
    ["PATCH", `/v1/users/${ceo.id}`, { active: false }],
    ["PATCH", `/v1/users/${ceo.id}`, { password: "set from the screen" }],
    ["DELETE", `/v1/users/${ceo.id}`, undefined],
    ["GET", "/v1/monitor", undefined],
  ];
  for (const [method, url, body] of gone) {
    const reply = await call(h.app, method, url, { cookie, body });
    assert.equal(reply.status, 404, `${method} ${url}`);
    assert.deepEqual(reply.body, { code: "not_found", message: "There is nothing at this address" });
  }
  assert.equal((await h.owner.query("select count(*)::int as n from users")).rows[0].n, before);
  const { rows } = await h.owner.query("select name, active from users where id = $1", [ceo.id]);
  assert.deepEqual(rows[0], { name: "Sarkar", active: true });
  assert.equal((await call(h.app, "POST", "/v1/auth/login", { body: { phone: ceo.phone, password: PASSWORD } })).status, 200);

  // And the database has no place for another kind of account, whoever asks.
  await assert.rejects(h.owner.query("insert into users (name, role, phone) values ('Not a CEO', 'owner', $1)", [nextPhone()]), /users_only_the_ceo/);
  await assert.rejects(h.owner.query("insert into users (name, role, sign_in_name) values ('Not a CEO', 'monitor', 'office-tv')"), /users_only_the_ceo/);
  assert.equal((await h.owner.query("select count(*)::int as n from users where name = 'Not a CEO'")).rows[0].n, 0);
});

test("an account signs in with its phone and nothing else", async () => {
  // The office screen used to sign in with a name. No account has one now, and a name finds nobody.
  await assert.rejects(h.owner.query("update users set sign_in_name = 'sarkar' where id = $1", [ceo.id]), /users_monitor_has_a_name/);
  for (const typed of ["sarkar", "Sarkar", ceo.id]) {
    const reply = await call(h.app, "POST", "/v1/auth/login", { body: { phone: typed, password: PASSWORD } });
    assert.equal(reply.status, 401, typed);
    assert.equal(reply.body.code, "sign_in_failed");
  }
});

test("the list shows the account and the devices signed in to it, and never a password", async () => {
  const other = await seedUser(h, "Second account");
  await signIn(h, other, { headers: { "user-agent": "Chrome on Windows" } });
  await signIn(h, other, { headers: { "user-agent": "Safari on iPhone" } });

  const reply = await call(h.app, "GET", "/v1/users", { cookie });
  assert.equal(reply.status, 200);
  const listed = reply.body.users.find((u: { id: string }) => u.id === other.id);
  assert.deepEqual(Object.keys(listed).sort(), ["active", "createdAt", "hasPassword", "id", "name", "phone", "sessions"]);
  assert.equal(listed.name, "Second account");
  assert.equal(listed.phone, other.phone);
  assert.equal(listed.hasPassword, true);
  assert.deepEqual(listed.sessions.map((s: { device: string }) => s.device).sort(), ["Chrome on Windows", "Safari on iPhone"]);
  assert.ok(listed.sessions.every((s: { current: boolean }) => !s.current));

  const me = reply.body.users.find((u: { id: string }) => u.id === ceo.id);
  assert.equal(me.sessions.filter((s: { current: boolean }) => s.current).length, 1, "the device asking is marked");

  const text = JSON.stringify(reply.body);
  assert.ok(!text.includes("scrypt") && !/password_hash|token/i.test(text), "no hash and no token leaves the API");

  // An account that was switched off is signed out and is not listed: nothing on the screen can change it.
  await h.owner.query("update users set active = false where id = $1", [other.id]);
  const after = await call(h.app, "GET", "/v1/users", { cookie });
  assert.equal(after.body.users.find((u: { id: string }) => u.id === other.id), undefined);
  assert.ok(after.body.users.every((u: { active: boolean }) => u.active));
});

test("the CEO signs out one device and the others stay", async () => {
  const lost = await signIn(h, ceo);
  const kept = await signIn(h, ceo);
  const lostId = (await call(h.app, "GET", "/v1/me", { cookie: lost })).body.session.id;

  assert.equal((await call(h.app, "DELETE", `/v1/sessions/${lostId}`, { cookie })).status, 204);
  assert.equal((await call(h.app, "GET", "/v1/me", { cookie: lost })).status, 401);
  assert.equal((await call(h.app, "GET", "/v1/me", { cookie: kept })).status, 200);
  assert.equal((await call(h.app, "GET", "/v1/me", { cookie })).status, 200);
  const { rows } = await h.owner.query("select revoked_by from sessions where id = $1", [lostId]);
  assert.equal(rows[0].revoked_by, ceo.id, "the session says who ended it");

  assert.equal((await call(h.app, "DELETE", `/v1/sessions/${lostId}`, { cookie })).status, 204, "ending it twice is not an error");
  const missing = await call(h.app, "DELETE", `/v1/sessions/${randomUUID()}`, { cookie });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "not_found");
  const notAnId = await call(h.app, "DELETE", "/v1/sessions/42", { cookie });
  assert.equal(notAnId.status, 400);

  // A device that was signed out cannot sign another one out.
  const keptId = (await call(h.app, "GET", "/v1/me", { cookie: kept })).body.session.id;
  assert.equal((await call(h.app, "DELETE", `/v1/sessions/${keptId}`, { cookie: lost })).status, 401);
  assert.equal((await call(h.app, "GET", "/v1/me", { cookie: kept })).status, 200);
});
