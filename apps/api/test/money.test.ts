// Money at the office, over the real routes against a real Postgres.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { seedUser, signIn, start } from "./helpers.ts";
import { RATE, result, Scene, unique } from "./scene.ts";

const h = await start();
after(() => h.close());

const ceo = await seedUser(h, "ceo", "Sarkar");
const s = new Scene(h, await signIn(h, ceo));
const ownerCookie = await signIn(h, await seedUser(h, "owner"));
await s.rate();

const now = () => new Date().toISOString();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const dayOf = (iso: string) => new Date(Date.parse(iso) + 3 * 3_600_000).toISOString().slice(0, 10);   // the Baghdad day

test("today's rate is set in one place, shown with who set it, and a typing mistake is caught", async () => {
  const today = (await s.get("/v1/fx-rates/today")).body;
  assert.match(today.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(today.rate.iqdPer100Usd, RATE);
  assert.equal(today.rate.setBy, "Sarkar");

  // A quiet day last year, away from every other test: 152,750 per $100 is 1,527.5 per dollar.
  const day = dayOf(daysAgo(400));
  const set = await s.send("PUT", `/v1/fx-rates/${day}`, { iqdPer100Usd: 152_750 });
  assert.equal(set.status, 200);
  assert.deepEqual([set.body.day, set.body.iqdPer100Usd, set.body.setBy], [day, 152_750, "Sarkar"]);

  // 1,527 typed instead of 152,700.
  const typo = await s.send("PUT", `/v1/fx-rates/${day}`, { iqdPer100Usd: 1_527 });
  assert.equal(typo.status, 422);
  assert.equal(typo.body.code, "rate_jump");
  assert.equal((await s.get(`/v1/fx-rates?from=${day}&to=${day}`)).body.items[0].iqdPer100Usd, 152_750);
  const sure = await s.send("PUT", `/v1/fx-rates/${day}`, { iqdPer100Usd: 1_527, confirm: true });
  assert.equal(sure.body.iqdPer100Usd, 1_527, "sent again to confirm, it is taken");
  await s.send("PUT", `/v1/fx-rates/${day}`, { iqdPer100Usd: 152_750, confirm: true });

  const { rows } = await h.owner.query("select rate_before, rate_after from fx_rate_changes where day = $1 order by id", [day]);
  assert.deepEqual(rows, [
    { rate_before: null, rate_after: 152_750 },
    { rate_before: 152_750, rate_after: 1_527 },
    { rate_before: 1_527, rate_after: 152_750 },
  ]);

  const tomorrow = dayOf(new Date(Date.now() + 2 * 86_400_000).toISOString());
  for (const [path, body] of [
    [`/v1/fx-rates/${tomorrow}`, { iqdPer100Usd: RATE }],
    ["/v1/fx-rates/today", { iqdPer100Usd: 1450.5 }],
    ["/v1/fx-rates/today", { iqdPer100Usd: 0 }],
    ["/v1/fx-rates/soon", { iqdPer100Usd: RATE }],
  ] as const) {
    assert.equal((await s.send("PUT", path, body)).status, 400, path);
  }
});

test("a payment at the office pays the customer's oldest file first", async () => {
  const a = await s.customer();
  const oldest = await s.file([[a, 4_000]]);
  const middle = await s.file([[a, 3_000]]);
  const newest = await s.file([[a, 5_000]]);
  const vaultBefore = await s.account("vault_usd");

  const paid = await s.send("POST", "/v1/payments", { customerId: a, received: { amount: 6_000, currency: "USD" }, method: "office_cash", note: "Cash from his brother" });
  assert.equal(paid.status, 201);
  assert.equal(paid.body.method, "office_cash");
  assert.equal(paid.body.kind, "office_payment");
  assert.equal(paid.body.creditedUsdCents, 6_000);
  assert.equal(paid.body.note, "Cash from his brother");
  assert.equal(paid.body.reversed, false);
  assert.equal(await s.balance(a), 6_000);
  assert.equal((await s.account("vault_usd")) - vaultBefore, 6_000);

  const owed = async () => {
    const items = (await s.get(`/v1/consignments?customerId=${a}`)).body.items;
    return [oldest, middle, newest].map((f) => items.find((c: { id: string }) => c.id === f.by[a]).remainingUsdCents);
  };
  assert.deepEqual(await owed(), [0, 1_000, 5_000]);

  // A payment that names a consignment pays that one first.
  await s.send("POST", "/v1/payments", { customerId: a, received: { amount: 5_000, currency: "USD" }, method: "office_cash", forConsignmentId: newest.by[a] });
  assert.deepEqual(await owed(), [0, 1_000, 0]);

  // More than he owes stays on his account as credit.
  await s.send("POST", "/v1/payments", { customerId: a, received: { amount: 1_500, currency: "USD" }, method: "office_cash" });
  assert.equal(await s.balance(a), -500);
  await s.sound();
});

test("dinars convert at the rate of the day the money moved, to the cent", async () => {
  const a = await s.customer();
  await s.file([[a, 20_000]]);

  const today = await s.send("POST", "/v1/payments", { customerId: a, received: { amount: 123_250, currency: "IQD" }, method: "office_cash" });
  assert.equal(today.status, 201);
  assert.deepEqual([today.body.receivedAmount, today.body.receivedCurrency, today.body.iqdPer100Usd, today.body.creditedUsdCents], [123_250, "IQD", RATE, 8_500]);

  // Money that moved on another day converts at that day's rate.
  const then = daysAgo(390);
  await s.rate(150_000, dayOf(then));
  const earlier = await s.send("POST", "/v1/payments", { customerId: a, received: { amount: 150_000, currency: "IQD" }, method: "office_cash", happenedAt: then });
  assert.deepEqual([earlier.body.iqdPer100Usd, earlier.body.creditedUsdCents], [150_000, 10_000]);
  assert.equal(await s.balance(a), 1_500);

  // And not at all on a day whose rate nobody set.
  const noRate = await s.send("POST", "/v1/payments", { customerId: a, received: { amount: 1_000, currency: "IQD" }, method: "office_cash", happenedAt: daysAgo(1200) });
  assert.equal(noRate.status, 422);
  assert.equal(noRate.body.code, "rate_missing");
  assert.equal(await s.balance(a), 1_500);
});

test("a wallet payment goes to that wallet's account and never through the vault", async () => {
  const a = await s.customer();
  await s.file([[a, 10_000]]);
  const before = { vault: await s.account("vault_usd"), fib: await s.account("wallet_fib_usd"), zain: await s.account("wallet_zaincash_iqd") };

  const fib = await s.send("POST", "/v1/payments", { customerId: a, received: { amount: 4_000, currency: "USD" }, method: "fib" });
  assert.deepEqual([fib.body.method, fib.body.kind], ["fib", "wallet_payment"]);
  const zain = await s.send("POST", "/v1/payments", { customerId: a, received: { amount: 87_000, currency: "IQD" }, method: "zaincash" });
  assert.equal(zain.body.creditedUsdCents, 6_000);

  assert.equal((await s.account("wallet_fib_usd")) - before.fib, 4_000);
  assert.equal((await s.account("wallet_zaincash_iqd")) - before.zain, 87_000);
  assert.equal(await s.account("vault_usd"), before.vault);
  assert.equal(await s.balance(a), 0);
});

test("a payment is checked before it is posted", async () => {
  const a = await s.customer();
  await s.file([[a, 5_000]]);
  const good = { customerId: a, received: { amount: 1_000, currency: "USD" }, method: "office_cash" };
  const cases: [Record<string, unknown>, number, string][] = [
    [{ ...good, received: { amount: 0, currency: "USD" } }, 400, "received.amount"],
    [{ ...good, received: { amount: -100, currency: "USD" } }, 400, "received.amount"],
    [{ ...good, received: { amount: 10.5, currency: "USD" } }, 400, "received.amount"],
    [{ ...good, received: { amount: 100, currency: "EUR" } }, 400, "received.currency"],
    [{ ...good, method: "driver_cash" }, 400, "method"],
    [{ ...good, method: "bank" }, 400, "method"],
    [{ ...good, customerId: "someone" }, 400, "customerId"],
    [{ ...good, happenedAt: new Date(Date.now() + 3_600_000).toISOString() }, 400, "happenedAt"],
    [{ ...good, discount: 500 }, 400, "_"],
  ];
  for (const [body, status, field] of cases) {
    const reply = await s.send("POST", "/v1/payments", body);
    assert.equal(reply.status, status, JSON.stringify(body));
    assert.ok(field in reply.body.fields, `${JSON.stringify(reply.body.fields)} should name ${field}`);
  }
  assert.equal((await s.send("POST", "/v1/payments", { ...good, customerId: randomUUID() })).status, 404);
  const other = await s.customer();
  const otherFile = await s.file([[other, 1_000]]);
  const wrongTarget = await s.send("POST", "/v1/payments", { ...good, forConsignmentId: otherFile.by[other] });
  assert.equal(wrongTarget.status, 422);
  assert.equal(wrongTarget.body.code, "target_invalid");
  assert.equal(await s.balance(a), 5_000);
});

test("eight clicks on Save at the same moment post one payment, and each gets the same answer", async () => {
  const a = await s.customer();
  await s.file([[a, 9_000]]);
  const key = randomUUID();
  const body = { customerId: a, received: { amount: 2_000, currency: "USD" }, method: "office_cash" };
  const replies = await Promise.all(Array.from({ length: 8 }, () => s.send("POST", "/v1/payments", body, key)));

  assert.deepEqual([...new Set(replies.map((r) => r.status))], [201]);
  assert.equal(new Set(replies.map((r) => r.body.entryId)).size, 1);
  assert.equal(replies.filter((r) => r.headers["idempotent-replay"] === "true").length, 7);
  assert.equal(await s.balance(a), 7_000);
  // The ledger posts under the request's own key too: its second lock, if the API's record of the request were ever lost.
  const posted = await s.h.owner.query("select idempotency_key from journal_entries where id = $1", [replies[0]?.body.entryId]);
  assert.equal(posted.rows[0].idempotency_key, `api:${key}`);

  const later = await s.send("POST", "/v1/payments", body, key);
  assert.deepEqual(later.body, replies[0]?.body, "the same key days later still returns the first answer");
  const different = await s.send("POST", "/v1/payments", { ...body, received: { amount: 2_001, currency: "USD" } }, key);
  assert.equal(different.status, 422);
  assert.equal(different.body.code, "idempotency_key_reused");
  assert.equal(await s.balance(a), 7_000);
  await s.sound();
});

test("cash out needs a category and a reason, and money to China pays down what is owed", async () => {
  const before = { usd: await s.account("vault_usd"), iqd: await s.account("vault_iqd"), china: (await s.get("/v1/china-account")).body };

  const fuel = await s.send("POST", "/v1/cash-outs", { category: "fuel_car", amount: { amount: 40_000, currency: "IQD" }, reason: "Fuel for the Kirkuk round" });
  assert.equal(fuel.status, 201);
  assert.deepEqual([fuel.body.category, fuel.body.amount, fuel.body.currency, fuel.body.reason, fuel.body.reversed], ["fuel_car", 40_000, "IQD", "Fuel for the Kirkuk round", false]);
  const china = await s.send("POST", "/v1/cash-outs", { category: "china", amount: { amount: 250_000, currency: "USD" }, reason: "Sent with Kak Azad" });
  assert.equal(china.body.category, "china");

  assert.equal((await s.account("vault_iqd")) - before.iqd, -40_000);
  assert.equal((await s.account("vault_usd")) - before.usd, -250_000);
  const after = (await s.get("/v1/china-account", ownerCookie)).body;
  assert.equal(after.sentUsdCents - before.china.sentUsdCents, 250_000);
  assert.equal(after.owedUsdCents - before.china.owedUsdCents, -250_000);
  assert.equal(after.lines[0].entryId, china.body.entryId);
  assert.equal(after.lines[0].owedChangeUsdCents, -250_000);
  assert.equal(after.lines[0].reason, "Sent with Kak Azad");

  const listed = (await s.get("/v1/cash-outs?limit=2")).body.items.map((c: { entryId: string }) => c.entryId);
  assert.deepEqual(listed, [china.body.entryId, fuel.body.entryId]);

  for (const body of [
    { category: "fuel_car", amount: { amount: 100, currency: "USD" } },
    { category: "fuel_car", amount: { amount: 100, currency: "USD" }, reason: "   " },
    { category: "gifts", amount: { amount: 100, currency: "USD" }, reason: "x" },
    { category: "china", amount: { amount: 100_000, currency: "IQD" }, reason: "x" },
    { category: "discount", amount: { amount: 100, currency: "USD" }, reason: "for a friend" },
  ]) {
    assert.equal((await s.send("POST", "/v1/cash-outs", body)).status, 400, JSON.stringify(body));
  }
});

test("a file adds to what is owed to China, customer by customer", async () => {
  const before = (await s.get("/v1/china-account")).body;
  const a = await s.customer();
  const file = await s.file([[a, 12_300]]);
  const after = (await s.get("/v1/china-account")).body;
  assert.equal(after.chargedUsdCents - before.chargedUsdCents, 12_300);
  assert.equal(after.owedUsdCents - before.owedUsdCents, 12_300);
  assert.deepEqual([after.lines[0].kind, after.lines[0].shipmentCode, after.lines[0].customerId, after.lines[0].owedChangeUsdCents], ["file_confirmed", file.code, a, 12_300]);
  assert.equal(after.lines[0].owedAfterUsdCents, after.owedUsdCents);
  assert.ok(after.byDay[0].chargedUsdCents >= 12_300);
});

test("the China account's lines read in order: each line's total follows from the one before", async () => {
  const a = await s.customer();
  const b = await s.customer();
  await s.file([[a, 1_100], [b, 2_200]]);   // two charges at the same instant
  // Money that moved three days ago, entered today: it belongs earlier in the account.
  await s.send("POST", "/v1/cash-outs", { category: "china", amount: { amount: 700, currency: "USD" }, reason: "Entered late", happenedAt: daysAgo(3) });
  await s.file([[a, 3_300]]);

  const first = (await s.get("/v1/china-account?limit=4")).body;
  const second = (await s.get(`/v1/china-account?limit=4&cursor=${first.nextCursor}`)).body;
  const lines = [...first.lines, ...second.lines];
  assert.equal(lines.length, 8);
  assert.equal(new Set(lines.map((l: { entryId: string }) => l.entryId)).size, 8, "no line twice across pages");
  assert.equal(lines[0].owedAfterUsdCents, first.owedUsdCents, "the newest line ends on what is owed now");
  for (let i = 0; i + 1 < lines.length; i += 1) {
    assert.equal(lines[i].owedAfterUsdCents - lines[i].owedChangeUsdCents, lines[i + 1].owedAfterUsdCents, `line ${i} follows line ${i + 1}`);
    assert.ok(Date.parse(lines[i].happenedAt) >= Date.parse(lines[i + 1].happenedAt), "newest first, by when the money moved");
  }
  assert.ok(!lines.slice(0, 3).some((l: { reason: string | null }) => l.reason === "Entered late"), "the late entry is not at the top");
  assert.equal((await s.get("/v1/china-account?cursor=abc")).status, 400);
});

test("vault money is changed between dinars and dollars at the rate it really got", async () => {
  await s.send("POST", "/v1/payments", { customerId: await s.customer(), received: { amount: 2_000_000, currency: "IQD" }, method: "office_cash" });
  const before = { usd: await s.account("vault_usd"), iqd: await s.account("vault_iqd") };

  const toDollars = await s.send("POST", "/v1/exchanges", { given: { amount: 1_460_000, currency: "IQD" }, received: { amount: 100_000, currency: "USD" } });
  assert.equal(toDollars.status, 201);
  assert.equal(toDollars.body.kind, "currency_exchange");
  assert.equal(toDollars.body.iqdPer100Usd, 146_000, "the rate the exchange shop gave");
  assert.equal(toDollars.body.lines.length, 4);
  assert.equal((await s.account("vault_usd")) - before.usd, 100_000);
  assert.equal((await s.account("vault_iqd")) - before.iqd, -1_460_000);

  const back = await s.send("POST", "/v1/exchanges", { given: { amount: 50_000, currency: "USD" }, received: { amount: 720_000, currency: "IQD" } });
  assert.equal(back.body.iqdPer100Usd, 144_000);
  assert.equal((await s.account("vault_usd")) - before.usd, 50_000);

  assert.equal((await s.send("POST", "/v1/exchanges", { given: { amount: 100, currency: "USD" }, received: { amount: 100, currency: "USD" } })).status, 400);
  assert.equal((await s.send("POST", "/v1/exchanges", { given: { amount: 100, currency: "USD" } })).status, 400);
  await s.sound();
});

test("a mistake is reversed with a reason, once; charges and round money are fixed their own way", async () => {
  const a = await s.customer();
  const file = await s.file([[a, 5_000]]);
  const paid = await s.send("POST", "/v1/payments", { customerId: a, received: { amount: 5_000, currency: "USD" }, method: "office_cash" });
  assert.equal(await s.balance(a), 0);

  assert.equal((await s.send("POST", `/v1/entries/${paid.body.entryId}/reverse`, {})).status, 400);
  const reversal = await s.send("POST", `/v1/entries/${paid.body.entryId}/reverse`, { reason: "Posted to the wrong customer" });
  assert.equal(reversal.status, 201);
  assert.equal(reversal.body.kind, "reversal");
  assert.equal(reversal.body.reversesId, paid.body.entryId);
  assert.equal(reversal.body.reason, "Posted to the wrong customer");
  assert.equal(reversal.body.createdByName, "Sarkar");
  assert.deepEqual(reversal.body.lines.map((l: { amount: number }) => l.amount).sort(), [-5_000, 5_000]);
  assert.equal(await s.balance(a), 5_000);

  const original = (await s.get(`/v1/entries/${paid.body.entryId}`)).body;
  assert.equal(original.reversedById, reversal.body.id);
  assert.equal((await s.get(`/v1/payments?customerId=${a}`)).body.items[0].reversed, true);

  const twice = await s.send("POST", `/v1/entries/${paid.body.entryId}/reverse`, { reason: "again" });
  assert.equal(twice.status, 422);
  assert.equal(twice.body.code, "already_reversed");
  assert.equal((await s.send("POST", `/v1/entries/${reversal.body.id}/reverse`, { reason: "undo the undo" })).body.code, "reversal_invalid");
  assert.equal((await s.send("POST", `/v1/entries/${randomUUID()}/reverse`, { reason: "x" })).status, 404);

  // A charge is undone by cancelling its consignment; round money by changing the round result.
  const charge = (await s.get(`/v1/ledger?customerId=${a}&kind=file_confirmed`)).body.items[0];
  assert.equal((await s.send("POST", `/v1/entries/${charge.id}/reverse`, { reason: "x" })).body.code, "charge_needs_consignment");
  const round = await s.roundOut([file.by[a] as string]);
  await s.send("PUT", `/v1/rounds/${round}/results`, { results: [result(file.by[a] as string, "paid", { amount: 5_000, currency: "USD" })] });
  const collected = (await s.get(`/v1/ledger?customerId=${a}&kind=driver_collected`)).body.items[0];
  assert.equal((await s.send("POST", `/v1/entries/${collected.id}/reverse`, { reason: "x" })).body.code, "round_money_needs_round");
  assert.equal(await s.balance(a), 0);
  await s.sound();
});

test("the ledger is read by customer, by account, by kind and by day, a page at a time, and every entry balances", async () => {
  const a = await s.customer();
  await s.file([[a, 9_000]]);
  for (const amount of [1_000, 2_000, 3_000]) {
    await s.send("POST", "/v1/payments", { customerId: a, received: { amount, currency: "USD" }, method: "office_cash" });
  }
  const his = (await s.get(`/v1/ledger?customerId=${a}`, ownerCookie)).body.items;
  assert.deepEqual(his.map((e: { kind: string }) => e.kind), ["office_payment", "office_payment", "office_payment", "file_confirmed"], "newest first");
  for (const entry of his) {
    const sum = entry.lines.reduce((total: number, line: { amount: number }) => total + line.amount, 0);
    assert.equal(sum, 0, "every entry sums to zero");
    assert.equal(entry.createdByName, "Sarkar");
  }
  const line = his[0].lines.find((l: { accountKind: string }) => l.accountKind === "vault");
  assert.deepEqual([line.accountCode, line.currency, line.amount], ["vault_usd", "USD", 3_000]);

  const first = (await s.get(`/v1/ledger?customerId=${a}&kind=office_payment&limit=2`)).body;
  assert.equal(first.items.length, 2);
  const rest = (await s.get(`/v1/ledger?customerId=${a}&kind=office_payment&limit=2&cursor=${first.nextCursor}`)).body;
  assert.equal(rest.items.length, 1);
  assert.equal(rest.nextCursor, null);
  assert.equal(new Set([...first.items, ...rest.items].map((e: { id: string }) => e.id)).size, 3);

  const vault = (await s.get("/v1/ledger?account=vault_usd&limit=3")).body.items;
  assert.ok(vault.every((e: { lines: { accountCode: string }[] }) => e.lines.some((l) => l.accountCode === "vault_usd")));
  const today = dayOf(now());
  assert.equal((await s.get(`/v1/ledger?customerId=${a}&from=${today}&to=${today}`)).body.items.length, 4);
  assert.equal((await s.get(`/v1/ledger?customerId=${a}&to=${dayOf(daysAgo(2))}`)).body.items.length, 0);
  assert.equal((await s.get("/v1/ledger?kind=discount")).status, 400);
  assert.equal((await s.get(`/v1/entries/${randomUUID()}`)).status, 404);
});

test("the vault is closed by counting it; a gap needs a note; a wrong count is taken back", async () => {
  const vault = (await s.get("/v1/vault", ownerCookie)).body;
  const usd = vault.currencies.find((c: { currency: string }) => c.currency === "USD");
  const iqd = vault.currencies.find((c: { currency: string }) => c.currency === "IQD");
  assert.deepEqual(vault.currencies.map((c: { currency: string }) => c.currency), ["USD", "IQD"]);
  assert.deepEqual(vault.denominations.filter((d: { currency: string }) => d.currency === "USD").map((d: { value: number }) => d.value), [10000, 5000, 2000, 1000, 500, 200, 100]);
  assert.equal(usd.expectedNow, usd.ledgerBalance + usd.notedGap);

  // He counts $300 less than should be there, in hundreds.
  const hundreds = Math.max(Math.floor(usd.expectedNow / 10_000) - 3, 0);
  const counted = hundreds * 10_000;
  const close = { id: randomUUID(), usdNotes: { 10000: hundreds }, iqdNotes: {} };
  const noNote = await s.send("POST", "/v1/vault/close", close);
  assert.equal(noNote.status, 422);
  assert.equal(noNote.body.code, "gap_note_required");
  assert.equal((await s.send("POST", "/v1/vault/close", { ...close, usdNotes: { 7000: 1 }, note: "x" })).body.code, "note_unknown");

  const key = randomUUID();
  const closed = await s.send("POST", "/v1/vault/close", { ...close, note: "Counting for the first time" }, key);
  assert.equal(closed.status, 201);
  const mine = closed.body.closes[0];
  assert.equal(mine.id, close.id);
  assert.deepEqual(mine.usd, { notes: { 10000: hundreds }, counted, expected: usd.expectedNow, difference: counted - usd.expectedNow });
  assert.equal(mine.iqd.difference, -iqd.expectedNow);
  const after = closed.body.currencies.find((c: { currency: string }) => c.currency === "USD");
  assert.equal(after.expectedNow, counted, "from now on the vault is expected to hold what was counted");
  assert.equal(after.lastCloseId, close.id);
  assert.equal(after.ledgerBalance, usd.ledgerBalance, "a gap is noted, not posted");

  // The same close sent again is one close.
  await s.send("POST", "/v1/vault/close", { ...close, note: "Counting for the first time" }, key);
  await s.send("POST", "/v1/vault/close", { ...close, note: "Counting for the first time" });
  assert.equal((await s.get("/v1/vault")).body.closes.filter((c: { id: string }) => c.id === close.id).length, 1);

  // Money entered since the count is expected on top of it.
  await s.send("POST", "/v1/payments", { customerId: await s.customer(), received: { amount: 4_000, currency: "USD" }, method: "office_cash" });
  assert.equal((await s.get("/v1/vault")).body.currencies.find((c: { currency: string }) => c.currency === "USD").expectedNow, counted + 4_000);

  assert.equal((await s.send("POST", `/v1/vault/closes/${close.id}/void`, {})).status, 400);
  const taken = await s.send("POST", `/v1/vault/closes/${close.id}/void`, { reason: "Counted the wrong drawer" });
  assert.equal(taken.status, 200);
  assert.equal(taken.body.closes.find((c: { id: string }) => c.id === close.id).voided, true);
  assert.equal(taken.body.currencies.find((c: { currency: string }) => c.currency === "USD").expectedNow, usd.expectedNow + 4_000);
  assert.equal((await s.send("POST", `/v1/vault/closes/${randomUUID()}/void`, { reason: "x" })).status, 404);
});

test("payments are listed with how each was paid, and the owner reads every money screen", async () => {
  const a = await s.customer(unique("Payer "));
  await s.file([[a, 9_000]]);
  await s.send("POST", "/v1/payments", { customerId: a, received: { amount: 1_000, currency: "USD" }, method: "fastpay" });
  await s.send("POST", "/v1/payments", { customerId: a, received: { amount: 14_500, currency: "IQD" }, method: "office_cash" });

  const list = (await s.get(`/v1/payments?customerId=${a}`, ownerCookie)).body.items;
  assert.deepEqual(list.map((p: Record<string, unknown>) => [p.method, p.receivedAmount, p.receivedCurrency, p.creditedUsdCents]), [
    ["office_cash", 14_500, "IQD", 1_000],
    ["fastpay", 1_000, "USD", 1_000],
  ]);
  assert.match(list[0].customerName, /^PAYER /);
  assert.deepEqual(list.map((p: { roundId: string | null }) => p.roundId), [null, null], "paid at the office, not on a round");

  // Money taken on a round says which round, whether it was cash or a wallet at the door.
  const b = await s.customer();
  const c = await s.customer();
  const file = await s.file([[b, 2_000], [c, 3_000]]);
  const round = await s.roundOut([file.by[b] as string, file.by[c] as string]);
  await s.send("PUT", `/v1/rounds/${round}/results`, {
    results: [result(file.by[b] as string, "paid", { amount: 2_000, currency: "USD" }), result(file.by[c] as string, "paid", { amount: 3_000, currency: "USD" }, "fib")],
  });
  for (const customer of [b, c]) {
    const [payment] = (await s.get(`/v1/payments?customerId=${customer}`)).body.items;
    assert.equal(payment.roundId, round, payment.method);
  }

  for (const url of ["/v1/fx-rates/today", "/v1/fx-rates", "/v1/payments", "/v1/cash-outs", "/v1/vault", "/v1/ledger", "/v1/accounts", "/v1/china-account"]) {
    assert.equal((await s.get(url, ownerCookie)).status, 200, url);
  }
  const accounts = (await s.get("/v1/accounts", ownerCookie)).body.items;
  assert.ok(accounts.every((x: { kind: string }) => x.kind !== "customer"), "customer accounts are on the customers screen");
  assert.ok(accounts.some((x: { code: string }) => x.code === "china_payable"));
});
