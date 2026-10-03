// Checks and alerts, the Today screen, the wallet check, the settings and the
// office monitor, over the real routes against a real Postgres.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { call, seedUser, signIn, start } from "./helpers.ts";
import { result, Scene, unique } from "./scene.ts";

const h = await start();
after(() => h.close());

const ceo = await seedUser(h, "ceo", "Sarkar");
const s = new Scene(h, await signIn(h, ceo));
const ownerCookie = await signIn(h, await seedUser(h, "owner"));
const monitorCookie = await signIn(h, await seedUser(h, "monitor"));
await s.rate();

const now = () => new Date().toISOString();

interface AlertRow {
  id: string;
  kind: string;
  status: string;
  consignmentId: string | null;
  customerId: string | null;
  [key: string]: unknown;
}

/** Every alert of one status, read a page at a time. */
async function alerts(status = "open", extra = "", cookie = s.cookie): Promise<AlertRow[]> {
  const out: AlertRow[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 50; pages += 1) {
    const reply = await s.get(`/v1/alerts?status=${status}&limit=200${extra}${cursor === null ? "" : `&cursor=${cursor}`}`, cookie);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    out.push(...reply.body.items);
    cursor = reply.body.nextCursor;
    if (cursor === null) return out;
  }
  throw new Error("the alerts never came to an end");
}

/** A pay-first customer whose goods were handed over with nothing paid. */
async function forgotToCollect(name = unique("FORGOT "), cents = 6_200) {
  const customer = await s.customer(name);
  const file = await s.file([[customer, cents]]);
  const consignment = file.by[customer] as string;
  const round = await s.roundOut([consignment]);
  const entered = await s.send("PUT", `/v1/rounds/${round}/results`, { results: [result(consignment, "unpaid")] });
  assert.equal(entered.status, 200, JSON.stringify(entered.body));
  return { customer, name, file, consignment, round, roundNumber: entered.body.number as number };
}

const about = (list: AlertRow[], kind: string, consignment: string) => list.filter((a) => a.kind === kind && a.consignmentId === consignment);

test("the driver forgot to collect: the alert is there the moment the round is saved", async () => {
  const before = (await s.get("/v1/alerts/count")).body;
  const { customer, name, file, consignment, round, roundNumber } = await forgotToCollect(unique("HEMN "));

  const found = about(await alerts(), "missed_collection", consignment);
  assert.equal(found.length, 1);
  const alert = found[0] as AlertRow;
  assert.deepEqual(
    {
      kind: alert.kind, severity: alert.severity, status: alert.status, stillWrong: alert.stillWrong, title: alert.title,
      customerId: alert.customerId, customerName: alert.customerName, shipmentId: alert.shipmentId, shipmentCode: alert.shipmentCode,
      roundId: alert.roundId, roundNumber: alert.roundNumber, amount: alert.amount, currency: alert.currency,
      resolvedAt: alert.resolvedAt, resolvedByName: alert.resolvedByName, note: alert.note, clearedAt: alert.clearedAt,
    },
    {
      kind: "missed_collection", severity: "high", status: "open", stillWrong: true,
      title: `Round ${roundNumber}: ${name} got the goods and $62.00 was not collected`,
      customerId: customer, customerName: name, shipmentId: file.id, shipmentCode: file.code,
      roundId: round, roundNumber, amount: 6_200, currency: "USD",
      resolvedAt: null, resolvedByName: null, note: null, clearedAt: null,
    },
  );
  assert.ok(!Number.isNaN(Date.parse(alert.openedAt as string)));

  const after = (await s.get("/v1/alerts/count")).body;
  assert.equal(after.open, before.open + 1);
  assert.equal(after.high, before.high + 1);

  // Saving other things does not open it again.
  await s.driver();
  await s.customer();
  assert.equal(about(await alerts(), "missed_collection", consignment).length, 1);
  // The owner sees it too.
  assert.equal(about(await alerts("open", "", ownerCookie), "missed_collection", consignment).length, 1);
});

test("the CEO resolves an alert with a note; it stays resolved while the same thing is still wrong", async () => {
  const { consignment } = await forgotToCollect();
  const [alert] = about(await alerts(), "missed_collection", consignment) as [AlertRow];
  const url = `/v1/alerts/${alert.id}/resolve`;

  const noNote = await s.send("POST", url, {});
  assert.equal(noNote.status, 400);
  assert.equal(noNote.body.fields.note !== undefined, true);
  assert.equal((await s.send("POST", url, { note: "   " })).status, 400);
  assert.equal((await s.send("POST", url, { note: "x", status: "cleared" })).status, 400, "nothing but a note is taken");
  const owner = await call(h.app, "POST", url, { cookie: ownerCookie, body: { note: "I will handle it" } });
  assert.equal(owner.status, 403);
  const missing = await s.send("POST", `/v1/alerts/${randomUUID()}/resolve`, { note: "x" });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "alert_not_found");
  assert.equal(about(await alerts(), "missed_collection", consignment).length, 1, "still open after all that");

  const key = randomUUID();
  const done = await s.send("POST", url, { note: "  Called him, he pays tomorrow " }, key);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(
    [done.body.status, done.body.note, done.body.resolvedByName, done.body.stillWrong, done.body.clearedAt],
    ["resolved", "Called him, he pays tomorrow", "Sarkar", true, null],
  );
  assert.ok(!Number.isNaN(Date.parse(done.body.resolvedAt)));
  const again = await s.send("POST", url, { note: "  Called him, he pays tomorrow " }, key);
  assert.equal(again.headers["idempotent-replay"], "true");
  assert.deepEqual(again.body, done.body);
  // A second click with a different note does not rewrite the first.
  const second = await s.send("POST", url, { note: "another note" });
  assert.equal(second.status, 200);
  assert.equal(second.body.note, "Called him, he pays tomorrow");

  assert.equal(about(await alerts("open"), "missed_collection", consignment).length, 0);
  assert.equal(about(await alerts("resolved"), "missed_collection", consignment).length, 1);
  // More saves, and it is not opened again.
  await s.driver();
  assert.equal(about(await alerts("open"), "missed_collection", consignment).length, 0);
});

test("an alert goes away by itself when the facts change, and cannot be resolved afterwards", async () => {
  const { consignment } = await forgotToCollect();
  const [alert] = about(await alerts(), "missed_collection", consignment) as [AlertRow];

  // The CEO allows it: no longer the driver's mistake.
  const allowed = await s.send("POST", "/v1/exceptions", { consignmentId: consignment, reason: "He pays on Thursday" });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));

  assert.equal(about(await alerts("open"), "missed_collection", consignment).length, 0);
  const [cleared] = about(await alerts("cleared"), "missed_collection", consignment) as [AlertRow];
  assert.deepEqual([cleared.id, cleared.status, cleared.stillWrong, cleared.note, cleared.resolvedAt], [alert.id, "cleared", false, null, null]);
  assert.ok(!Number.isNaN(Date.parse(cleared.clearedAt as string)));

  const late = await s.send("POST", `/v1/alerts/${alert.id}/resolve`, { note: "too late" });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, "alert_not_open");
});

test("alerts are listed by status and kind, a page at a time", async () => {
  const a = await forgotToCollect();
  const b = await forgotToCollect();
  const trusted = await s.customer(unique("LIMIT "), { trusted: true, limitUsdCents: 5_000 });
  await s.file([[trusted, 8_000]]);

  const missed = await alerts("open", "&kind=missed_collection");
  assert.ok(missed.every((x) => x.kind === "missed_collection"));
  assert.ok(missed.some((x) => x.consignmentId === a.consignment) && missed.some((x) => x.consignmentId === b.consignment));
  const over = (await alerts("open", "&kind=over_limit")).filter((x) => x.customerId === trusted);
  assert.equal(over.length, 1);
  assert.deepEqual([over[0]?.severity, over[0]?.amount, over[0]?.currency], ["medium", 3_000, "USD"]);
  assert.match(over[0]?.title as string, /owes \$80\.00, \$30\.00 over the limit$/);

  // Newest first, two at a time, nothing twice.
  const first = (await s.get("/v1/alerts?kind=missed_collection&limit=2")).body;
  assert.equal(first.items.length, 2);
  assert.equal(first.items[0].consignmentId, b.consignment);
  assert.equal(first.items[1].consignmentId, a.consignment);
  assert.ok(first.nextCursor);
  const next = (await s.get(`/v1/alerts?kind=missed_collection&limit=2&cursor=${first.nextCursor}`)).body;
  const ids = new Set([...first.items, ...next.items].map((x: AlertRow) => x.id));
  assert.equal(ids.size, first.items.length + next.items.length);

  assert.equal((await s.get("/v1/alerts?status=ignored")).status, 400);
  assert.equal((await s.get("/v1/alerts?kind=bad_luck")).status, 400);
  assert.equal((await s.get("/v1/alerts?cursor=nonsense")).status, 400);
});

test("saves that end at the same moment open one alert between them", async () => {
  const customer = await s.customer(unique("TOGETHER "), { trusted: true, limitUsdCents: 50_000 });
  await s.file([[customer, 20_000]]);
  const mine = async () => (await alerts("open", "&kind=over_limit")).filter((x) => x.customerId === customer);
  assert.equal((await mine()).length, 0);

  // The limit is lowered behind the API's back, so the thing is wrong and no save has seen it yet.
  await h.owner.query("update customers set credit_limit_usd_cents = 10000 where id = $1", [customer]);
  assert.equal((await mine()).length, 0);
  const replies = await Promise.all(Array.from({ length: 8 }, () => s.send("POST", "/v1/drivers", { name: unique("Driver ") })));
  assert.deepEqual([...new Set(replies.map((r) => r.status))], [201]);

  assert.equal((await mine()).length, 1);
  const { rows } = await h.owner.query("select count(*)::int as n from alerts where kind = 'over_limit' and subject = $1", [customer]);
  assert.equal(rows[0].n, 1);
  assert.equal(h.app.ctx.checks.failed, 0, String(h.app.ctx.checks.lastError));
});

test("a save is never lost because a check failed, and the failure shows on the uptime check", async () => {
  // Its own API, so the count of failures is its own.
  const other = await start();
  try {
    const cookie = await signIn(other, ceo);
    assert.deepEqual((await call(other.app, "GET", "/healthz")).body, { ok: true, database: true, checks: true });

    await h.owner.query("alter function gs_sync_alerts(boolean) rename to gs_sync_alerts_broken");
    let saved;
    try {
      const silenced = console.error;
      console.error = () => {};
      try {
        saved = await call(other.app, "POST", "/v1/drivers", { cookie, body: { name: unique("Kept ") } });
      } finally {
        console.error = silenced;
      }
    } finally {
      await h.owner.query("alter function gs_sync_alerts_broken(boolean) rename to gs_sync_alerts");
    }
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const { rows } = await h.owner.query("select count(*)::int as n from drivers where id = $1", [saved.body.id]);
    assert.equal(rows[0].n, 1, "the driver was saved");
    assert.equal(other.app.ctx.checks.failed, 1);
    assert.match(String(other.app.ctx.checks.lastError), /gs_sync_alerts/);

    const health = await call(other.app, "GET", "/healthz");
    assert.equal(health.status, 503);
    assert.deepEqual(health.body, { ok: false, database: true, checks: false });
    // The next save works as before, its checks run, and the uptime check is green again.
    assert.equal((await call(other.app, "POST", "/v1/drivers", { cookie, body: { name: unique("After ") } })).status, 201);
    assert.equal(other.app.ctx.checks.failed, 1);
    assert.deepEqual((await call(other.app, "GET", "/healthz")).body, { ok: true, database: true, checks: true });
  } finally {
    await other.close();
  }
});

test("Today: what the rounds went out to collect, what they took, and what was counted in", async () => {
  const before = (await s.get("/v1/reports/today")).body;
  assert.equal(before.rate.iqdPer100Usd, 145_000);
  assert.match(before.day, /^\d{4}-\d{2}-\d{2}$/);

  const payer = await s.customer(unique("PAYS "));
  const dinars = await s.customer(unique("DINARS "));
  const forgot = await s.customer(unique("FORGOT "));
  const held = await s.customer(unique("HELD "));
  const byWallet = await s.customer(unique("WALLET AT THE DOOR "));
  const file = await s.file([[payer, 10_000], [dinars, 5_000], [forgot, 3_000], [held, 2_000], [byWallet, 4_000]]);
  const c = (customer: string) => file.by[customer] as string;
  const round = await s.roundOut([c(payer), c(dinars), c(forgot), c(held), c(byWallet)]);

  const out = (await s.get("/v1/reports/today")).body;
  assert.equal(out.expectedUsdCents - before.expectedUsdCents, 24_000, "everything on the round is still to collect");
  assert.equal(out.collectedUsdCents - before.collectedUsdCents, 0);
  const mine = (report: { rounds: { id: string }[] }) => report.rounds.find((r) => r.id === round) as Record<string, unknown>;
  assert.deepEqual([mine(out).status, mine(out).stops, mine(out).results], ["out", 5, 0]);
  const inFiles = (report: { files: { id: string }[] }) => report.files.find((f) => f.id === file.id) as Record<string, unknown>;
  assert.deepEqual(
    [inFiles(out).code, inFiles(out).status, inFiles(out).consignments, inFiles(out).notDelivered, inFiles(out).expectedUsdCents, inFiles(out).collectedUsdCents],
    [file.code, "on_rounds", 5, 5, 24_000, 0],
  );

  await s.send("PUT", `/v1/rounds/${round}/results`, {
    results: [
      result(c(payer), "paid", { amount: 10_000, currency: "USD" }),
      result(c(dinars), "paid", { amount: 72_500, currency: "IQD" }),
      result(c(forgot), "unpaid"),
      result(c(held), "held"),
      result(c(byWallet), "paid", { amount: 4_000, currency: "USD" }, "fastpay"),
    ],
  });
  const officeBefore = before.officePaymentsUsdCents;
  const back = (await s.get("/v1/reports/today")).body;
  const cash = (report: { cash: { currency: string }[] }, currency: string) => report.cash.find((x) => x.currency === currency) as unknown as { collected: number; counted: number; gap: number };
  assert.equal(back.expectedUsdCents - before.expectedUsdCents, 24_000, "what was due does not change when some of it is paid");
  assert.equal(back.collectedUsdCents - before.collectedUsdCents, 19_000, "cash and the wallet at the door");
  assert.equal(back.officePaymentsUsdCents, officeBefore, "a wallet at the door is the round collecting, not the office");
  assert.equal(cash(back, "USD").collected - cash(before, "USD").collected, 10_000, "the wallet money is not cash to count in");
  assert.equal(cash(back, "IQD").collected - cash(before, "IQD").collected, 72_500);
  assert.equal(cash(back, "USD").counted - cash(before, "USD").counted, 0);
  assert.equal(cash(back, "USD").gap - cash(before, "USD").gap, 10_000, "the cash is still with the driver");
  assert.equal(back.heldInCar - before.heldInCar, 1);
  assert.equal(back.alerts.open - before.alerts.open, 1, "the one he forgot to collect");
  assert.deepEqual([mine(back).status, mine(back).results, mine(back).missedCollections], ["returned", 5, 1]);
  assert.deepEqual([inFiles(back).notDelivered, inFiles(back).deliveredNotPaid, inFiles(back).collectedUsdCents], [1, 1, 19_000]);

  // Counted in, $20 short.
  const handed = await s.send("POST", `/v1/rounds/${round}/hand-in`, {
    id: randomUUID(), happenedAt: now(), usdNotes: { 5000: 1, 2000: 1, 1000: 1 }, iqdNotes: { 50000: 1, 10000: 2, 1000: 2, 500: 1 }, note: "He says $20 is at home",
  });
  assert.equal(handed.status, 201, JSON.stringify(handed.body));
  const counted = (await s.get("/v1/reports/today")).body;
  assert.equal(cash(counted, "USD").counted - cash(before, "USD").counted, 8_000);
  assert.equal(cash(counted, "IQD").counted - cash(before, "IQD").counted, 72_500);
  assert.equal(cash(counted, "USD").gap - cash(before, "USD").gap, 2_000);
  assert.equal(cash(counted, "IQD").gap - cash(before, "IQD").gap, 0);
  assert.equal(mine(counted).status, "handed_in", "a round counted in today stays on today's screen");
  const gap = (await alerts("open", "&kind=round_cash_gap")).filter((x) => x.roundId === round);
  assert.deepEqual(gap.map((x) => [x.amount, x.currency, x.severity]), [[2_000, "USD", "high"]]);

  // Money paid at the office is its own line.
  await s.send("POST", "/v1/payments", { customerId: forgot, received: { amount: 1_000, currency: "USD" }, method: "office_cash" });
  await s.send("POST", "/v1/payments", { customerId: forgot, received: { amount: 14_500, currency: "IQD" }, method: "fib" });
  const paid = (await s.get("/v1/reports/today")).body;
  assert.equal(paid.officePaymentsUsdCents - officeBefore, 2_000);
  assert.equal(paid.collectedUsdCents, counted.collectedUsdCents, "paying at the office is not the round collecting");

  // The owner reads the same screen. The monitor does not.
  assert.equal((await s.get("/v1/reports/today", ownerCookie)).status, 200);
  assert.equal((await s.get("/v1/reports/today", monitorCookie)).status, 403);
  assert.equal((await s.get("/v1/alerts", monitorCookie)).status, 403);
  await s.sound();
});

test("a wallet is checked against its app: a gap needs a note and raises an alert", async () => {
  const customer = await s.customer(unique("WALLET "));
  await s.file([[customer, 50_000]]);
  const wallet = async () => (await s.get("/v1/wallets")).body.wallets.find((w: { code: string }) => w.code === "wallet_zaincash_iqd");
  const before = await wallet();
  assert.deepEqual([before.method, before.currency, before.name], ["zaincash", "IQD", "ZainCash, dinars"]);

  await s.send("POST", "/v1/payments", { customerId: customer, received: { amount: 145_000, currency: "IQD" }, method: "zaincash" });
  const paid = await wallet();
  assert.equal(paid.ledgerBalance - before.ledgerBalance, 145_000);
  assert.equal(paid.expectedInApp - before.expectedInApp, 145_000);
  assert.ok(!Number.isNaN(Date.parse(paid.uncheckedSince)));
  assert.equal(paid.checkDue, false, "it came in a moment ago");

  const check = (appBalance: number, extra: Record<string, unknown> = {}, id = randomUUID()) =>
    s.send("POST", "/v1/wallets/checks", { id, wallet: "wallet_zaincash_iqd", appBalance, ...extra });
  const noNote = await check(paid.expectedInApp - 45_000);
  assert.equal(noNote.status, 422);
  assert.equal(noNote.body.code, "gap_note_required");
  assert.equal((await check(-1, { note: "x" })).status, 400);
  assert.equal((await check(1.5, { note: "x" })).status, 400);
  assert.equal((await s.send("POST", "/v1/wallets/checks", { id: randomUUID(), wallet: "vault_usd", appBalance: 0, note: "x" })).status, 400);
  assert.equal((await check(1, { note: "x", checkedAt: new Date(Date.now() + 3_600_000).toISOString() })).status, 400, "not in the future");
  assert.equal((await wallet()).lastCheckedAt, before.lastCheckedAt, "nothing was recorded");

  const id = randomUUID();
  const short = await check(paid.expectedInApp - 45_000, { note: "took 45,000 out as cash" }, id);
  assert.equal(short.status, 201, JSON.stringify(short.body));
  const first = short.body.checks[0];
  assert.deepEqual(
    [first.id, first.code, first.currency, first.appBalance, first.expected, first.difference, first.note, first.checkedByName],
    [id, "wallet_zaincash_iqd", "IQD", paid.expectedInApp - 45_000, paid.expectedInApp, -45_000, "took 45,000 out as cash", "Sarkar"],
  );
  const after = await wallet();
  assert.equal(after.expectedInApp, paid.expectedInApp - 45_000, "from now on the app is expected to show what it showed");
  assert.equal(after.ledgerBalance, paid.ledgerBalance, "the ledger is not touched");
  assert.deepEqual([after.lastDifference, after.uncheckedSince, after.checkDue], [-45_000, null, false]);

  // The same check sent again is one check.
  assert.equal((await check(1, { note: "something else" }, id)).status, 201);
  const { rows } = await h.owner.query("select count(*)::int as n from wallet_checks where id = $1", [id]);
  assert.equal(rows[0].n, 1);
  assert.equal((await wallet()).expectedInApp, after.expectedInApp);

  const gaps = (await alerts("open", "&kind=wallet_gap")).filter((x) => x.amount === -45_000 && x.currency === "IQD" && x.title === "ZainCash, dinars: the app shows 45,000 IQD less than the books");
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.severity, "high");

  // When the app matches, no note is needed and no alert follows.
  const gapsBefore = (await alerts("open", "&kind=wallet_gap")).length;
  const exact = await check(after.expectedInApp);
  assert.equal(exact.status, 201);
  assert.equal(exact.body.checks[0].difference, 0);
  assert.equal((await alerts("open", "&kind=wallet_gap")).length, gapsBefore);

  assert.equal((await s.get("/v1/wallets", ownerCookie)).status, 200);
  assert.equal((await call(h.app, "POST", "/v1/wallets/checks", { cookie: ownerCookie, body: { id: randomUUID(), wallet: "wallet_fib_usd", appBalance: 0, note: "x" } })).status, 403);
  await s.sound();
});

test("the settings are the CEO's to change, and every change is on record", async () => {
  const read = await s.get("/v1/settings");
  assert.equal(read.status, 200);
  assert.deepEqual(
    [read.body.heldInCarDays, read.body.vaultCloseTime, read.body.walletCheckDays, read.body.monitorWidgets],
    [3, "18:00", 7, ["files", "rounds", "held"]],
  );
  assert.deepEqual((await s.get("/v1/settings", ownerCookie)).body, read.body);
  assert.equal((await s.get("/v1/settings", monitorCookie)).status, 403);

  for (const bad of [
    {},
    { heldInCarDays: 0 },
    { heldInCarDays: 61 },
    { heldInCarDays: 2.5 },
    { walletCheckDays: 0 },
    { vaultCloseTime: "6pm" },
    { vaultCloseTime: "24:00" },
    { vaultCloseTime: "18:60" },
    { monitorWidgets: ["files", "money"] },
    { monitorWidgets: ["files", "files"] },
    { heldInCarDays: 4, somethingElse: true },
  ]) {
    const reply = await s.send("PUT", "/v1/settings", bad);
    assert.equal(reply.status, 400, JSON.stringify(bad));
  }
  assert.equal((await call(h.app, "PUT", "/v1/settings", { cookie: ownerCookie, body: { heldInCarDays: 5 } })).status, 403);
  assert.deepEqual((await s.get("/v1/settings")).body, read.body, "nothing changed");

  const logged = async () => (await h.owner.query("select count(*)::int as n from audit_log where entity = 'settings'")).rows[0].n as number;
  const before = await logged();
  const changed = await s.send("PUT", "/v1/settings", { heldInCarDays: 5, vaultCloseTime: "17:30" });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(
    [changed.body.heldInCarDays, changed.body.vaultCloseTime, changed.body.walletCheckDays, changed.body.monitorWidgets],
    [5, "17:30", 7, ["files", "rounds", "held"]],
  );
  assert.equal(await logged(), before + 1);
  const { rows } = await h.owner.query(
    "select actor, before ->> 'held_in_car_days' as was, after ->> 'held_in_car_days' as is from audit_log where entity = 'settings' order by id desc limit 1",
  );
  assert.deepEqual([rows[0].actor, rows[0].was, rows[0].is], [ceo.id, "3", "5"]);

  const back = await s.send("PUT", "/v1/settings", { heldInCarDays: 3, vaultCloseTime: "18:00" });
  assert.deepEqual([back.body.heldInCarDays, back.body.vaultCloseTime], [3, "18:00"]);
});

test("the office monitor shows the chosen widgets, in the chosen order, and no money", async () => {
  const waitingName = unique("SCREEN HELD ");
  const waiting = await s.customer(waitingName);
  const going = await s.customer(unique("SCREEN OUT "));
  const file = await s.file([[waiting, 4_000], [going, 6_000]]);
  const first = await s.roundOut([file.by[waiting] as string]);
  await s.send("PUT", `/v1/rounds/${first}/results`, { results: [result(file.by[waiting] as string, "held")] });
  const second = await s.roundOut([file.by[going] as string]);
  const secondNumber = (await s.get(`/v1/rounds/${second}`)).body.number;
  const driverName = (await s.get(`/v1/rounds/${second}`)).body.driverName;

  const screen = await s.get("/v1/monitor", monitorCookie);
  assert.equal(screen.status, 200, JSON.stringify(screen.body));
  assert.deepEqual(screen.body.widgets, ["files", "rounds", "held"]);
  assert.ok(!Number.isNaN(Date.parse(screen.body.at)));

  const onScreen = screen.body.files.find((f: { code: string }) => f.code === file.code);
  assert.deepEqual(onScreen, { code: file.code, status: "on_rounds", consignments: 2, delivered: 0 });
  const round = screen.body.rounds.find((r: { number: number }) => r.number === secondNumber);
  assert.deepEqual([round.status, round.carriedBy, round.stops, round.done], ["out", driverName, 1, 0]);
  assert.ok(!Number.isNaN(Date.parse(round.leftAt)));
  const held = screen.body.held.find((x: { customerName: string }) => x.customerName === waitingName);
  assert.equal(held.shipmentCode, file.code);
  assert.ok(!Number.isNaN(Date.parse(held.heldSince)));

  // No money, anywhere on it, whatever is added to the lists it reads from.
  const keys = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        keys.add(key);
        walk(inner);
      }
    }
  };
  walk(screen.body);
  assert.deepEqual(
    [...keys].sort(),
    ["at", "carriedBy", "city", "code", "consignments", "customerName", "delivered", "done", "files", "heldSince", "held", "leftAt", "number", "rounds", "shipmentCode", "status", "stops", "widgets"].sort(),
  );

  // The CEO and the owner can look at what the screen shows.
  assert.equal((await s.get("/v1/monitor")).status, 200);
  assert.equal((await s.get("/v1/monitor", ownerCookie)).status, 200);

  // The CEO picks what it shows, and in what order. A widget that is off is not sent at all.
  await s.send("PUT", "/v1/settings", { monitorWidgets: ["held", "rounds"] });
  const fewer = (await s.get("/v1/monitor", monitorCookie)).body;
  assert.deepEqual(fewer.widgets, ["held", "rounds"]);
  assert.deepEqual(Object.keys(fewer).sort(), ["at", "held", "rounds", "widgets"]);
  await s.send("PUT", "/v1/settings", { monitorWidgets: [] });
  assert.deepEqual(Object.keys((await s.get("/v1/monitor", monitorCookie)).body).sort(), ["at", "widgets"]);
  await s.send("PUT", "/v1/settings", { monitorWidgets: ["files", "rounds", "held"] });

  // The monitor reads its screen and nothing else.
  for (const url of ["/v1/customers", "/v1/shipments", "/v1/rounds", "/v1/payments", "/v1/vault", "/v1/wallets", "/v1/settings", "/v1/alerts/count"]) {
    assert.equal((await s.get(url, monitorCookie)).status, 403, url);
  }
});

test("the checks never failed, and the books are sound", async () => {
  assert.equal(h.app.ctx.checks.failed, 0, String(h.app.ctx.checks.lastError));
  // Every open alert is about something that is wrong right now, and the other way round.
  await s.driver();
  const { rows } = await h.owner.query(
    `select (select count(*) from alerts a where a.active
               and not exists (select 1 from gs_current_problems(now(), false) p where p.kind = a.kind and p.subject = a.subject))::int as stale,
            (select count(*) from gs_current_problems(now(), false) p
               where not exists (select 1 from alerts a where a.active and a.kind = p.kind and a.subject = p.subject))::int as missing`,
  );
  assert.deepEqual(rows[0], { stale: 0, missing: 0 });
  await s.sound();
});
