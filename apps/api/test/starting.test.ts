// Starting balances over the real routes: the vault, China and each
// customer's, typed in once, replaced when typed again, and what a customer
// owed before is never a file from China or goods for a round.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { call, seedUser, signIn, start } from "./helpers.ts";
import { Scene } from "./scene.ts";

const h = await start();
after(() => h.close());

const ceo = await seedUser(h, "Sarkar");
const s = new Scene(h, await signIn(h, ceo));

const setCustomer = (customerId: string, usdCents: number, id = randomUUID()) =>
  s.send("PUT", `/v1/starting-balances/customers/${customerId}`, { id, usdCents });
const setOffice = (what: string, amount: number, id = randomUUID()) => s.send("PUT", "/v1/starting-balances/office", { id, what, amount });

test("each customer's starting balance: what he owed is paid first, and is never a file or goods for a round", async () => {
  const owes = await s.customer();
  const credit = await s.customer();
  const set = await setCustomer(owes, 50_000);
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal((await setCustomer(credit, -20_000)).status, 200);
  assert.equal(await s.balance(owes), 50_000);
  assert.equal(await s.balance(credit), -20_000);

  const list = (await s.get("/v1/starting-balances")).body;
  const mine = list.customers.filter((c: { customerId: string }) => c.customerId === owes || c.customerId === credit);
  assert.deepEqual(
    mine.map((c: { customerId: string; usdCents: number; balanceUsdCents: number }) => [c.customerId === owes ? "owes" : "credit", c.usdCents, c.balanceUsdCents]).sort(),
    [["credit", -20_000, -20_000], ["owes", 50_000, 50_000]],
  );

  // Not a file from China: not in the files, not on Today, not ready for a round.
  const files = (await s.get("/v1/shipments?limit=100")).body.items;
  assert.equal(files.filter((f: { code: string }) => f.code === "Starting balances").length, 0);
  const today = (await s.get("/v1/reports/today")).body;
  assert.equal(today.files.filter((f: { code: string }) => f.code === "Starting balances").length, 0);
  const ready = (await s.get("/v1/consignments?filter=ready")).body.items;
  assert.equal(ready.filter((c: { customerId: string }) => c.customerId === owes).length, 0);
  // His own list still shows it, as what he owes.
  const his = (await s.get(`/v1/consignments?customerId=${owes}`)).body.items;
  assert.equal(his.length, 1);
  assert.equal(his[0].remainingUsdCents, 50_000);
  // And it cannot go on a round.
  const round = await s.send("POST", "/v1/rounds", { driverId: await s.driver(), stops: [{ consignmentId: his[0].id }] });
  assert.equal(round.status, 422, JSON.stringify(round.body));
  assert.equal(round.body.code, "starting_balance_not_goods");

  // A new file and a payment: the payment pays the old debt first.
  const file = await s.file([[owes, 10_000]]);
  const paid = await s.send("POST", "/v1/payments", { customerId: owes, received: { amount: 50_000, currency: "USD" }, method: "office_cash" });
  assert.equal(paid.status, 201);
  const after = (await s.get(`/v1/consignments?customerId=${owes}`)).body.items;
  const remaining = Object.fromEntries(after.map((c: { shipmentCode: string; remainingUsdCents: number }) => [c.shipmentCode === file.code ? "file" : "before", c.remainingUsdCents]));
  assert.deepEqual(remaining, { before: 0, file: 10_000 });

  // The statement says what it was.
  const statement = (await s.get(`/v1/customers/${owes}/statement`)).body;
  assert.ok(statement.lines.some((l: { kind: string; changeUsdCents: number }) => l.kind === "opening" && l.changeUsdCents === 50_000), JSON.stringify(statement.lines));
  await s.sound();
});

test("typing it again replaces it; the same request twice is one; 0 clears it", async () => {
  const a = await s.customer();
  const id = randomUUID();
  assert.equal((await setCustomer(a, 30_000, id)).status, 200);
  assert.equal((await setCustomer(a, 30_000, id)).status, 200);
  assert.equal(await s.balance(a), 30_000);
  assert.equal((await setCustomer(a, 12_500)).status, 200);
  assert.equal(await s.balance(a), 12_500);
  assert.equal((await setCustomer(a, 0)).status, 200);
  assert.equal(await s.balance(a), 0);
  const list = (await s.get("/v1/starting-balances")).body;
  assert.equal(list.customers.filter((c: { customerId: string }) => c.customerId === a).length, 0);

  assert.equal((await setCustomer(randomUUID(), 100)).status, 404);
  assert.equal((await setCustomer(a, 1.5)).status, 400);
  assert.equal((await s.send("PUT", `/v1/starting-balances/customers/${a}`, { usdCents: 100 })).status, 400, "the request says its id");
  await s.sound();
});

test("the vault and China start from what San says", async () => {
  const before = { usd: await s.account("vault_usd"), iqd: await s.account("vault_iqd"), china: await s.account("china_payable") };
  assert.equal((await setOffice("vault_usd", 250_000)).status, 200);
  assert.equal((await setOffice("vault_iqd", 3_000_000)).status, 200);
  const china = await setOffice("china", 1_000_000);
  assert.equal(china.status, 200);
  assert.deepEqual([china.body.vaultUsdCents, china.body.vaultIqd, china.body.chinaUsdCents], [250_000, 3_000_000, 1_000_000]);
  assert.equal((await s.account("vault_usd")) - before.usd, 250_000);
  assert.equal((await s.account("vault_iqd")) - before.iqd, 3_000_000);
  assert.equal((await s.account("china_payable")) - before.china, -1_000_000);

  assert.equal((await setOffice("vault_usd", -1)).status, 400);
  assert.equal((await setOffice("wallet_fib_usd", 1)).status, 400);
  const cleared = await setOffice("china", 0);
  assert.equal(cleared.body.chinaUsdCents, null);
  assert.equal(await s.account("china_payable"), before.china);
  await s.sound();
});

test("only someone signed in sees or sets them", async () => {
  assert.equal((await call(h.app, "GET", "/v1/starting-balances")).status, 401);
  assert.equal((await call(h.app, "PUT", "/v1/starting-balances/office", { body: { id: randomUUID(), what: "vault_usd", amount: 1 } })).status, 401);
});
