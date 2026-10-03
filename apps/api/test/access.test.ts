// Who may call what. Every address in the API is tried as every role, so an
// address added later is covered the day it is added.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ROLES } from "@green-star/contracts";
import Fastify from "fastify";
import { buildApp } from "../src/app.ts";
import { Db } from "../src/db.ts";
import { call, config, everyRole, PASSWORD, seedUser, signIn, start } from "./helpers.ts";

const h = await start();
after(() => h.close());

/** The address with a real-looking id in place of each :name. */
const concrete = (url: string) => url.replace(/:[a-zA-Z]+/g, () => randomUUID());

test("every address says who may call it", () => {
  assert.ok(h.app.routeList.length >= 9);
  for (const route of h.app.routeList) {
    assert.ok(route.access === "public" || (Array.isArray(route.access) && route.access.length > 0), `${route.method} ${route.url}`);
  }
  const open = h.app.routeList.filter((r) => r.access === "public").map((r) => `${r.method} ${r.url}`).sort();
  assert.deepEqual(open, ["GET /healthz", "POST /v1/auth/login", "POST /v1/auth/logout"], "nothing else is open to everyone");
});

test("an address that forgets to say who may call it stops the API from starting", async () => {
  const app = Fastify();
  app.addHook("onRoute", (route) => {
    if (route.config?.access === undefined) throw new Error(`${route.url} does not say who may call it`);
  });
  assert.throws(() => app.get("/v1/secret", async () => "open to everyone by mistake"), /does not say who may call it/);

  // And the real app has that same hook: adding a route without access throws.
  const db = new Db(config.databaseUrl);
  const real = await buildApp(config, db);
  assert.throws(() => real.get("/v1/secret", async () => "open"), /does not say who may call it/);
  await real.close();
  await db.close();
});

test("each address answers only the roles it names, and nobody who is not signed in", async () => {
  const roles = await everyRole(h);
  let checked = 0;
  for (const route of h.app.routeList) {
    if (route.access === "public") continue;
    const url = concrete(route.url);
    const body = route.method === "GET" || route.method === "DELETE" ? undefined : {};

    const nobody = await call(h.app, route.method, url, { body });
    assert.equal(nobody.status, 401, `${route.method} ${route.url} without a session`);
    assert.equal(nobody.body.code, "not_signed_in");

    for (const role of ROLES) {
      const reply = await call(h.app, route.method, url, { body, cookie: roles[role].cookie });
      const allowed = (route.access as readonly string[]).includes(role);
      if (allowed) {
        assert.ok(reply.status !== 401 && reply.status !== 403, `${route.method} ${route.url} should answer the ${role}, got ${reply.status}`);
      } else {
        assert.equal(reply.status, 403, `${route.method} ${route.url} should refuse the ${role}`);
        assert.deepEqual(reply.body, { code: "not_allowed", message: "Your account cannot do this" });
      }
      checked += 1;
    }
  }
  assert.ok(checked >= 18);
});

test("the owner and the monitor cannot touch users or devices", async () => {
  const roles = await everyRole(h);
  const victim = await seedUser(h, "owner", "Victim");
  const victimCookie = await signIn(h, victim);
  const victimSession = (await call(h.app, "GET", "/v1/me", { cookie: victimCookie })).body.session.id;

  for (const role of ["owner", "monitor"] as const) {
    const cookie = roles[role].cookie;
    assert.equal((await call(h.app, "GET", "/v1/users", { cookie })).status, 403);
    assert.equal((await call(h.app, "POST", "/v1/users", { cookie, body: { role: "owner", name: "Friend", phone: "0750 111 2233", password: PASSWORD } })).status, 403);
    assert.equal((await call(h.app, "PATCH", `/v1/users/${victim.id}`, { cookie, body: { active: false } })).status, 403);
    assert.equal((await call(h.app, "PATCH", `/v1/users/${roles.ceo.user.id}`, { cookie, body: { password: "taken over now" } })).status, 403);
    assert.equal((await call(h.app, "DELETE", `/v1/sessions/${victimSession}`, { cookie })).status, 403);
  }
  // The monitor cannot change its own password either: it is a screen.
  assert.equal((await call(h.app, "POST", "/v1/auth/password", { cookie: roles.monitor.cookie, body: { current: PASSWORD, next: "something else" } })).status, 403);

  assert.equal((await call(h.app, "GET", "/v1/me", { cookie: victimCookie })).status, 200, "nothing happened to the victim");
  assert.equal((await h.owner.query("select count(*)::int as n from users where name = 'Friend'")).rows[0].n, 0);
  assert.equal((await call(h.app, "POST", "/v1/auth/login", { body: { phone: roles.ceo.user.phone, password: PASSWORD } })).status, 200);
});

test("an address that does not exist says so, in the same shape as every other error", async () => {
  const roles = await everyRole(h);
  for (const cookie of [null, roles.ceo.cookie]) {
    const reply = await call(h.app, "GET", "/v1/nothing-here", { cookie });
    assert.equal(reply.status, 404);
    assert.deepEqual(reply.body, { code: "not_found", message: "There is nothing at this address" });
  }
  const wrongMethod = await call(h.app, "DELETE", "/v1/me", { cookie: roles.ceo.cookie });
  assert.equal(wrongMethod.status, 404);
});

test("the uptime check answers without a session and says nothing about the business", async () => {
  const reply = await call(h.app, "GET", "/healthz");
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { ok: true });
});

test("whatever the API does, it cannot change the ledger without a CEO's name on the request", async () => {
  const roles = await everyRole(h);
  // Straight through the API's own database connection, the way a route would.
  const post = (actor: string | null, createdBy: string) =>
    h.db.write(actor, (q) =>
      q.value(
        `select gs_post_entry('sent_to_china', now(), $1, $2, jsonb_build_array(
           jsonb_build_object('account_id', gs_account('china_payable'), 'currency', 'USD', 'amount', 1000),
           jsonb_build_object('account_id', gs_account('vault_usd'), 'currency', 'USD', 'amount', -1000)))`,
        [createdBy, randomUUID()],
      ),
    );
  const ceo = roles.ceo.user.id;
  await assert.rejects(post(null, ceo), /actor_required/);
  await assert.rejects(post(roles.owner.user.id, ceo), /ceo_only/);
  await assert.rejects(post(roles.monitor.user.id, roles.monitor.user.id), /ceo_only/);
  await assert.rejects(post(ceo, roles.owner.user.id), /actor_mismatch/);
  assert.match(String(await post(ceo, ceo)), /^[0-9a-f-]{36}$/);

  // And a screen that only reads cannot write at all.
  await assert.rejects(
    h.db.read((q) => q.query("insert into sign_in_attempts (sign_in_key, succeeded) values ('x', false)")),
    /read-only transaction/,
  );
});
