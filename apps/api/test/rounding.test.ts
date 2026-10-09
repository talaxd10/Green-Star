// The CEO's rules for mixed payments, over the real routes against a real
// Postgres: paying in parts, dinar rounding, and the Error entry.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { call, seedUser, signIn, start } from "./helpers.ts";
import { RATE, result, Scene } from "./scene.ts";

const h = await start();
after(() => h.close());

const ceo = await seedUser(h, "Sarkar");
const s = new Scene(h, await signIn(h, ceo));
await s.rate();                       // 1,450 dinars per dollar
assert.equal(RATE, 145_000);

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const usd = (amount: number) => ({ amount, currency: "USD" as const });
const iqd = (amount: number) => ({ amount, currency: "IQD" as const });
const cash = (received: { amount: number; currency: "USD" | "IQD" }) => ({ received, method: "office_cash" });

interface PaymentRow {
  method: string;
  receivedAmount: number;
  receivedCurrency: string;
  creditedUsdCents: number;
  [key: string]: unknown;
}
const brief = (payments: PaymentRow[]) => payments.map((p) => `${p.method}:${p.receivedAmount}:${p.receivedCurrency}:${p.creditedUsdCents}`).join(" ");
const paymentsOf = async (customerId: string): Promise<PaymentRow[]> => (await s.get(`/v1/payments?customerId=${customerId}`)).body.items;
const settings = async () => (await s.get("/v1/settings")).body;

test("the CEO's example: $400 in dollars and the rest in dinars, rounded, pay the $533 he owes", async () => {
  const a = await s.customer();
  await s.file([[a, 53_300]]);
  const before = { rounding: await s.account("dinar_rounding_usd"), usd: await s.account("vault_usd"), iqd: await s.account("vault_iqd") };

  // $133 x 1,450 = 192,850. He hands over 193,000. Typed dinars first: dollars are applied first anyway.
  const key = randomUUID();
  const body = { customerId: a, parts: [cash(iqd(193_000)), cash(usd(40_000))], note: "Came in with his brother" };
  const paid = await s.send("POST", "/v1/payments/parts", body, key);
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  assert.equal(brief(paid.body.payments), "office_cash:40000:USD:40000 office_cash:193000:IQD:13300");
  assert.deepEqual(paid.body.payments.map((p: PaymentRow) => [p.iqdPer100Usd, p.note, p.customerId]), [
    [null, "Came in with his brother", a],
    [RATE, "Came in with his brother", a],
  ]);

  assert.equal(await s.balance(a), 0);
  assert.equal((await s.account("vault_usd")) - before.usd, 40_000);
  assert.equal((await s.account("vault_iqd")) - before.iqd, 193_000, "every dinar he handed over is in the vault");
  assert.equal((await s.account("dinar_rounding_usd")) - before.rounding, -10, "193,000 is $133.10: rounding gave 10 cents");

  // Save clicked twice: the same answer, and nothing more is posted.
  const again = await s.send("POST", "/v1/payments/parts", body, key);
  assert.equal(again.status, 201);
  assert.deepEqual(again.body, paid.body);
  assert.equal((await paymentsOf(a)).length, 2);
  assert.equal((await s.account("vault_iqd")) - before.iqd, 193_000);

  // Each part is its own line on his statement.
  const statement = (await s.get(`/v1/customers/${a}/statement`)).body;
  assert.deepEqual(statement.lines.map((l: { kind: string; changeUsdCents: number; balanceAfterUsdCents: number }) => [l.kind, l.changeUsdCents, l.balanceAfterUsdCents]), [
    ["charge", 53_300, 53_300],
    ["payment", -40_000, 13_300],
    ["payment", -13_300, 0],
  ]);
  await s.sound();
});

test("one payment in dinars: what comes to what he owes settles it, a part payment and an overpayment are exact", async () => {
  // $62.00 at 1,450 is 89,900 IQD.
  const settled = await s.customer();
  await s.file([[settled, 6_200]]);
  const paid = await s.send("POST", "/v1/payments", { customerId: settled, received: iqd(90_000), method: "office_cash" });
  assert.equal(paid.status, 201);
  assert.equal(paid.body.creditedUsdCents, 6_200, "90,000 is $62.07, and settles $62.00");
  assert.equal(await s.balance(settled), 0);

  const short = await s.customer();
  await s.file([[short, 6_200]]);
  assert.equal((await s.send("POST", "/v1/payments", { customerId: short, received: iqd(89_400), method: "fib" })).body.creditedUsdCents, 6_200, "500 dinars short still settles it");
  assert.equal(await s.balance(short), 0);

  const part = await s.customer();
  await s.file([[part, 6_200]]);
  assert.equal((await s.send("POST", "/v1/payments", { customerId: part, received: iqd(50_000), method: "office_cash" })).body.creditedUsdCents, 3_448);
  assert.equal(await s.balance(part), 2_752);
  // 501 dinars short of the rest is not settled.
  assert.equal((await s.send("POST", "/v1/payments", { customerId: part, received: iqd(39_403), method: "office_cash" })).body.creditedUsdCents, 2_717);
  assert.equal(await s.balance(part), 35);

  const over = await s.customer();
  await s.file([[over, 6_200]]);
  assert.equal((await s.send("POST", "/v1/payments", { customerId: over, received: iqd(100_000), method: "office_cash" })).body.creditedUsdCents, 6_897);
  assert.equal(await s.balance(over), -697, "what is over is his credit, to the cent");

  // Dollars are never rounded: ten cents short is ten cents owed.
  const dollars = await s.customer();
  await s.file([[dollars, 6_200]]);
  await s.send("POST", "/v1/payments", { customerId: dollars, received: usd(6_190), method: "office_cash" });
  assert.equal(await s.balance(dollars), 10);
  await s.sound();
});

test("dinars paid for one consignment settle that one; paid for nothing in particular they settle only everything", async () => {
  const a = await s.customer();
  await s.file([[a, 5_000]]);
  const newest = await s.file([[a, 6_200]]);

  // 90,000 is not what he owes in all ($112.00 is 162,400), so with no consignment named it is exact and goes to the oldest.
  const plain = await s.send("POST", "/v1/payments", { customerId: a, received: iqd(90_000), method: "office_cash" });
  assert.equal(plain.body.creditedUsdCents, 6_207);
  assert.equal(await s.balance(a), 4_993);
  await s.send("POST", `/v1/entries/${plain.body.entryId}/reverse`, { reason: "It was for the new file" });
  assert.equal(await s.balance(a), 11_200);

  const forIt = await s.send("POST", "/v1/payments", { customerId: a, received: iqd(90_000), method: "office_cash", forConsignmentId: newest.by[a] });
  assert.equal(forIt.body.creditedUsdCents, 6_200);
  assert.equal(forIt.body.paidForConsignmentId, newest.by[a]);
  assert.equal(await s.balance(a), 5_000);
  const rows = (await s.get(`/v1/consignments?customerId=${a}`)).body.items;
  assert.deepEqual(rows.map((c: { amountDueUsdCents: number; remainingUsdCents: number }) => [c.amountDueUsdCents, c.remainingUsdCents]).sort(), [[5_000, 5_000], [6_200, 0]]);

  // In parts, for that consignment too: dollars first, then the dinars settle what is left of everything.
  const both = await s.send("POST", "/v1/payments/parts", { customerId: a, parts: [cash(usd(2_000)), { received: iqd(43_500), method: "zaincash" }] });
  assert.equal(brief(both.body.payments), "office_cash:2000:USD:2000 zaincash:43500:IQD:3000");
  assert.equal(await s.balance(a), 0);

  // 30 cents left from an older file and $62.00 on the new one: 90,300 dinars ($62.28) is nearer to
  // everything he owes (90,335) than to the new file alone (89,900), so it settles everything.
  const b = await s.customer();
  await s.file([[b, 30]]);
  const latest = await s.file([[b, 6_200]]);
  const all = await s.send("POST", "/v1/payments", { customerId: b, received: iqd(90_300), method: "office_cash", forConsignmentId: latest.by[b] });
  assert.equal(all.body.creditedUsdCents, 6_230);
  assert.equal(await s.balance(b), 0);
  // 89,950 is nearer to the new file alone: that is settled, and the 30 cents stay owed.
  const c = await s.customer();
  await s.file([[c, 30]]);
  const newer = await s.file([[c, 6_200]]);
  const one = await s.send("POST", "/v1/payments", { customerId: c, received: iqd(89_950), method: "office_cash", forConsignmentId: newer.by[c] });
  assert.equal(one.body.creditedUsdCents, 6_200);
  assert.equal(await s.balance(c), 30);
  await s.sound();
});

test("a payment in parts is checked before anything is saved, and saved whole or not at all", async () => {
  const a = await s.customer();
  const file = await s.file([[a, 53_300]]);
  const other = await s.customer();
  const otherFile = await s.file([[other, 1_000]]);
  const good = { customerId: a, parts: [cash(usd(40_000)), cash(iqd(193_000))] };

  const cases: [Record<string, unknown>, string][] = [
    [{ ...good, parts: [cash(usd(40_000))] }, "parts"],                                                    // one payment has its own address
    [{ ...good, parts: [] }, "parts"],
    [{ ...good, parts: [cash(usd(1)), cash(iqd(1_000)), { received: usd(1), method: "fib" }, { received: iqd(1_000), method: "fib" }, { received: usd(1), method: "zaincash" }] }, "parts"],
    [{ ...good, parts: [cash(usd(40_000)), cash(usd(13_300))] }, "parts"],                                 // twice the same way
    [{ ...good, parts: [cash(usd(40_000)), { received: iqd(193_000), method: "driver_cash" }] }, "parts.1.method"],
    [{ ...good, parts: [cash(usd(40_000)), cash(iqd(0))] }, "parts.1.received.amount"],
    [{ ...good, parts: [cash(usd(40_000)), cash(iqd(1_000.5))] }, "parts.1.received.amount"],
    [{ ...good, parts: [cash(usd(40_000)), { received: { amount: 5, currency: "EUR" }, method: "office_cash" }] }, "parts.1.received.currency"],
    [{ ...good, creditedUsdCents: 53_300 }, "_"],                                                         // what it is worth is never taken from the request
    [{ parts: good.parts }, "customerId"],
  ];
  for (const [body, field] of cases) {
    const reply = await s.send("POST", "/v1/payments/parts", body);
    assert.equal(reply.status, 400, JSON.stringify(body));
    assert.ok(field in reply.body.fields, `${JSON.stringify(body)} should name ${field}: ${JSON.stringify(reply.body.fields)}`);
  }
  assert.equal((await s.send("POST", "/v1/payments/parts", { ...good, customerId: randomUUID() })).status, 404);

  // The dollars are fine and the dinars are not: a day with no rate. Neither is saved.
  const noRate = await s.send("POST", "/v1/payments/parts", { ...good, happenedAt: daysAgo(1300) });
  assert.equal(noRate.status, 422);
  assert.equal(noRate.body.code, "rate_missing");
  // For a consignment that is not his.
  const wrong = await s.send("POST", "/v1/payments/parts", { ...good, forConsignmentId: otherFile.by[other] });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.code, "target_invalid");
  // Not signed in.
  assert.equal((await call(h.app, "POST", "/v1/payments/parts", { body: good })).status, 401);

  assert.deepEqual(await paymentsOf(a), [], "nothing was saved by any of them");
  assert.equal(await s.balance(a), 53_300);

  const saved = await s.send("POST", "/v1/payments/parts", { ...good, forConsignmentId: file.by[a] });
  assert.equal(saved.status, 201);
  assert.equal(await s.balance(a), 0);
  await s.sound();
});

test("the rounding step is in Settings, and changing it changes what is taken", async () => {
  const start = await settings();
  assert.equal(start.dinarRoundingIqd, 1_000);
  assert.equal("errorMaxUsdCents" in start, false, "there is no Error limit any more");
  for (const bad of [{ dinarRoundingIqd: -1 }, { dinarRoundingIqd: 10_001 }, { dinarRoundingIqd: 250.5 }, { errorMaxUsdCents: 500 }, { dinarRoundingIqd: "1000" }]) {
    assert.equal((await s.send("PUT", "/v1/settings", bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(await settings(), start, "nothing changed");

  // $61.90 at 1,450 is 89,755 IQD. He hands over 90,000: 245 dinars over.
  const owing = async () => {
    const customer = await s.customer();
    await s.file([[customer, 6_190]]);
    return customer;
  };
  const pay = async (customer: string) => (await s.send("POST", "/v1/payments", { customerId: customer, received: iqd(90_000), method: "office_cash" })).body.creditedUsdCents;
  try {
    assert.equal(await pay(await owing()), 6_190, "to the nearest 1,000 it settles");

    const quarter = await s.send("PUT", "/v1/settings", { dinarRoundingIqd: 250 });
    assert.equal(quarter.status, 200);
    assert.deepEqual([quarter.body.dinarRoundingIqd, quarter.body.heldInCarDays], [250, start.heldInCarDays], "only what is sent changes");
    assert.equal(await pay(await owing()), 6_207, "to the nearest 250 it does not: he is 17 cents in credit");

    await s.send("PUT", "/v1/settings", { dinarRoundingIqd: 0 });
    const exact = await owing();
    assert.equal(await pay(exact), 6_207, "switched off, a payment is worth what it converts to");
    assert.equal(await s.balance(exact), -17);
  } finally {
    await s.send("PUT", "/v1/settings", { dinarRoundingIqd: 1_000 });
  }
  const log = await h.owner.query("select actor, before ->> 'dinar_rounding_iqd' as was, after ->> 'dinar_rounding_iqd' as is from audit_log where entity = 'settings' order by id desc limit 1");
  assert.deepEqual(log.rows[0], { actor: ceo.id, was: "0", is: "1000" });
  assert.equal((await settings()).dinarRoundingIqd, 1_000);
});

test("an Error entry takes an amount off what he owes, shows on his account, and is reversed like any entry", async () => {
  const name = "ERROR PAYER " + randomUUID().slice(0, 6).toUpperCase();
  const a = await s.customer(name);
  const file = await s.file([[a, 53_300]]);
  await s.send("POST", "/v1/payments", { customerId: a, received: usd(52_800), method: "office_cash" });
  assert.equal(await s.balance(a), 500);
  const before = { errors: await s.account("errors_usd"), usd: await s.account("vault_usd") };

  const key = randomUUID();
  const made = await s.send("POST", "/v1/errors", { customerId: a, amountUsdCents: 500, note: "  Short at the door, let go " }, key);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(
    [made.body.customerId, made.body.customerName, made.body.amountUsdCents, made.body.added, made.body.consignmentId, made.body.note, made.body.reversed],
    [a, name, 500, false, null, "Short at the door, let go", false],
  );
  assert.ok(!Number.isNaN(Date.parse(made.body.happenedAt)) && !Number.isNaN(Date.parse(made.body.createdAt)));
  assert.deepEqual((await s.send("POST", "/v1/errors", { customerId: a, amountUsdCents: 500, note: "  Short at the door, let go " }, key)).body, made.body, "the same click again is the same entry");

  assert.equal(await s.balance(a), 0);
  assert.equal((await s.account("errors_usd")) - before.errors, 500, "what was let go is on the Errors account");
  assert.equal(await s.account("vault_usd"), before.usd, "no money moved");
  // His file is paid, the way a payment would have paid it.
  const shipment = (await s.get(`/v1/shipments/${file.id}`)).body;
  assert.deepEqual(shipment.consignmentList.map((c: { remainingUsdCents: number }) => c.remainingUsdCents), [0]);

  // It is listed with the errors, not with the money that came in.
  const listed = (await s.get(`/v1/errors?customerId=${a}`)).body.items;
  assert.deepEqual(listed, [made.body]);
  assert.equal((await paymentsOf(a)).length, 1);
  assert.ok((await s.get("/v1/errors?limit=1")).body.items.length === 1);

  // His statement shows it as its own line, and the last payment is still the money he paid.
  const statement = (await s.get(`/v1/customers/${a}/statement`)).body;
  assert.deepEqual(statement.lines.map((l: { kind: string; changeUsdCents: number; method: string | null; note: string | null }) => [l.kind, l.changeUsdCents, l.method, l.note]), [
    ["charge", 53_300, null, null],
    ["payment", -52_800, "office_cash", null],
    ["correction", -500, null, "Short at the door, let go"],
  ]);
  assert.deepEqual([statement.balanceUsdCents, statement.paidUsdCents, statement.lastPayment.amountUsdCents], [0, 53_300, 52_800]);
  const copy = await s.send("POST", `/v1/customers/${a}/statement/export`, { id: randomUUID() });
  assert.equal(copy.status, 201);
  assert.match(copy.body.text, /You owe nothing/);
  assert.match(copy.body.text, /Last payment received: \$528\.00/);

  // The ledger shows the entry with its two lines.
  const entry = (await s.get(`/v1/entries/${made.body.entryId}`)).body;
  assert.equal(entry.kind, "error_correction");
  assert.deepEqual(entry.lines.map((l: { accountCode: string | null; accountKind: string; amount: number }) => [l.accountCode, l.accountKind, l.amount]).sort(), [["errors_usd", "adjustment", 500], [null, "customer", -500]].sort());
  assert.equal((await s.get(`/v1/ledger?kind=error_correction&customerId=${a}`)).body.items.length, 1);

  // Taken back: he owes the $5 again.
  const reversed = await s.send("POST", `/v1/entries/${made.body.entryId}/reverse`, { reason: "He paid it after all" });
  assert.equal(reversed.status, 201);
  assert.equal(await s.balance(a), 500);
  assert.equal(await s.account("errors_usd"), before.errors);
  assert.equal((await s.get(`/v1/errors?customerId=${a}`)).body.items[0].reversed, true);
  await s.sound();
});

test("an Error entry has no limit, is at most what he owes, and never changes what was asked into something else", async () => {
  const a = await s.customer();
  await s.file([[a, 100_000]]);

  // $900 at once: there is no limit.
  assert.equal((await s.send("POST", "/v1/errors", { customerId: a, amountUsdCents: 90_000 })).status, 201);
  assert.equal(await s.balance(a), 10_000);

  for (const [body, field] of [
    [{ customerId: a, amountUsdCents: 0 }, "amountUsdCents"],
    [{ customerId: a, amountUsdCents: -100 }, "amountUsdCents"],
    [{ customerId: a, amountUsdCents: 99.5 }, "amountUsdCents"],
    [{ customerId: a }, "amountUsdCents"],
    [{ amountUsdCents: 100 }, "customerId"],
    [{ customerId: a, amountUsdCents: 100, direction: "owes_more" }, "_"],
    [{ customerId: a, amountUsdCents: 100, add: true }, "consignmentId"],
    [{ customerId: a, amountUsdCents: 100, add: "yes" }, "add"],
  ] as const) {
    const reply = await s.send("POST", "/v1/errors", body);
    assert.equal(reply.status, 400, JSON.stringify(body));
    assert.ok(field in reply.body.fields, JSON.stringify(reply.body));
  }
  assert.equal((await s.send("POST", "/v1/errors", { customerId: randomUUID(), amountUsdCents: 100 })).status, 404);
  assert.equal((await call(h.app, "POST", "/v1/errors", { body: { customerId: a, amountUsdCents: 100 } })).status, 401);
  assert.equal((await call(h.app, "GET", "/v1/errors")).status, 401);
  assert.equal(await s.balance(a), 10_000);

  assert.equal((await s.send("POST", "/v1/errors", { customerId: a, amountUsdCents: 9_900 })).status, 201);
  const more = await s.send("POST", "/v1/errors", { customerId: a, amountUsdCents: 200 });
  assert.equal(more.status, 422);
  assert.equal(more.body.code, "error_more_than_owed");
  assert.match(more.body.message, /he owes \$1\.00/);
  assert.equal(await s.balance(a), 100);
  await s.sound();
});

test("an Error entry adds to what he owes, onto the consignment picked, and is reversed like any entry", async () => {
  const a = await s.customer();
  const b = await s.customer();
  const file = await s.file([[a, 20_000], [b, 5_000]]);
  const mine = file.by[a] as string;
  const before = await s.account("errors_usd");

  const added = await s.send("POST", "/v1/errors", { customerId: a, amountUsdCents: 1_250, add: true, consignmentId: mine, note: "One carton was not on the file" });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.deepEqual([added.body.amountUsdCents, added.body.added, added.body.consignmentId], [1_250, true, mine]);
  assert.equal(await s.balance(a), 21_250);
  assert.equal((await s.account("errors_usd")) - before, -1_250);
  const consignment = (await s.get(`/v1/consignments?customerId=${a}`)).body.items[0];
  assert.deepEqual([consignment.remainingUsdCents, consignment.errorsAddedUsdCents], [21_250, 1_250]);

  // Someone else's consignment is refused.
  const wrong = await s.send("POST", "/v1/errors", { customerId: a, amountUsdCents: 100, add: true, consignmentId: file.by[b] });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.code, "target_invalid");

  // His statement shows it as a correction that adds.
  const statement = (await s.get(`/v1/customers/${a}/statement`)).body;
  assert.deepEqual(statement.lines.map((l: { kind: string; changeUsdCents: number }) => [l.kind, l.changeUsdCents]), [["charge", 20_000], ["correction", 1_250]]);

  // A consignment with an Error added is not cancelled on its own.
  const cancel = await s.send("POST", `/v1/consignments/${mine}/cancel`, { reason: "Wrong customer" });
  assert.equal(cancel.status, 422);
  assert.equal(cancel.body.code, "consignment_has_error");

  assert.equal((await s.send("POST", `/v1/entries/${added.body.entryId}/reverse`, { reason: "Was on the file after all" })).status, 201);
  assert.equal(await s.balance(a), 20_000);
  assert.equal((await s.get(`/v1/errors?customerId=${a}`)).body.items[0].reversed, true);
  await s.sound();
});

test("a stop on a round is paid in parts: the driver holds the cash of each currency, a wallet part is not his", async () => {
  const a = await s.customer();
  const b = await s.customer();
  const file = await s.file([[a, 53_300], [b, 53_300]]);
  const round = await s.roundOut([file.by[a] as string, file.by[b] as string]);
  const fib = await s.account("wallet_fib_iqd");

  const saved = await s.send("PUT", `/v1/rounds/${round}/results`, {
    results: [
      // $400 and the rest in dinars, both to the driver.
      { ...result(file.by[a] as string, "paid", iqd(193_000)), more: [{ received: usd(40_000), method: "driver_cash" }] },
      // $400 to the driver and the rest by FIB.
      { ...result(file.by[b] as string, "paid", usd(40_000)), more: [{ received: iqd(193_000), method: "fib" }] },
    ],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const stops = saved.body.stopList as { consignmentId: string; payments: PaymentRow[]; creditedUsdCents: number; receivedCurrency: string; remainingUsdCents: number }[];
  const stopOf = (consignmentId: string) => stops.find((stop) => stop.consignmentId === consignmentId)!;
  assert.equal(brief(stopOf(file.by[a] as string).payments), "driver_cash:40000:USD:40000 driver_cash:193000:IQD:13300");
  assert.equal(brief(stopOf(file.by[b] as string).payments), "driver_cash:40000:USD:40000 fib:193000:IQD:13300");
  assert.deepEqual(stops.map((stop) => [stop.remainingUsdCents, stop.creditedUsdCents, stop.receivedCurrency]), [[0, 40_000, "USD"], [0, 40_000, "USD"]]);
  assert.deepEqual([await s.balance(a), await s.balance(b)], [0, 0]);
  assert.equal(saved.body.missedCollections, 0);

  // The driver hands in his dollars and his dinars. The FIB money is not his to hand in.
  assert.deepEqual(saved.body.cash.map((c: { currency: string; collected: number }) => [c.currency, c.collected]).sort(), [["IQD", 193_000], ["USD", 80_000]]);
  assert.deepEqual([saved.body.collectedUsdCents, saved.body.collectedIqd], [80_000, 193_000]);
  assert.equal((await s.account("wallet_fib_iqd")) - fib, 193_000);
  // The payments list says which round each part was taken on, the wallet part too.
  assert.deepEqual((await paymentsOf(b)).map((p) => [p.method, p.roundId]).sort(), [["driver_cash", round], ["fib", round]]);

  const handed = await s.send("POST", `/v1/rounds/${round}/hand-in`, { id: randomUUID(), happenedAt: new Date().toISOString(), usdNotes: { 10000: 8 }, iqdNotes: { 50000: 3, 25000: 1, 10000: 1, 5000: 1, 1000: 3 } });
  assert.equal(handed.status, 201, JSON.stringify(handed.body));
  assert.deepEqual([handed.body.gapUsdCents, handed.body.gapIqd], [0, 0]);
  assert.equal((await s.get(`/v1/shipments/${file.id}`)).body.status, "closed");
  await s.sound();
});

test("the parts of a stop are checked before anything is saved, and taking the result back reverses every part", async () => {
  const a = await s.customer();
  const file = await s.file([[a, 53_300]]);
  const consignment = file.by[a] as string;
  const round = await s.roundOut([consignment]);

  const good = result(consignment, "paid", usd(40_000));
  const cases: [Record<string, unknown>, string][] = [
    [{ ...good, more: [{ received: usd(13_300), method: "driver_cash" }] }, "results.0.more"],                       // twice the same way
    [{ ...good, more: [{ received: iqd(1_000), method: "driver_cash" }, { received: iqd(2_000), method: "driver_cash" }] }, "results.0.more"],
    [{ ...good, more: [{ received: iqd(1_000), method: "office_cash" }] }, "results.0.more.0.method"],
    [{ ...good, more: [{ received: iqd(0), method: "driver_cash" }] }, "results.0.more.0.received.amount"],
    [{ ...good, more: [{ received: iqd(1_000), method: "driver_cash" }, { received: usd(1), method: "fib" }, { received: iqd(1_000), method: "fib" }, { received: usd(1), method: "zaincash" }] }, "results.0.more"],
    [{ ...result(consignment, "paid"), more: [{ received: iqd(1_000), method: "driver_cash" }] }, "results.0.more"],  // the rest without a first
    [{ ...good, more: [{ received: iqd(1_000), method: "driver_cash", creditedUsdCents: 13_300 }] }, "results.0.more.0"],
  ];
  for (const [row, field] of cases) {
    const reply = await s.send("PUT", `/v1/rounds/${round}/results`, { results: [row] });
    assert.equal(reply.status, 400, JSON.stringify(row));
    assert.ok(field in reply.body.fields, `${JSON.stringify(row)} should name ${field}: ${JSON.stringify(reply.body.fields)}`);
  }
  // Goods that stayed in the car take no money, in any part.
  const held = await s.send("PUT", `/v1/rounds/${round}/results`, { results: [{ ...result(consignment, "held", usd(40_000)), more: [{ received: iqd(193_000), method: "driver_cash" }] }] });
  assert.equal(held.status, 422);
  assert.equal(held.body.code, "outcome_invalid");
  assert.deepEqual(await paymentsOf(a), []);

  const saved = await s.send("PUT", `/v1/rounds/${round}/results`, { results: [{ ...good, more: [{ received: iqd(193_000), method: "driver_cash" }] }] });
  assert.equal(saved.status, 200);
  assert.equal(await s.balance(a), 0);
  const resultId = saved.body.stopList[0].resultId as string;

  // One of its parts cannot be reversed on its own from the ledger.
  const part = (await paymentsOf(a)).find((p) => p.receivedCurrency === "IQD") as PaymentRow;
  const byHand = await s.send("POST", `/v1/entries/${part.entryId as string}/reverse`, { reason: "by hand" });
  assert.equal(byHand.status, 422);
  assert.equal(byHand.body.code, "round_money_needs_round");

  const back = await s.send("POST", `/v1/round-results/${resultId}/void`, { reason: "Wrong customer" });
  assert.equal(back.status, 200);
  assert.equal(await s.balance(a), 53_300);
  assert.deepEqual(back.body.stopList[0].payments, []);
  assert.deepEqual([back.body.collectedUsdCents, back.body.collectedIqd], [0, 0]);
  assert.ok((await paymentsOf(a)).every((p) => p.reversed === true));
  await s.sound();
});

test("the two accounts are on the books with everything else", async () => {
  const accounts = (await s.get("/v1/accounts")).body.items as { code: string | null; kind: string; currency: string; name: string }[];
  assert.deepEqual(
    accounts.filter((x) => x.kind === "adjustment").map((x) => [x.code, x.currency, x.name]).sort(),
    [["dinar_rounding_usd", "USD", "Dinar rounding"], ["errors_usd", "USD", "Errors"]],
  );
  assert.equal(h.app.ctx.checks.failed, 0, String(h.app.ctx.checks.lastError));
});
