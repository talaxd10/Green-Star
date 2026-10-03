// Statements, over the real routes against a real Postgres, drawn with a real
// Chromium.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Statement } from "@green-star/contracts";
import { statementHtml, statementText } from "../src/statement.ts";
import { call, seedUser, signIn, start, type Harness } from "./helpers.ts";
import { Scene, unique } from "./scene.ts";

const h = await start();
after(() => h.close());

const ceo = await seedUser(h, "ceo", "Sarkar");
const s = new Scene(h, await signIn(h, ceo));
const ownerCookie = await signIn(h, await seedUser(h, "owner"));
await s.rate();

const BAGHDAD_MS = 3 * 3_600_000;
const today = () => new Date(Date.now() + BAGHDAD_MS).toISOString().slice(0, 10);
const dayAfter = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const dayText = (value: string | Date = new Date()) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Baghdad", day: "numeric", month: "short", year: "numeric" }).format(
    typeof value === "string" ? new Date(`${value}T12:00:00+03:00`) : value,
  );

const pay = (customerId: string, amount: number, currency: "USD" | "IQD" = "USD", method = "office_cash") =>
  s.send("POST", "/v1/payments", { customerId, received: { amount, currency }, method });

const exportFor = (customerId: string, id: string = randomUUID(), extra: Record<string, unknown> = {}, key?: string) =>
  s.send("POST", `/v1/customers/${customerId}/statement/export`, { id, ...extra }, key);

/** A binary answer, as the bytes that were sent. */
async function bytes(harness: Harness, url: string, cookie = s.cookie) {
  const response = await harness.app.inject({ method: "GET", url, headers: { cookie } });
  return { status: response.statusCode, type: String(response.headers["content-type"]), body: response.rawPayload, json: () => JSON.parse(response.body) };
}

const lineShape = (line: Statement["lines"][number]) => [line.kind, line.changeUsdCents, line.balanceAfterUsdCents, line.shipmentCode, line.method];

test("a statement is every charge and payment in order, each with the balance after it", async () => {
  const name = unique("DARA ");
  const customer = await s.customer(name, { phones: ["0770 555 1001"] });
  const first = await s.file([[customer, 31_000]]);
  await pay(customer, 10_000);
  await pay(customer, 72_500, "IQD", "fib");
  const second = await s.file([[customer, 8_500]]);

  const reply = await s.get(`/v1/customers/${customer}/statement`);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const st: Statement = reply.body;
  assert.deepEqual(
    [st.customerId, st.customerName, st.phone, st.trust, st.creditLimitUsdCents, st.balanceUsdCents, st.from, st.openingBalanceUsdCents, st.chargedUsdCents, st.paidUsdCents],
    [customer, name, "+9647705551001", "pay_first", null, 24_500, null, 0, 39_500, 15_000],
  );
  assert.deepEqual(st.lines.map(lineShape), [
    ["charge", 31_000, 31_000, first.code, null],
    ["payment", -10_000, 21_000, null, "office_cash"],
    ["payment", -5_000, 16_000, null, "fib"],
    ["charge", 8_500, 24_500, second.code, null],
  ]);
  assert.deepEqual([st.lines[2]?.receivedAmount, st.lines[2]?.receivedCurrency, st.lines[2]?.iqdPer100Usd], [72_500, "IQD", 145_000]);
  assert.ok(st.lines.every((line) => line.day === today() && !line.isReversal && !line.isCorrection));
  assert.equal(st.lines.at(-1)?.balanceAfterUsdCents, await s.balance(customer), "the last line is what he owes");
  assert.ok(Math.abs(Date.parse(st.asOf) - Date.now()) < 60_000);

  // The files he has not paid in full: the payments went to the oldest first.
  assert.deepEqual(
    st.open.map((f) => [f.shipmentCode, f.day, f.dueUsdCents, f.paidUsdCents, f.remainingUsdCents]),
    [[first.code, today(), 31_000, 15_000, 16_000], [second.code, today(), 8_500, 0, 8_500]],
  );
  assert.deepEqual(st.lastPayment, { day: today(), amountUsdCents: 5_000 });

  // From a day on: what came before is one opening balance.
  const fromToday: Statement = (await s.get(`/v1/customers/${customer}/statement?from=${today()}`)).body;
  assert.deepEqual([fromToday.from, fromToday.openingBalanceUsdCents, fromToday.lines.length], [today(), 0, 4]);
  const fromTomorrow: Statement = (await s.get(`/v1/customers/${customer}/statement?from=${dayAfter(today(), 1)}`)).body;
  assert.deepEqual(
    [fromTomorrow.openingBalanceUsdCents, fromTomorrow.lines.length, fromTomorrow.chargedUsdCents, fromTomorrow.paidUsdCents, fromTomorrow.balanceUsdCents],
    [24_500, 0, 0, 0, 24_500],
  );
  assert.deepEqual(fromTomorrow.lastPayment, { day: today(), amountUsdCents: 5_000 }, "his last payment is his last payment, whatever is shown");

  assert.equal((await s.get(`/v1/customers/${customer}/statement?from=yesterday`)).status, 400);
  assert.equal((await s.get(`/v1/customers/${customer}/statement?corrections=maybe`)).status, 400);
  assert.equal((await s.get(`/v1/customers/${randomUUID()}/statement`)).status, 404);
  assert.equal((await s.get(`/v1/customers/${customer}/statement`, ownerCookie)).status, 200);
});

test("a payment taken back is left off with its reversal, unless corrections are asked for", async () => {
  const customer = await s.customer();
  await s.file([[customer, 20_000]]);
  await pay(customer, 5_000);
  const wrong = await pay(customer, 15_000);
  assert.equal((await s.send("POST", `/v1/entries/${wrong.body.entryId}/reverse`, { reason: "typed 150 for 50" })).status, 201);

  const clean: Statement = (await s.get(`/v1/customers/${customer}/statement`)).body;
  assert.deepEqual(clean.lines.map((l) => [l.kind, l.changeUsdCents, l.balanceAfterUsdCents]), [["charge", 20_000, 20_000], ["payment", -5_000, 15_000]]);
  assert.deepEqual(clean.lastPayment, { day: today(), amountUsdCents: 5_000 });

  const full: Statement = (await s.get(`/v1/customers/${customer}/statement?corrections=true`)).body;
  assert.deepEqual(
    full.lines.map((l) => [l.kind, l.isReversal, l.isCorrection, l.changeUsdCents, l.balanceAfterUsdCents]),
    [["charge", false, false, 20_000, 20_000], ["payment", false, false, -5_000, 15_000], ["payment", false, true, -15_000, 0], ["payment", true, true, 15_000, 15_000]],
  );
  assert.equal(full.lines[3]?.note, "typed 150 for 50");
  assert.deepEqual(full.lastPayment, { day: today(), amountUsdCents: 5_000 }, "a payment that was taken back is not his last payment");
  assert.equal(clean.balanceUsdCents, 15_000);
  assert.equal(full.balanceUsdCents, 15_000);

  // The copy to send never shows a correction.
  const made = await exportFor(customer);
  assert.match(made.body.text, /Last payment received: \$50\.00 on /);
  const { rows } = await h.owner.query("select jsonb_array_length(snapshot -> 'lines') as lines from statements where id = $1", [made.body.id]);
  assert.equal(rows[0].lines, 2);
});

test("the copy to send says what the screen says, as a text, an image and a PDF", async () => {
  const name = unique("REBWAR ");
  const customer = await s.customer(name, { trusted: true, limitUsdCents: 100_000 });
  const first = await s.file([[customer, 46_000]]);
  await pay(customer, 30_000, "USD", "fib");
  const second = await s.file([[customer, 31_000]]);

  const id = randomUUID();
  const key = randomUUID();
  const made = await exportFor(customer, id, {}, key);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(
    [made.body.id, made.body.customerId, made.body.customerName, made.body.from, made.body.balanceUsdCents, made.body.createdByName, made.body.sentAt, made.body.sentByName],
    [id, customer, name, null, 47_000, "Sarkar", null, null],
  );
  assert.deepEqual([made.body.imageUrl, made.body.pdfUrl], [`/v1/statements/${id}/image`, `/v1/statements/${id}/pdf`]);
  assert.equal(
    made.body.text,
    [
      "Green Star",
      `Statement for ${name}, ${dayText()}`,
      "",
      "You owe $470.00.",
      "",
      "Not paid in full:",
      `- ${first.code}, ${dayText()}: $460.00, paid $300.00, left $160.00`,
      `- ${second.code}, ${dayText()}: $310.00, left $310.00`,
      "",
      `Last payment received: $300.00 on ${dayText()}.`,
    ].join("\n"),
  );

  // The same click again is the same copy.
  const again = await exportFor(customer, id, {}, key);
  assert.equal(again.headers["idempotent-replay"], "true");
  assert.deepEqual(again.body, made.body);
  assert.deepEqual((await s.get(`/v1/statements/${id}`)).body, made.body);

  const image = await bytes(h, `/v1/statements/${id}/image`);
  assert.equal(image.status, 200);
  assert.equal(image.type, "image/png");
  assert.deepEqual([...image.body.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "a PNG");
  assert.equal(image.body.readUInt32BE(16), 1520, "760 wide, drawn at twice the size so it stays sharp on a phone");
  assert.ok(image.body.readUInt32BE(20) > 900, "as tall as the statement needs");
  assert.ok(image.body.length > 20_000, `only ${image.body.length} bytes`);

  const pdf = await bytes(h, `/v1/statements/${id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.type, "application/pdf");
  assert.equal(pdf.body.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(pdf.body.length > 5_000);

  // He pays. The copy that was made stays as it was made; a new one says the new balance.
  await pay(customer, 7_000);
  const sameId = await exportFor(customer, id);
  assert.equal(sameId.status, 201);
  assert.equal(sameId.body.balanceUsdCents, 47_000);
  assert.equal(sameId.body.text, made.body.text);
  const fresh = await exportFor(customer);
  assert.equal(fresh.body.balanceUsdCents, 40_000);
  assert.match(fresh.body.text, /You owe \$400\.00\./);
  assert.match(fresh.body.text, /Last payment received: \$70\.00 on /);

  const list = await s.get(`/v1/customers/${customer}/statements`);
  assert.deepEqual(list.body.items.map((x: { id: string }) => x.id), [fresh.body.id, id], "newest first");

  // What is refused.
  assert.equal((await exportFor(customer, "not-an-id")).status, 400);
  assert.equal((await exportFor(customer, randomUUID(), { from: "soon" })).status, 400);
  assert.equal((await exportFor(customer, randomUUID(), { balanceUsdCents: 0 })).status, 400, "the balance is never taken from the request");
  assert.equal((await exportFor(randomUUID())).status, 404);
  const other = await s.customer();
  const reused = await exportFor(other, id);
  assert.equal(reused.status, 422);
  assert.equal(reused.body.code, "statement_id_reused");
  assert.equal((await bytes(h, `/v1/statements/${randomUUID()}/image`)).status, 404);
  assert.equal((await bytes(h, `/v1/statements/${randomUUID()}/pdf`)).status, 404);
  await s.sound();
});

test("a customer with nothing to pay, and one in credit, are told so", async () => {
  const paidUp = await s.customer(unique("PAID UP "));
  await s.file([[paidUp, 5_000]]);
  await pay(paidUp, 5_000);
  const clear = await exportFor(paidUp);
  assert.equal(clear.body.balanceUsdCents, 0);
  assert.match(clear.body.text, /\n\nYou owe nothing\. Thank you\.\n\nLast payment received: \$50\.00 on /);
  assert.doesNotMatch(clear.body.text, /Not paid in full/);

  const ahead = await s.customer(unique("AHEAD "));
  await pay(ahead, 2_500);
  const credit = await exportFor(ahead);
  assert.equal(credit.body.balanceUsdCents, -2_500);
  assert.match(credit.body.text, /\n\nYou are \$25\.00 in credit\.\n/);
  assert.equal((await bytes(h, credit.body.imageUrl)).status, 200);

  const nothing = await s.customer(unique("NEW "));
  const empty = await exportFor(nothing);
  assert.equal(empty.status, 201);
  assert.match(empty.body.text, /You owe nothing\. Thank you\.$/);
  assert.equal((await bytes(h, empty.body.imageUrl)).status, 200);
});

test("what was typed as a name is drawn as text, never as markup, and Kurdish names are kept as written", async () => {
  const typed = `<img src=x onerror="alert(1)"> & 'Sons'`;
  const customer = await s.customer(typed);
  await s.file([[customer, 1_000]]);
  const st: Statement = (await s.get(`/v1/customers/${customer}/statement`)).body;
  const html = statementHtml(st);
  assert.ok(!html.includes("<img"), "no tag that was typed is in the page");
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;Sons&#39;"));
  assert.ok(!/<script/i.test(html) && !/https?:\/\//.test(html), "the page runs nothing and fetches nothing");
  assert.equal(statementText(st).split("\n")[1], `Statement for ${typed}, ${dayText()}`);
  const made = await exportFor(customer);
  assert.equal((await bytes(h, made.body.imageUrl)).status, 200);

  const kurdish = "دارا محەمەد ڕەئوف";
  const second = await s.customer(kurdish);
  await s.file([[second, 2_000]]);
  const copy = await exportFor(second);
  assert.equal(copy.body.customerName, kurdish);
  assert.equal(copy.body.text.split("\n")[1], `Statement for ${kurdish}, ${dayText()}`);
  const page = statementHtml((await s.get(`/v1/customers/${second}/statement`)).body);
  assert.ok(page.includes(`<div class="name" dir="auto">${kurdish}</div>`));
  assert.ok(page.includes('font-family:"Noto Sans Arabic"'), "the font for Kurdish and Arabic letters is inside the page");
  assert.equal((await bytes(h, copy.body.imageUrl)).status, 200);
});

test("a long account: the copy to send shows the latest 40 lines and sums the rest into one", async () => {
  const customer = await s.customer();
  await s.file([[customer, 100_000]]);
  for (let i = 0; i < 44; i += 1) assert.equal((await pay(customer, 100)).status, 201);

  const screen: Statement = (await s.get(`/v1/customers/${customer}/statement`)).body;
  assert.equal(screen.lines.length, 45, "the screen shows every line");
  assert.equal(screen.openingBalanceUsdCents, 0);

  const made = await exportFor(customer);
  const { rows } = await h.owner.query(
    "select jsonb_array_length(snapshot -> 'lines') as lines, (snapshot ->> 'openingBalanceUsdCents')::int as opening, (snapshot ->> 'balanceUsdCents')::int as balance, snapshot -> 'lines' -> 0 ->> 'balanceAfterUsdCents' as first from statements where id = $1",
    [made.body.id],
  );
  // 45 lines: the charge and the first 4 payments are summed into "balance before".
  assert.deepEqual(rows[0], { lines: 40, opening: 99_600, balance: 95_600, first: "99500" });
  const html = statementHtml((await h.owner.query("select snapshot from statements where id = $1", [made.body.id])).rows[0].snapshot);
  assert.ok(html.includes("Balance before"));
  assert.ok(html.includes("$996.00"));
  assert.equal((await bytes(h, made.body.imageUrl)).status, 200);
});

test("the owner reads statements and the copies made, and makes none", async () => {
  const customer = await s.customer();
  await s.file([[customer, 3_000]]);
  const made = await exportFor(customer);

  assert.equal((await s.get(`/v1/customers/${customer}/statement`, ownerCookie)).status, 200);
  assert.equal((await s.get(`/v1/customers/${customer}/statements`, ownerCookie)).body.items.length, 1);
  assert.equal((await s.get(`/v1/statements/${made.body.id}`, ownerCookie)).status, 200);
  assert.equal((await bytes(h, made.body.imageUrl, ownerCookie)).status, 200);
  assert.equal((await s.get("/v1/statements", ownerCookie)).status, 200);

  const refused = await call(h.app, "POST", `/v1/customers/${customer}/statement/export`, { cookie: ownerCookie, body: { id: randomUUID() } });
  assert.equal(refused.status, 403);
  assert.equal((await call(h.app, "POST", `/v1/statements/${made.body.id}/sent`, { cookie: ownerCookie, body: {} })).status, 403);
  assert.equal((await s.get(`/v1/statements/${made.body.id}`)).body.sentAt, null);
  // Nobody who is not signed in reads a statement or its image.
  assert.equal((await call(h.app, "GET", made.body.imageUrl)).status, 401);
  assert.equal((await call(h.app, "GET", `/v1/customers/${customer}/statement`)).status, 401);
});

test("who to send a statement to: trusted customers who owe, until one was sent this week", async () => {
  const name = unique("TRUSTED ");
  const trusted = await s.customer(name, { trusted: true, limitUsdCents: 10_000, phones: ["0770 555 2002"] });
  await s.file([[trusted, 25_000]]);
  const payFirst = await s.customer();
  await s.file([[payFirst, 4_000]]);
  const paidUp = await s.customer(undefined, { trusted: true });
  await s.file([[paidUp, 1_000]]);
  await pay(paidUp, 1_000);

  const listed = async (customerId: string) => (await s.get("/v1/statements")).body.items.find((x: { customerId: string }) => x.customerId === customerId);
  assert.deepEqual(await listed(trusted), {
    customerId: trusted, customerName: name, phone: "+9647705552002", balanceUsdCents: 25_000, creditLimitUsdCents: 10_000, overLimit: true,
    lastStatementId: null, lastSentAt: null, lastSentBalanceUsdCents: null, due: true,
  });
  assert.equal(await listed(payFirst), undefined);
  assert.equal(await listed(paidUp), undefined);

  // Made, but not sent: he is still due one.
  const made = await exportFor(trusted);
  assert.equal((await listed(trusted)).due, true);

  const sent = await s.send("POST", `/v1/statements/${made.body.id}/sent`, {});
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.sentByName, "Sarkar");
  assert.ok(!Number.isNaN(Date.parse(sent.body.sentAt)));
  const after = await listed(trusted);
  assert.deepEqual([after.due, after.lastStatementId, after.lastSentAt, after.lastSentBalanceUsdCents], [false, made.body.id, sent.body.sentAt, 25_000]);

  // Marked again, it stays as it was.
  const again = await s.send("POST", `/v1/statements/${made.body.id}/sent`, {});
  assert.equal(again.status, 200);
  assert.equal(again.body.sentAt, sent.body.sentAt);
  const missing = await s.send("POST", `/v1/statements/${randomUUID()}/sent`, {});
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "statement_not_found");

  // Those who are due come first.
  const items = (await s.get("/v1/statements")).body.items as { due: boolean }[];
  const firstNotDue = items.findIndex((x) => !x.due);
  assert.ok(firstNotDue === -1 || items.slice(firstNotDue).every((x) => !x.due));
});

test("without Chromium the text is still made, and the image says why it cannot be drawn", async () => {
  const other = await start({ chromiumPath: "/nowhere/chromium" });
  try {
    const cookie = await signIn(other, ceo);
    const customer = await s.customer();
    await s.file([[customer, 6_000]]);
    const made = await call(other.app, "POST", `/v1/customers/${customer}/statement/export`, { cookie, body: { id: randomUUID() } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.match(made.body.text, /You owe \$60\.00\./);

    for (const url of [made.body.imageUrl, made.body.pdfUrl]) {
      const drawn = await bytes(other, url, cookie);
      assert.equal(drawn.status, 503);
      assert.equal(drawn.json().code, "renderer_missing");
      assert.match(drawn.json().message, /Chromium is not installed/);
    }
    // Asked again, it answers again: a failed start is not remembered as the browser.
    assert.equal((await bytes(other, made.body.imageUrl, cookie)).status, 503);
  } finally {
    await other.close();
  }
});

test("the books are still sound, and the checks never failed", async () => {
  assert.equal(h.app.ctx.checks.failed, 0, String(h.app.ctx.checks.lastError));
  await s.sound();
});
