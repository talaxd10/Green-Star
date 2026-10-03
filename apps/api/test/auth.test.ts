// Signing in and out, proven over the real routes against a real Postgres.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { call, nextPhone, PASSWORD, seedUser, signIn, start, WEB } from "./helpers.ts";

const h = await start();
after(() => h.close());

test("a person signs in with his phone in any spelling, and is told who he is and what he can do", async () => {
  const ceo = await seedUser(h, "ceo", "Sarkar");
  const local = `0${(ceo.phone as string).slice(4)}`;                       // 0750 123 4567
  const spaced = `+964 ${local.slice(1, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;

  for (const typed of [ceo.phone, local, spaced, ` ${local} `]) {
    const reply = await call(h.app, "POST", "/v1/auth/login", { body: { phone: typed, password: PASSWORD } });
    assert.equal(reply.status, 200, `typed as "${typed}"`);
    assert.equal(reply.body.user.id, ceo.id);
    assert.equal(reply.body.user.name, "Sarkar");
    assert.equal(reply.body.user.role, "ceo");
    assert.ok(reply.body.can.includes("enter_money") && reply.body.can.includes("manage_users"));
    assert.ok(Date.parse(reply.body.session.expiresAt) > Date.now());

    const me = await call(h.app, "GET", "/v1/me", { cookie: reply.cookie });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body, reply.body);
  }
});

test("the owner can only see the books, and the monitor signs in with its name and can only show the screen", async () => {
  const owner = await seedUser(h, "owner");
  const monitor = await seedUser(h, "monitor");

  const asOwner = await call(h.app, "POST", "/v1/auth/login", { body: { phone: owner.phone, password: PASSWORD } });
  assert.deepEqual(asOwner.body.can, ["see_books"]);

  const asMonitor = await call(h.app, "POST", "/v1/auth/login", {
    body: { phone: (monitor.signInName as string).toUpperCase(), password: PASSWORD },
  });
  assert.equal(asMonitor.status, 200);
  assert.deepEqual(asMonitor.body.can, ["see_monitor"]);
  assert.equal(asMonitor.body.user.phone, null);
});

test("a wrong password and a phone nobody has get the same answer", async () => {
  const owner = await seedUser(h, "owner");
  const wrong = await call(h.app, "POST", "/v1/auth/login", { body: { phone: owner.phone, password: "not the password" } });
  const nobody = await call(h.app, "POST", "/v1/auth/login", { body: { phone: nextPhone(), password: PASSWORD } });
  const noPassword = await seedUserWithoutPassword();
  const unset = await call(h.app, "POST", "/v1/auth/login", { body: { phone: noPassword, password: PASSWORD } });

  for (const reply of [wrong, nobody, unset]) {
    assert.equal(reply.status, 401);
    assert.deepEqual(reply.body, { code: "sign_in_failed", message: "Wrong phone number or password" });
    assert.equal(reply.setCookie, null);
  }
});

async function seedUserWithoutPassword(): Promise<string> {
  const phone = nextPhone();
  await h.owner.query("insert into users (name, role, phone) values ('No password yet', 'owner', $1)", [phone]);
  return phone;
}

test("the session lives in a cookie scripts cannot read, and the database keeps only its hash", async () => {
  const owner = await seedUser(h, "owner");
  const reply = await call(h.app, "POST", "/v1/auth/login", { body: { phone: owner.phone, password: PASSWORD } });
  const line = reply.setCookie as string;
  assert.match(line, /; HttpOnly/);
  assert.match(line, /; Secure/);
  assert.match(line, /; SameSite=Lax/);
  assert.match(line, /; Path=\//);

  const token = (reply.cookie as string).slice("gs_session=".length);
  assert.ok(token.length >= 43, "the token is 32 random bytes");
  assert.ok(!JSON.stringify(reply.body).includes(token), "the token is not in the reply's body");

  const { rows } = await h.owner.query("select token_hash, device, host(ip) as ip from sessions where id = $1", [reply.body.session.id]);
  assert.deepEqual(rows[0].token_hash, createHash("sha256").update(token).digest());
  assert.equal(rows[0].ip, "10.0.0.1");
  const everything = await h.owner.query("select coalesce(string_agg(s::text, ' '), '') as all from sessions s");
  assert.ok(!everything.rows[0].all.includes(token), "the token itself is nowhere in the table");
});

test("without a session, or with one that was made up, nothing is shown", async () => {
  for (const cookie of [null, "gs_session=", "gs_session=made-up", `gs_session=${"x".repeat(43)}`, "other=1"]) {
    const reply = await call(h.app, "GET", "/v1/me", { cookie });
    assert.equal(reply.status, 401, `cookie: ${cookie}`);
    assert.deepEqual(reply.body, { code: "not_signed_in", message: "Sign in first" });
  }
});

test("signing out ends this device's session and leaves the others", async () => {
  const owner = await seedUser(h, "owner");
  const laptop = await signIn(h, owner);
  const phone = await signIn(h, owner);

  const out = await call(h.app, "POST", "/v1/auth/logout", { cookie: laptop });
  assert.equal(out.status, 204);
  assert.match(out.setCookie as string, /gs_session=;/);

  assert.equal((await call(h.app, "GET", "/v1/me", { cookie: laptop })).status, 401);
  assert.equal((await call(h.app, "GET", "/v1/me", { cookie: phone })).status, 200);
  // Signing out twice, or with no session at all, is not an error.
  assert.equal((await call(h.app, "POST", "/v1/auth/logout", { cookie: laptop })).status, 204);
  assert.equal((await call(h.app, "POST", "/v1/auth/logout")).status, 204);
});

test("five wrong passwords make that account wait, from that address only", async () => {
  const owner = await seedUser(h, "owner");
  const attacker = { ip: "203.0.113.7" };
  for (let i = 0; i < 5; i += 1) {
    const reply = await call(h.app, "POST", "/v1/auth/login", { ...attacker, body: { phone: owner.phone, password: `guess ${i}` } });
    assert.equal(reply.status, 401);
  }
  // The sixth try is refused without looking at the password, even the right one.
  const blocked = await call(h.app, "POST", "/v1/auth/login", { ...attacker, body: { phone: owner.phone, password: PASSWORD } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, "too_many_attempts");
  assert.ok(blocked.body.retryAfterSeconds > 14 * 60 && blocked.body.retryAfterSeconds <= 15 * 60);
  assert.equal(blocked.headers["retry-after"], String(blocked.body.retryAfterSeconds));
  assert.equal(blocked.setCookie, null);

  // The CEO's own office is not locked out by someone guessing from elsewhere.
  const office = await call(h.app, "POST", "/v1/auth/login", { ip: "198.51.100.20", body: { phone: owner.phone, password: PASSWORD } });
  assert.equal(office.status, 200);

  const tries = await h.owner.query("select count(*)::int as n from sign_in_attempts where sign_in_key = $1 and host(ip) = $2", [owner.phone, attacker.ip]);
  assert.equal(tries.rows[0].n, 5, "a refused try is not checked and not counted");
});

test("the wait ends after 15 minutes, and a right password clears the count", async () => {
  const owner = await seedUser(h, "owner");
  const ip = "203.0.113.8";
  const fail = () => call(h.app, "POST", "/v1/auth/login", { ip, body: { phone: owner.phone, password: "wrong wrong" } });
  const pass = () => call(h.app, "POST", "/v1/auth/login", { ip, body: { phone: owner.phone, password: PASSWORD } });

  // Five wrong tries sixteen minutes ago no longer count.
  await h.owner.query(
    `insert into sign_in_attempts (sign_in_key, ip, succeeded, at)
     select $1, $2::inet, false, now() - interval '16 minutes' from generate_series(1, 5)`,
    [owner.phone, ip],
  );
  assert.equal((await pass()).status, 200);

  // Four wrong, one right, four wrong: never five in a row.
  for (let i = 0; i < 4; i += 1) assert.equal((await fail()).status, 401);
  assert.equal((await pass()).status, 200);
  for (let i = 0; i < 4; i += 1) assert.equal((await fail()).status, 401);
  assert.equal((await pass()).status, 200);
});

test("guessing one account from many addresses, or many accounts from one address, is stopped too", async () => {
  const owner = await seedUser(h, "owner");
  // Twenty wrong tries for one account, spread over twenty addresses.
  await h.owner.query(
    `insert into sign_in_attempts (sign_in_key, ip, succeeded)
     select $1, ('192.0.2.' || n)::inet, false from generate_series(1, 20) n`,
    [owner.phone],
  );
  const anywhere = await call(h.app, "POST", "/v1/auth/login", { ip: "198.51.100.99", body: { phone: owner.phone, password: PASSWORD } });
  assert.equal(anywhere.status, 429);

  // Thirty wrong tries from one address, each for a different account.
  const ip = "203.0.113.200";
  await h.owner.query(
    `insert into sign_in_attempts (sign_in_key, ip, succeeded)
     select '+96475000000' || lpad(n::text, 2, '0'), $1::inet, false from generate_series(1, 30) n`,
    [ip],
  );
  const other = await seedUser(h, "owner");
  const fromThere = await call(h.app, "POST", "/v1/auth/login", { ip, body: { phone: other.phone, password: PASSWORD } });
  assert.equal(fromThere.status, 429);
  const fromElsewhere = await call(h.app, "POST", "/v1/auth/login", { ip: "198.51.100.21", body: { phone: other.phone, password: PASSWORD } });
  assert.equal(fromElsewhere.status, 200);
});

test("eight wrong tries sent at the same moment are still counted one by one", async () => {
  const owner = await seedUser(h, "owner");
  const ip = "203.0.113.9";
  const replies = await Promise.all(
    Array.from({ length: 8 }, (_, i) => call(h.app, "POST", "/v1/auth/login", { ip, body: { phone: owner.phone, password: `guess ${i}` } })),
  );
  const statuses = replies.map((r) => r.status).sort();
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429, 429]);
});

test("a session that has not been used for too long is over", async () => {
  const owner = await seedUser(h, "owner");
  const cookie = await signIn(h, owner);
  const me = await call(h.app, "GET", "/v1/me", { cookie });
  const fourteenDays = Date.parse(me.body.session.expiresAt) - Date.now();
  assert.ok(Math.abs(fourteenDays - 14 * 86_400_000) < 60_000, "the owner's session lasts 14 days unused");

  await h.owner.query("update sessions set expires_at = now() - interval '1 second' where id = $1", [me.body.session.id]);
  assert.equal((await call(h.app, "GET", "/v1/me", { cookie })).status, 401);

  const monitor = await seedUser(h, "monitor");
  const screen = await call(h.app, "POST", "/v1/auth/login", { body: { phone: monitor.signInName, password: PASSWORD } });
  const days = (Date.parse(screen.body.session.expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 399 && days <= 400, "the office screen stays signed in");
});

test("using a session keeps it alive", async () => {
  const owner = await seedUser(h, "owner");
  const cookie = await signIn(h, owner);
  const { body } = await call(h.app, "GET", "/v1/me", { cookie });
  // Last used ten days ago, four days left.
  await h.owner.query("update sessions set last_seen_at = now() - interval '10 days', expires_at = now() + interval '4 days' where id = $1", [body.session.id]);

  const again = await call(h.app, "GET", "/v1/me", { cookie });
  assert.equal(again.status, 200);
  const left = (Date.parse(again.body.session.expiresAt) - Date.now()) / 86_400_000;
  assert.ok(left > 13.9 && left <= 14, `expected 14 days again, got ${left}`);
  const { rows } = await h.owner.query("select now() - last_seen_at < interval '1 minute' as fresh from sessions where id = $1", [body.session.id]);
  assert.equal(rows[0].fresh, true);
});

test("a user who is switched off is signed out at once and cannot sign in", async () => {
  const owner = await seedUser(h, "owner");
  const cookie = await signIn(h, owner);
  await h.owner.query("update users set active = false where id = $1", [owner.id]);

  assert.equal((await call(h.app, "GET", "/v1/me", { cookie })).status, 401);
  const again = await call(h.app, "POST", "/v1/auth/login", { body: { phone: owner.phone, password: PASSWORD } });
  assert.equal(again.status, 401);
  assert.equal(again.body.code, "sign_in_failed");
});

test("changing your password needs the current one and signs out your other devices", async () => {
  const owner = await seedUser(h, "owner");
  const here = await signIn(h, owner);
  const there = await signIn(h, owner);
  const next = "a brand new password";

  const wrong = await call(h.app, "POST", "/v1/auth/password", { cookie: here, body: { current: "not it at all", next } });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.code, "password_wrong");
  const short = await call(h.app, "POST", "/v1/auth/password", { cookie: here, body: { current: PASSWORD, next: "short" } });
  assert.equal(short.status, 400);
  assert.equal(short.body.fields.next, "Use at least 10 characters");
  assert.equal((await call(h.app, "GET", "/v1/me", { cookie: there })).status, 200, "a refused change signs nobody out");

  const changed = await call(h.app, "POST", "/v1/auth/password", { cookie: here, body: { current: PASSWORD, next } });
  assert.equal(changed.status, 204);
  assert.equal((await call(h.app, "GET", "/v1/me", { cookie: here })).status, 200);
  assert.equal((await call(h.app, "GET", "/v1/me", { cookie: there })).status, 401);

  assert.equal((await call(h.app, "POST", "/v1/auth/login", { body: { phone: owner.phone, password: PASSWORD } })).status, 401);
  assert.equal((await call(h.app, "POST", "/v1/auth/login", { body: { phone: owner.phone, password: next } })).status, 200);

  const log = await h.owner.query("select actor, after from audit_log where entity = 'user_credentials' and entity_id = $1 order by id desc limit 1", [owner.id]);
  assert.equal(log.rows[0].actor, owner.id);
  assert.deepEqual(log.rows[0].after, { password: "changed" });
});

test("another website cannot use a signed-in browser", async () => {
  const owner = await seedUser(h, "owner");
  const cookie = await signIn(h, owner, { origin: WEB });

  // A page on another site sends the browser to change the password.
  const forged = await call(h.app, "POST", "/v1/auth/password", {
    cookie,
    origin: "https://evil.example",
    body: { current: PASSWORD, next: "attacker's password" },
  });
  assert.equal(forged.status, 403);
  assert.equal(forged.body.code, "origin_not_allowed");
  assert.equal((await call(h.app, "POST", "/v1/auth/login", { body: { phone: owner.phone, password: PASSWORD } })).status, 200);

  // Nor sign a visitor in to an account of the attacker's choosing.
  const login = await call(h.app, "POST", "/v1/auth/login", { origin: "https://evil.example", body: { phone: owner.phone, password: PASSWORD } });
  assert.equal(login.status, 403);

  // The office app's own address is let through, and told so; another site is not.
  const ours = await call(h.app, "GET", "/v1/me", { cookie, origin: WEB });
  assert.equal(ours.headers["access-control-allow-origin"], WEB);
  assert.equal(ours.headers["access-control-allow-credentials"], "true");
  const theirs = await call(h.app, "GET", "/v1/me", { cookie, origin: "https://evil.example" });
  assert.equal(theirs.headers["access-control-allow-origin"], undefined);
});

test("a request that is not what the address expects is refused with a reason", async () => {
  const cases: [unknown, string][] = [
    [{}, "phone"],
    [{ phone: "0750 000 0000" }, "password"],
    [{ phone: "", password: "x" }, "phone"],
    [{ phone: "0750 000 0000", password: "x", admin: true }, "_"],
  ];
  for (const [body, field] of cases) {
    const reply = await call(h.app, "POST", "/v1/auth/login", { body });
    assert.equal(reply.status, 400, JSON.stringify(body));
    assert.equal(reply.body.code, "invalid_request");
    assert.ok(field in reply.body.fields, `${JSON.stringify(body)} should name ${field}: ${JSON.stringify(reply.body)}`);
  }
  const notJson = await call(h.app, "POST", "/v1/auth/login", { body: "{not json", headers: { "content-type": "application/json" } });
  assert.equal(notJson.status, 400);
  assert.equal(notJson.body.code, "invalid_request");
  const form = await call(h.app, "POST", "/v1/auth/login", { body: "phone=1&password=2", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(form.status, 415);
  assert.equal(form.body.code, "not_json");
});
