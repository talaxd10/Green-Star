// Rounds, over the real routes against a real Postgres.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { nextPhone, seedUser, signIn, start } from "./helpers.ts";
import { RATE, result, Scene, unique } from "./scene.ts";

const h = await start();
after(() => h.close());

const ceo = await seedUser(h, "ceo", "Sarkar");
const s = new Scene(h, await signIn(h, ceo));
const ownerCookie = await signIn(h, await seedUser(h, "owner"));
await s.rate();

const now = () => new Date().toISOString();
const stopOf = (round: { stopList: { consignmentId: string }[] }, consignmentId: string) =>
  round.stopList.find((stop) => stop.consignmentId === consignmentId) as Record<string, unknown>;

test("the board's round 14: four customers, one paid in dinars, one held, one on account, one the driver forgot", async () => {
  const rebwar = await s.customer("Rebwar A.");
  const shvan = await s.customer("Shvan K.");
  const dara = await s.customer("Dara M.", { trusted: true });
  const hemn = await s.customer("Hemn S.");
  const first = await s.file([[rebwar, 8_500], [shvan, 4_000]]);
  const second = await s.file([[dara, 31_000], [hemn, 6_200]]);
  const [cRebwar, cShvan, cDara, cHemn] = [first.by[rebwar], first.by[shvan], second.by[dara], second.by[hemn]] as [string, string, string, string];
  const vaultBefore = await s.account("vault_iqd");

  // Before he leaves: the driver, goods from both files, cartons counted at the airport.
  const driverId = await s.driver("Karwan");
  const created = await s.send("POST", "/v1/rounds", {
    driverId,
    stops: [{ consignmentId: cRebwar, cartonsCounted: 3 }, { consignmentId: cShvan }, { consignmentId: cDara }, { consignmentId: cHemn }],
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.status, "planned");
  assert.equal(created.body.driverName, "Karwan");
  assert.equal(created.body.stops, 4);
  assert.deepEqual([...new Set(created.body.stopList.map((x: { shipmentCode: string }) => x.shipmentCode))].sort(), [first.code, second.code].sort());
  assert.equal(stopOf(created.body, cRebwar).cartonsReceived, 3);
  assert.equal(stopOf(created.body, cRebwar).consignmentStatus, "on_round");

  const out = await s.send("POST", `/v1/rounds/${id}/depart`, {});
  assert.equal(out.body.status, "out");

  // He is back with cash, receipts and photos.
  const entered = await s.send("PUT", `/v1/rounds/${id}/results`, {
    results: [
      result(cRebwar, "paid", { amount: 123_250, currency: "IQD" }),
      result(cShvan, "held"),
      result(cDara, "on_account"),
      result(cHemn, "unpaid"),
    ],
  });
  assert.equal(entered.status, 200);
  const round = entered.body;
  assert.equal(round.status, "returned");
  assert.equal(round.results, 4);
  assert.equal(round.collectedIqd, 123_250);
  assert.equal(round.collectedUsdCents, 0);
  assert.equal(round.missedCollections, 1, "Hemn S. was delivered without payment");

  assert.deepEqual(
    [cRebwar, cShvan, cDara, cHemn].map((c) => {
      const stop = stopOf(round, c);
      return [stop.outcome, stop.consignmentStatus, stop.creditedUsdCents, stop.remainingUsdCents, stop.missedCollection];
    }),
    [
      ["paid", "delivered_paid", 8_500, 0, false],
      ["held", "held", null, 4_000, false],
      ["on_account", "delivered_on_account", null, 31_000, false],
      ["unpaid", "delivered_not_paid", null, 6_200, true],
    ],
  );
  assert.equal(stopOf(round, cRebwar).iqdPer100Usd, RATE, "the dinars carry the day's rate");
  assert.deepEqual(round.cash.find((c: { currency: string }) => c.currency === "IQD"), { currency: "IQD", collected: 123_250, handedIn: 0, gap: 123_250 });
  assert.equal(await s.balance(rebwar), 0);
  assert.equal(await s.balance(dara), 31_000);

  // The cash is counted note by note and matches the receipts.
  const handed = await s.send("POST", `/v1/rounds/${id}/hand-in`, {
    id: randomUUID(),
    happenedAt: now(),
    iqdNotes: { 25000: 4, 10000: 2, 1000: 3, 250: 1 },
  });
  assert.equal(handed.status, 201);
  assert.equal(handed.body.status, "handed_in");
  assert.equal(handed.body.gapIqd, 0);
  assert.deepEqual(handed.body.handIns[0].counts.find((c: { currency: string }) => c.currency === "IQD"), {
    currency: "IQD",
    notes: { 25000: 4, 10000: 2, 1000: 3, 250: 1 },
    counted: 123_250,
    expected: 123_250,
    difference: 0,
  });
  assert.equal((await s.account("vault_iqd")) - vaultBefore, 123_250);
  assert.equal(stopOf(handed.body, cRebwar).consignmentStatus, "closed");

  assert.deepEqual((await s.get(`/v1/rounds/${id}`, ownerCookie)).body, handed.body, "the owner sees the same round");
  await s.sound();
});

test("the rows of a round are saved together or not at all", async () => {
  const good = await s.customer();
  const payFirst = await s.customer();
  const file = await s.file([[good, 5_000], [payFirst, 2_000]]);
  const round = await s.roundOut([file.by[good] as string, file.by[payFirst] as string]);

  const refused = await s.send("PUT", `/v1/rounds/${round}/results`, {
    results: [
      result(file.by[good] as string, "paid", { amount: 5_000, currency: "USD" }),
      result(file.by[payFirst] as string, "on_account"),   // he is not trusted
    ],
  });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, "not_trusted");
  assert.match(refused.body.message, /pay first and cannot take goods on account/);

  const detail = (await s.get(`/v1/rounds/${round}`)).body;
  assert.equal(detail.results, 0, "the good row was not saved either");
  assert.equal(detail.status, "out");
  assert.equal(await s.balance(good), 5_000);
  await s.sound();
});

test("a result is checked before it is sent on: amount with method, known outcome, a real time", async () => {
  const a = await s.customer();
  const file = await s.file([[a, 5_000]]);
  const round = await s.roundOut([file.by[a] as string]);
  const base = result(file.by[a] as string, "paid", { amount: 5_000, currency: "USD" });
  const cases: [Record<string, unknown>, string][] = [
    [{ ...base, method: undefined }, "results.0.method"],
    [{ ...base, received: undefined }, "results.0.method"],
    [{ ...base, received: { amount: 50.5, currency: "USD" } }, "results.0.received.amount"],
    [{ ...base, received: { amount: 0, currency: "USD" } }, "results.0.received.amount"],
    [{ ...base, received: { amount: 5_000, currency: "EUR" } }, "results.0.received.currency"],
    [{ ...base, method: "office_cash" }, "results.0.method"],
    [{ ...base, outcome: "lost" }, "results.0.outcome"],
    [{ ...base, happenedAt: "yesterday" }, "results.0.happenedAt"],
    [{ ...base, happenedAt: new Date(Date.now() + 86_400_000).toISOString() }, "results.0.happenedAt"],
    [{ ...base, id: "1" }, "results.0.id"],
  ];
  for (const [row, field] of cases) {
    const reply = await s.send("PUT", `/v1/rounds/${round}/results`, { results: [row] });
    assert.equal(reply.status, 400, JSON.stringify(row));
    assert.ok(field in reply.body.fields, `${JSON.stringify(reply.body.fields)} should name ${field}`);
  }
  assert.equal((await s.send("PUT", `/v1/rounds/${round}/results`, { results: [] })).status, 400);
  assert.equal((await s.get(`/v1/rounds/${round}`)).body.results, 0);
});

test("entering a stop again replaces its result, and the same save twice is one payment", async () => {
  const a = await s.customer();
  const file = await s.file([[a, 5_000]]);
  const c = file.by[a] as string;
  const round = await s.roundOut([c]);

  const wrong = { results: [result(c, "paid", { amount: 500, currency: "USD" })] };
  await s.send("PUT", `/v1/rounds/${round}/results`, wrong);
  assert.equal(await s.balance(a), 4_500);

  // The right amount, saved twice: a double click, then the same rows sent again later.
  const right = { results: [result(c, "paid", { amount: 5_000, currency: "USD" })] };
  const key = randomUUID();
  const once = await s.send("PUT", `/v1/rounds/${round}/results`, right, key);
  const twice = await s.send("PUT", `/v1/rounds/${round}/results`, right, key);
  assert.deepEqual(twice.body, once.body);
  assert.equal(twice.headers["idempotent-replay"], "true");
  await s.send("PUT", `/v1/rounds/${round}/results`, right);
  assert.equal(await s.balance(a), 0, "one payment of $50, not three, and the $5 was reversed");
  assert.equal((await s.get(`/v1/rounds/${round}`)).body.collectedUsdCents, 5_000);

  // Taken back: the stop is open again and the money is off his account.
  const resultId = once.body.stopList[0].resultId;
  assert.equal((await s.send("POST", `/v1/round-results/${resultId}/void`, { reason: " " })).status, 400);
  const voided = await s.send("POST", `/v1/round-results/${resultId}/void`, { reason: "Entered on the wrong round" });
  assert.equal(voided.body.results, 0);
  assert.equal(voided.body.stopList[0].outcome, null);
  assert.equal(await s.balance(a), 5_000);
  assert.equal((await s.send("POST", `/v1/round-results/${randomUUID()}/void`, { reason: "x" })).status, 404);
  await s.sound();
});

test("a hand-in that does not match the receipts needs a note, and the gap stays on the round", async () => {
  const a = await s.customer();
  const file = await s.file([[a, 12_000]]);
  const c = file.by[a] as string;
  const round = await s.roundOut([c]);
  const vaultBefore = await s.account("vault_usd");

  const early = await s.send("POST", `/v1/rounds/${round}/hand-in`, { id: randomUUID(), happenedAt: now(), usdNotes: { 10000: 1 } });
  assert.equal(early.status, 422);
  assert.equal(early.body.code, "round_not_back");

  await s.send("PUT", `/v1/rounds/${round}/results`, { results: [result(c, "paid", { amount: 12_000, currency: "USD" })] });

  const short = { id: randomUUID(), happenedAt: now(), usdNotes: { 10000: 1 } };
  const noNote = await s.send("POST", `/v1/rounds/${round}/hand-in`, short);
  assert.equal(noNote.status, 422);
  assert.equal(noNote.body.code, "gap_note_required");
  const badNote = await s.send("POST", `/v1/rounds/${round}/hand-in`, { ...short, usdNotes: { 3000: 4 } });
  assert.equal(badNote.body.code, "note_unknown", "there is no $30 note");

  const noted = await s.send("POST", `/v1/rounds/${round}/hand-in`, { ...short, note: "He says $20 is at home" });
  assert.equal(noted.status, 201);
  assert.equal(noted.body.status, "handed_in");
  assert.equal(noted.body.gapUsdCents, 2_000);
  const usdCount = noted.body.handIns[0].counts.find((c: { currency: string }) => c.currency === "USD");
  assert.deepEqual(usdCount, { currency: "USD", notes: { 10000: 1 }, counted: 10_000, expected: 12_000, difference: -2_000 });
  assert.deepEqual(noted.body.handIns[0].counts.map((c: { currency: string }) => c.currency), ["USD", "IQD"], "dollars first");
  assert.equal(noted.body.handIns[0].note, "He says $20 is at home");
  assert.equal((await s.account("vault_usd")) - vaultBefore, 10_000, "only what was counted reaches the vault");

  // The $20 arrives the next day.
  const rest = await s.send("POST", `/v1/rounds/${round}/hand-in`, { id: randomUUID(), happenedAt: now(), usdNotes: { 2000: 1 } });
  assert.equal(rest.body.gapUsdCents, 0);
  assert.equal((await s.account("vault_usd")) - vaultBefore, 12_000);

  // A hand-in counted wrong is taken back whole.
  const taken = await s.send("POST", `/v1/hand-ins/${rest.body.handIns[1].id}/void`, { reason: "It was a $10 note" });
  assert.equal(taken.body.gapUsdCents, 2_000);
  assert.equal(taken.body.handIns[1].voided, true);
  assert.equal((await s.account("vault_usd")) - vaultBefore, 10_000);
  await s.sound();
});

test("the driver forgot to collect, unless the CEO allowed it", async () => {
  const hemn = await s.customer();
  const prepaid = await s.customer();
  const file = await s.file([[hemn, 6_200], [prepaid, 0]]);
  const c = file.by[hemn] as string;
  const round = await s.roundOut([c, file.by[prepaid] as string]);
  await s.send("PUT", `/v1/rounds/${round}/results`, { results: [result(c, "unpaid"), result(file.by[prepaid] as string, "prepaid")] });
  assert.equal((await s.get(`/v1/rounds/${round}`)).body.missedCollections, 1);

  assert.equal((await s.send("POST", "/v1/exceptions", { consignmentId: c, reason: "" })).status, 400);
  const allowed = await s.send("POST", "/v1/exceptions", { consignmentId: c, reason: "Pays on Thursday, agreed by phone" });
  assert.equal(allowed.status, 201);
  const after = (await s.get(`/v1/rounds/${round}`)).body;
  assert.equal(after.missedCollections, 0);
  assert.equal(stopOf(after, c).hasException, true);
  assert.equal(stopOf(after, c).missedCollection, false);

  assert.equal((await s.send("POST", "/v1/exceptions", { consignmentId: c, reason: "again" })).body.code, "exception_exists");
  assert.equal((await s.send("POST", "/v1/exceptions", { consignmentId: file.by[prepaid], reason: "x" })).body.code, "exception_not_needed");
  assert.equal((await s.send("POST", "/v1/exceptions", { consignmentId: randomUUID(), reason: "x" })).status, 404);
  const { rows } = await h.owner.query("select approved_by from exceptions where consignment_id = $1", [c]);
  assert.equal(rows[0].approved_by, ceo.id);
});

test("goods go on a round only from a confirmed file, on one round at a time, and the round leaves with something on it", async () => {
  const a = await s.customer();
  const b = await s.customer();
  const file = await s.file([[a, 1_000], [b, 2_000]]);
  const draft = await s.draft([[a, 3_000]]);
  const driverId = await s.driver();

  assert.equal((await s.send("POST", "/v1/rounds", { stops: [] })).status, 400, "a round needs a driver or a carrier");
  assert.equal((await s.send("POST", "/v1/rounds", { driverId: randomUUID() })).body.code, "reference_missing");
  const fromDraft = await s.send("POST", "/v1/rounds", { driverId, stops: [{ consignmentId: draft.by[a] }] });
  assert.equal(fromDraft.status, 422);
  assert.equal(fromDraft.body.code, "file_not_confirmed");

  const round = (await s.send("POST", "/v1/rounds", { driverId, note: "Kirkuk road" })).body;
  assert.equal(round.note, "Kirkuk road");
  assert.equal((await s.send("POST", `/v1/rounds/${round.id}/depart`, {})).body.code, "round_empty");

  const added = await s.send("POST", `/v1/rounds/${round.id}/stops`, { consignmentId: file.by[a], cartonsCounted: 2 });
  assert.equal(added.status, 201);
  assert.equal(added.body.stops, 1);
  const other = (await s.send("POST", "/v1/rounds", { driverId })).body;
  const twice = await s.send("POST", `/v1/rounds/${other.id}/stops`, { consignmentId: file.by[a] });
  assert.equal(twice.status, 422);
  assert.equal(twice.body.code, "consignment_not_available");

  const removed = await s.send("DELETE", `/v1/rounds/${round.id}/stops/${file.by[a]}`);
  assert.equal(removed.body.stops, 0);
  assert.equal((await s.send("POST", `/v1/rounds/${other.id}/stops`, { consignmentId: file.by[a] })).status, 201, "free again once it is taken off");
  assert.equal((await s.get(`/v1/rounds/${randomUUID()}`)).status, 404);
  assert.equal((await s.send("POST", `/v1/rounds/${randomUUID()}/stops`, { consignmentId: file.by[b] })).status, 404);
});

test("dinars cannot be taken on a day whose rate is not set", async () => {
  const a = await s.customer();
  const file = await s.file([[a, 8_500]]);
  const c = file.by[a] as string;
  const round = await s.roundOut([c]);
  // Three years ago: nobody set a rate that day.
  const then = new Date(Date.now() - 3 * 365 * 86_400_000).toISOString();
  const reply = await s.send("PUT", `/v1/rounds/${round}/results`, {
    results: [{ ...result(c, "paid", { amount: 123_250, currency: "IQD" }), happenedAt: then }],
  });
  assert.equal(reply.status, 422);
  assert.equal(reply.body.code, "rate_missing");
  assert.match(reply.body.message, /^set the dinar rate for \d{4}-\d{2}-\d{2} first$/);
  assert.equal(await s.balance(a), 8_500);
});

test("drivers and carriers are added, renamed and switched off; a transport office carries a round like a driver", async () => {
  const phone = nextPhone();
  const name = unique("Driver ");
  const driver = await s.send("POST", "/v1/drivers", { name, phone: `0${phone.slice(4)}` });
  assert.equal(driver.status, 201);
  assert.deepEqual(driver.body, { id: driver.body.id, name, phone, active: true });
  assert.equal((await s.send("POST", "/v1/drivers", { name: "X", phone: "123" })).status, 400);

  const renamed = await s.send("PATCH", `/v1/drivers/${driver.body.id}`, { name: `${name} Jr`, phone: null, active: false });
  assert.deepEqual(renamed.body, { id: driver.body.id, name: `${name} Jr`, phone: null, active: false });
  const listed = (await s.get("/v1/drivers", ownerCookie)).body.items.find((d: { id: string }) => d.id === driver.body.id);
  assert.equal(listed.active, false);
  assert.equal((await s.send("PATCH", `/v1/drivers/${randomUUID()}`, { name: "x" })).status, 404);

  const office = await s.send("POST", "/v1/carriers", { name: unique("Mosul office "), kind: "transport_office", city: "Mosul" });
  assert.equal(office.status, 201);
  assert.equal(office.body.kind, "transport_office");
  assert.equal((await s.send("POST", "/v1/carriers", { name: "No kind" })).status, 400);
  const moved = await s.send("PATCH", `/v1/carriers/${office.body.id}`, { city: null });
  assert.equal(moved.body.city, null);
  assert.ok((await s.get("/v1/carriers")).body.items.some((c: { id: string }) => c.id === office.body.id));

  const a = await s.customer();
  const file = await s.file([[a, 2_500]]);
  const round = await s.send("POST", "/v1/rounds", { carrierId: office.body.id, stops: [{ consignmentId: file.by[a] }] });
  assert.equal(round.status, 201);
  assert.equal(round.body.carrierName, office.body.name);
  assert.equal(round.body.driverName, null);
});

test("rounds are listed newest first and by status", async () => {
  const a = await s.customer();
  const file = await s.file([[a, 1_000]]);
  const out = await s.roundOut([file.by[a] as string]);
  const planned = (await s.send("POST", "/v1/rounds", { driverId: await s.driver() })).body.id;

  const first = (await s.get("/v1/rounds?limit=2")).body;
  assert.deepEqual(first.items.map((r: { id: string }) => r.id), [planned, out]);
  assert.ok(first.items[0].number > first.items[1].number);
  const onlyOut = (await s.get("/v1/rounds?status=out&limit=200")).body.items.map((r: { id: string }) => r.id);
  assert.ok(onlyOut.includes(out) && !onlyOut.includes(planned));
});
