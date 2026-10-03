// Files, consignments and disputes, over the real routes against a real Postgres.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { seedUser, signIn, start } from "./helpers.ts";
import { result, Scene, unique } from "./scene.ts";

const h = await start();
after(() => h.close());

const ceo = await seedUser(h, "ceo", "Sarkar");
const s = new Scene(h, await signIn(h, ceo));
const ownerCookie = await signIn(h, await seedUser(h, "owner"));

test("a file typed in by hand is a draft and charges nobody until it is confirmed", async () => {
  const a = await s.customer();
  const b = await s.customer();
  const prepaid = await s.customer();
  const code = unique("GSSK");

  const draft = await s.send("POST", "/v1/shipments", {
    code,
    arrivedOn: "2026-10-01",
    consignments: [
      { customerId: a, amountDueUsdCents: 8_500, otherChargesUsdCents: 500, cartonsExpected: 3, city: "Erbil" },
      { customerId: b, amountDueUsdCents: 31_000 },
      { customerId: prepaid, amountDueUsdCents: 0 },
    ],
  });
  assert.equal(draft.status, 201);
  assert.equal(draft.body.status, "draft");
  assert.equal(draft.body.code, code);
  assert.equal(draft.body.arrivedOn, "2026-10-01");
  assert.equal(draft.body.consignments, 3);
  assert.equal(draft.body.expectedUsdCents, 0, "nothing is owed on a draft");
  assert.equal(await s.balance(a), 0);
  assert.equal(await s.balance(b), 0);

  const confirmed = await s.send("POST", `/v1/shipments/${draft.body.id}/confirm`, {});
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.status, "confirmed");
  assert.equal(confirmed.body.expectedUsdCents, 39_500);
  assert.equal(confirmed.body.collectedUsdCents, 0);
  assert.equal(confirmed.body.notDelivered, 3);
  assert.ok(Date.parse(confirmed.body.confirmedAt) <= Date.now());
  assert.equal(await s.balance(a), 8_500);
  assert.equal(await s.balance(b), 31_000);
  assert.equal(await s.balance(prepaid), 0, "prepaid in China: nothing to collect");

  const row = confirmed.body.consignmentList.find((c: { customerId: string }) => c.customerId === a);
  assert.equal(row.status, "listed");
  assert.equal(row.amountDueUsdCents, 8_500);
  assert.equal(row.otherChargesUsdCents, 500);
  assert.equal(row.remainingUsdCents, 8_500);
  assert.equal(row.cartonsExpected, 3);
  assert.equal(row.city, "Erbil");
  assert.equal(row.trust, "pay_first");

  // Confirming again, as a new request, charges nobody twice.
  assert.equal((await s.send("POST", `/v1/shipments/${draft.body.id}/confirm`, {})).status, 200);
  assert.equal(await s.balance(a), 8_500);
  await s.sound();
});

test("a draft can be changed row by row until it is confirmed, and not after", async () => {
  const a = await s.customer();
  const b = await s.customer();
  const draft = await s.draft([[a, 5_000]]);

  const changed = await s.send("PUT", `/v1/shipments/${draft.id}`, {
    code: `${draft.code}-B`,
    consignments: [{ customerId: a, amountDueUsdCents: 6_000 }, { customerId: b, amountDueUsdCents: 2_000 }],
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.code, `${draft.code}-B`);
  assert.deepEqual(changed.body.consignmentList.map((c: { amountDueUsdCents: number }) => c.amountDueUsdCents).sort(), [2_000, 6_000]);

  await s.send("POST", `/v1/shipments/${draft.id}/confirm`, {});
  const late = await s.send("PUT", `/v1/shipments/${draft.id}`, { code: draft.code, consignments: [{ customerId: a, amountDueUsdCents: 1 }] });
  assert.equal(late.status, 422);
  assert.equal(late.body.code, "shipment_locked");
  assert.equal(await s.balance(a), 6_000);
  assert.equal(await s.balance(b), 2_000);
});

test("what is typed on a file is checked, and a refused file leaves nothing behind", async () => {
  const a = await s.customer();
  const existing = await s.draft([[a, 1_000]]);
  const code = unique("BAD");
  const cases: [unknown, number, string, string?][] = [
    [{ code, consignments: [] }, 400, "invalid_request", "consignments"],
    [{ code, consignments: [{ customerId: a, amountDueUsdCents: -5 }] }, 400, "invalid_request", "consignments.0.amountDueUsdCents"],
    [{ code, consignments: [{ customerId: a, amountDueUsdCents: 85.5 }] }, 400, "invalid_request", "consignments.0.amountDueUsdCents"],
    [{ code, consignments: [{ customerId: a, amountDueUsdCents: 100, otherChargesUsdCents: 200 }] }, 400, "invalid_request", "consignments.0.otherChargesUsdCents"],
    [{ code, consignments: [{ customerId: a, amountDueUsdCents: 100 }, { customerId: a, amountDueUsdCents: 200 }] }, 400, "invalid_request", "consignments.1.customerId"],
    [{ code, consignments: [{ customerId: randomUUID(), amountDueUsdCents: 100 }] }, 400, "invalid_request", "consignments.0.customerId"],
    [{ code, arrivedOn: "yesterday", consignments: [{ customerId: a, amountDueUsdCents: 100 }] }, 400, "invalid_request", "arrivedOn"],
    [{ code: existing.code, consignments: [{ customerId: a, amountDueUsdCents: 100 }] }, 409, "file_code_taken"],
  ];
  for (const [body, status, errorCode, field] of cases) {
    const reply = await s.send("POST", "/v1/shipments", body);
    assert.equal(reply.status, status, JSON.stringify(body));
    assert.equal(reply.body.code, errorCode);
    if (field !== undefined) assert.ok(field in reply.body.fields, `${JSON.stringify(reply.body.fields)} should name ${field}`);
  }
  const { rows } = await h.owner.query("select count(*)::int as n from shipments where code = $1", [code]);
  assert.equal(rows[0].n, 0);
  assert.equal((await s.send("POST", `/v1/shipments/${randomUUID()}/confirm`, {})).status, 404);
  assert.equal((await s.get(`/v1/shipments/${randomUUID()}`)).status, 404);
});

test("a consignment on a confirmed file is cancelled with a reason, which reverses its charge", async () => {
  const a = await s.customer();
  const b = await s.customer();
  const file = await s.file([[a, 5_000], [b, 3_000]]);

  const noReason = await s.send("POST", `/v1/consignments/${file.by[a]}/cancel`, { reason: "  " });
  assert.equal(noReason.status, 400);
  assert.equal(await s.balance(a), 5_000);

  const cancelled = await s.send("POST", `/v1/consignments/${file.by[a]}/cancel`, { reason: "Wrong customer on the file" });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.consignments, 1);
  assert.equal(cancelled.body.expectedUsdCents, 3_000);
  assert.deepEqual(cancelled.body.consignmentList.map((c: { customerId: string }) => c.customerId), [b]);
  assert.equal(await s.balance(a), 0);
  assert.equal((await s.send("POST", `/v1/consignments/${randomUUID()}/cancel`, { reason: "x" })).status, 404);
  await s.sound();
});

test("a wrong amount is corrected: the old consignment is cancelled and the right one charged", async () => {
  const a = await s.customer();
  const file = await s.file([[a, 5_000]]);

  const fixed = await s.send("POST", `/v1/consignments/${file.by[a]}/correct`, { amountDueUsdCents: 6_200, reason: "File said 62, typed 50" });
  assert.equal(fixed.status, 200);
  assert.notEqual(fixed.body.id, file.by[a], "the replacement is a new consignment");
  assert.equal(fixed.body.amountDueUsdCents, 6_200);
  assert.equal(fixed.body.remainingUsdCents, 6_200);
  assert.equal(fixed.body.shipmentId, file.id);
  assert.equal(await s.balance(a), 6_200);

  const bad = await s.send("POST", `/v1/consignments/${fixed.body.id}/correct`, { amountDueUsdCents: 100, otherChargesUsdCents: 200, reason: "x" });
  assert.equal(bad.status, 400);
  const again = await s.send("POST", `/v1/consignments/${file.by[a]}/correct`, { amountDueUsdCents: 1, reason: "the old one" });
  assert.equal(again.status, 422);
  assert.equal(again.body.code, "consignment_cancelled");
  assert.equal(await s.balance(a), 6_200);
  await s.sound();
});

test("a problem with goods is sent to China and keeps the file open until China answers", async () => {
  const a = await s.customer(unique("Disputed "), { trusted: true });
  const file = await s.file([[a, 4_000]]);
  const round = await s.roundOut([file.by[a] as string]);
  await s.send("PUT", `/v1/rounds/${round}/results`, { results: [result(file.by[a] as string, "paid", { amount: 4_000, currency: "USD" })] });

  const opened = await s.send("POST", "/v1/disputes", { consignmentId: file.by[a], kind: "damaged", note: "Two cartons crushed" });
  assert.equal(opened.status, 201);
  assert.equal(opened.body.status, "sent_to_china");
  assert.ok(opened.body.sentToChinaAt);
  assert.equal(opened.body.shipmentCode, file.code);

  await s.send("POST", `/v1/rounds/${round}/hand-in`, { id: randomUUID(), happenedAt: new Date().toISOString(), usdNotes: { 2000: 2 } });
  let detail = (await s.get(`/v1/shipments/${file.id}`)).body;
  assert.equal(detail.status, "reconciling", "paid and counted in, but China has not answered");
  assert.equal(detail.disputesWaiting, 1);
  assert.equal(detail.disputes.length, 1);
  const waiting = (await s.get("/v1/disputes?waiting=true")).body.items.map((d: { id: string }) => d.id);
  assert.ok(waiting.includes(opened.body.id));

  const noAnswer = await s.send("PATCH", `/v1/disputes/${opened.body.id}`, { close: true });
  assert.equal(noAnswer.status, 422);
  assert.equal(noAnswer.body.code, "answer_missing");

  const answered = await s.send("PATCH", `/v1/disputes/${opened.body.id}`, { chinaAnswer: "They will send two new cartons" });
  assert.equal(answered.body.status, "answered");
  assert.ok(answered.body.answeredAt);
  detail = (await s.get(`/v1/shipments/${file.id}`)).body;
  assert.equal(detail.status, "closed", "the file closes by itself once China has answered");

  const closed = await s.send("PATCH", `/v1/disputes/${opened.body.id}`, { close: true });
  assert.equal(closed.body.status, "closed");
  assert.equal((await s.send("PATCH", `/v1/disputes/${opened.body.id}`, { chinaAnswer: "again" })).body.code, "dispute_closed");

  // Recorded now, told to China later.
  const later = await s.send("POST", "/v1/disputes", { consignmentId: file.by[a], kind: "weight", sentToChina: false });
  assert.equal(later.body.status, "open");
  assert.equal(later.body.sentToChinaAt, null);
  const sent = await s.send("PATCH", `/v1/disputes/${later.body.id}`, { sentToChina: true });
  assert.equal(sent.body.status, "sent_to_china");
  assert.equal((await s.get("/v1/disputes?status=sent_to_china")).body.items.some((d: { id: string }) => d.id === later.body.id), true);
  assert.equal((await s.send("POST", "/v1/disputes", { consignmentId: randomUUID(), kind: "missing" })).status, 404);
  await s.sound();
});

test("the goods ready for a round are listed, and a customer's consignments with what is owed on each", async () => {
  const a = await s.customer();
  const older = await s.file([[a, 2_000]]);
  const newer = await s.file([[a, 3_000]]);
  const draft = await s.draft([[a, 9_000]]);

  const ready = (await s.get("/v1/consignments?filter=ready")).body.items.map((c: { id: string }) => c.id);
  assert.ok(ready.includes(older.by[a]) && ready.includes(newer.by[a]));
  assert.ok(!ready.includes(draft.by[a]), "a draft file's goods cannot go on a round");

  const his = (await s.get(`/v1/consignments?customerId=${a}&filter=unpaid`)).body.items;
  assert.deepEqual(his.map((c: { id: string }) => c.id), [older.by[a], newer.by[a]], "oldest file first: the order payments are applied in");
  assert.deepEqual(his.map((c: { remainingUsdCents: number }) => c.remainingUsdCents), [2_000, 3_000]);
  assert.equal((await s.get("/v1/consignments")).status, 400);
});

test("files are listed by status, newest first, and the owner sees them too", async () => {
  const a = await s.customer();
  const draft = await s.draft([[a, 1_000]]);
  const confirmed = await s.file([[a, 1_000]]);

  const drafts = (await s.get("/v1/shipments?status=draft&limit=200", ownerCookie)).body.items.map((f: { id: string }) => f.id);
  assert.ok(drafts.includes(draft.id) && !drafts.includes(confirmed.id));
  const first = (await s.get("/v1/shipments?limit=1")).body;
  assert.equal(first.items[0].id, confirmed.id);
  assert.ok(first.nextCursor);
  const second = (await s.get(`/v1/shipments?limit=1&cursor=${first.nextCursor}`)).body;
  assert.equal(second.items[0].id, draft.id);
  assert.equal((await s.get("/v1/shipments?status=lost")).status, 400);
});
