// Who may call what. Every address in the API is tried signed out and signed
// in, so an address added later is covered the day it is added.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { buildApp } from "../src/app.ts";
import { Db } from "../src/db.ts";
import { call, config, PASSWORD, seedUser, signedIn, signIn, start } from "./helpers.ts";

const h = await start();
after(() => h.close());

/** The address with a real-looking id in place of each :name. */
const concrete = (url: string) => url.replace(/:[a-zA-Z]+/g, () => randomUUID());

test("every address says who may call it: open before signing in, or the CEO signed in", () => {
  assert.ok(h.app.routeList.length >= 66, `only ${h.app.routeList.length} addresses`);
  for (const route of h.app.routeList) {
    assert.ok(route.access === "public" || route.access === "signed_in", `${route.method} ${route.url}: ${String(route.access)}`);
  }
  const open = h.app.routeList.filter((r) => r.access === "public").map((r) => `${r.method} ${r.url}`).sort();
  assert.deepEqual(open, ["GET /healthz", "POST /v1/auth/login", "POST /v1/auth/logout"], "nothing else is open before signing in");
});

test("there is one kind of account: nothing names a role, and nothing is left for another one", async () => {
  const urls = h.app.routeList.map((r) => r.url);
  for (const gone of ["/v1/monitor", "/v1/users/:id"]) assert.ok(!urls.includes(gone), gone);
  assert.ok(!h.app.routeList.some((r) => r.method === "POST" && r.url === "/v1/users"), "no account is added from the app");

  const ceo = await signedIn(h);
  const me = await call(h.app, "GET", "/v1/me", { cookie: ceo.cookie });
  assert.deepEqual(Object.keys(me.body).sort(), ["session", "user"]);
  assert.deepEqual(Object.keys(me.body.user).sort(), ["active", "id", "name", "phone"]);
  const roles = await h.owner.query("select distinct role::text as role from users");
  assert.deepEqual(roles.rows.map((r) => r.role), ["ceo"]);
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

test("each address answers the CEO signed in, and nobody else", async () => {
  const ceo = await signedIn(h);
  // He was signed in once and is not any more: signed out, switched off, or the session ran out.
  const signedOut = await signedIn(h, "Signed out");
  assert.equal((await call(h.app, "POST", "/v1/auth/logout", { cookie: signedOut.cookie })).status, 204);
  const switchedOff = await signedIn(h, "Switched off");
  await h.owner.query("update users set active = false where id = $1", [switchedOff.user.id]);
  const ranOut = await signedIn(h, "Ran out");
  await h.owner.query("update sessions set expires_at = now() - interval '1 second' where user_id = $1", [ranOut.user.id]);

  let checked = 0;
  for (const route of h.app.routeList) {
    if (route.access === "public") continue;
    const url = concrete(route.url);
    const body = route.method === "GET" || route.method === "DELETE" ? undefined : {};

    for (const [who, cookie] of [["nobody", null], ["a made-up session", `gs_session=${"x".repeat(43)}`], ["a session that was signed out", signedOut.cookie], ["an account that was switched off", switchedOff.cookie], ["a session that ran out", ranOut.cookie]] as const) {
      const reply = await call(h.app, route.method, url, { body, cookie });
      assert.equal(reply.status, 401, `${route.method} ${route.url} as ${who}`);
      assert.deepEqual(reply.body, { code: "not_signed_in", message: "Sign in first" });
      checked += 1;
    }
    const reply = await call(h.app, route.method, url, { body, cookie: ceo.cookie });
    assert.ok(reply.status !== 401 && reply.status !== 403, `${route.method} ${route.url} should answer the CEO, got ${reply.status}`);
    checked += 1;
  }
  assert.ok(checked >= 370, `only ${checked} checks`);
});

test("every write needs its own key, so a double click on Save is done once", async () => {
  const roles = { ceo: await signedIn(h) };
  let checked = 0;
  for (const route of h.app.routeList) {
    if (route.access === "public" || route.method === "GET" || route.url === "/v1/auth/password") continue;
    const url = concrete(route.url);
    const none = await call(h.app, route.method, url, { body: {}, cookie: roles.ceo.cookie, key: null });
    assert.equal(none.status, 400, `${route.method} ${route.url} without a key`);
    assert.equal(none.body.code, "idempotency_key_required", `${route.method} ${route.url}`);
    const bad = await call(h.app, route.method, url, { body: {}, cookie: roles.ceo.cookie, key: "short" });
    assert.equal(bad.body.code, "idempotency_key_invalid", `${route.method} ${route.url}`);
    checked += 1;
  }
  assert.ok(checked >= 30, `only ${checked} writes were checked`);

  // A key belongs to one request by one user.
  const key = randomUUID();
  const body = { name: "Keyed customer" };
  const first = await call(h.app, "POST", "/v1/customers", { cookie: roles.ceo.cookie, body, key });
  assert.equal(first.status, 201);
  const second = await seedUser(h, "Another account");
  const stolen = await call(h.app, "POST", "/v1/customers", { cookie: await signIn(h, second), body, key });
  assert.equal(stolen.status, 422);
  assert.equal(stolen.body.code, "idempotency_key_reused");
  const elsewhere = await call(h.app, "POST", "/v1/drivers", { cookie: roles.ceo.cookie, body, key });
  assert.equal(elsewhere.body.code, "idempotency_key_reused", "the same key on another address");
  // A request that was refused did nothing, so its key is free to be sent again with the mistake fixed.
  const retry = randomUUID();
  assert.equal((await call(h.app, "POST", "/v1/customers", { cookie: roles.ceo.cookie, body: { name: "" }, key: retry })).status, 400);
  assert.equal((await call(h.app, "POST", "/v1/customers", { cookie: roles.ceo.cookie, body: { name: "Fixed" }, key: retry })).status, 201);
});

test("an address that does not exist says so, in the same shape as every other error", async () => {
  const roles = { ceo: await signedIn(h) };
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
  assert.deepEqual(reply.body, { ok: true, database: true, checks: true });
});

test("whatever the API does, it cannot change the ledger without an active CEO's name on the request", async () => {
  const ceo = (await signedIn(h)).user.id;
  const other = (await signedIn(h, "Other")).user.id;
  const off = (await signedIn(h, "Off")).user.id;
  await h.owner.query("update users set active = false where id = $1", [off]);
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
  await assert.rejects(post(null, ceo), /actor_required/);
  await assert.rejects(post(off, off), /actor_unknown/);
  await assert.rejects(post(off, ceo), /actor_unknown/);
  await assert.rejects(post(randomUUID(), ceo), /actor_unknown/);
  await assert.rejects(post(ceo, other), /actor_mismatch/);
  assert.match(String(await post(ceo, ceo)), /^[0-9a-f-]{36}$/);

  // And a screen that only reads cannot write at all.
  await assert.rejects(
    h.db.read((q) => q.query("insert into sign_in_attempts (sign_in_key, succeeded) values ('x', false)")),
    /read-only transaction/,
  );
});
