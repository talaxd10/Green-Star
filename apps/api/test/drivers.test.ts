// The driver's own account, change at the door, and the delivery costs, over
// the real routes against a real Postgres.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { call, seedUser, signIn, start } from "./helpers.ts";
import { Scene } from "./scene.ts";

const h = await start();
after(() => h.close());

const ceo = await seedUser(h, "Sarkar");
const s = new Scene(h, await signIn(h, ceo));
await s.rate(150_000); // 1,500 per dollar: $10 is 15,000 IQD

const costs = async () => (await s.get("/v1/reports/delivery-costs")).body;

test("the driver is given money, brings back receipts with a kind and a city, and gives back the rest", async () => {
  const driver = await s.driver("Hemin");
  const round = (await s.send("POST", "/v1/rounds", { driverId: driver, stops: [] })).body.id;
  const vault = await s.account("vault_iqd");
  const before = await costs();

  const given = await s.send("POST", `/v1/drivers/${driver}/money`, { what: "advance", amount: { amount: 500_000, currency: "IQD" }, roundId: round, note: "Erbil trip" });
  assert.equal(given.status, 201, JSON.stringify(given.body));
  assert.deepEqual([given.body.name, given.body.holdsIqd, given.body.holdsUsdCents], ["Hemin", 500_000, 0]);
  assert.equal((await s.account("vault_iqd")) - vault, -500_000);

  for (const [category, amount, city] of [["fuel_car", 45_000, "Erbil"], ["transport", 75_000, "Erbil"], ["workers", 15_000, undefined]] as const) {
    const receipt = await s.send("POST", `/v1/drivers/${driver}/money`, { what: "expense", category, amount: { amount, currency: "IQD" }, roundId: round, ...(city ? { city } : {}) });
    assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
  }
  const back = await s.send("POST", `/v1/drivers/${driver}/money`, { what: "return", amount: { amount: 300_000, currency: "IQD" } });
  assert.equal(back.body.holdsIqd, 65_000);
  assert.deepEqual(
    back.body.lines.map((l: { kind: string; amount: number; balanceAfter: number; category: string | null; city: string | null; roundNumber: number | null }) => [l.kind, l.amount, l.balanceAfter, l.category, l.city, l.roundNumber === null]),
    [
      ["return", -300_000, 65_000, null, null, true],
      ["expense", -15_000, 365_000, "workers", null, false],
      ["expense", -75_000, 380_000, "transport", "Erbil", false],
      ["expense", -45_000, 455_000, "fuel_car", "Erbil", false],
      ["advance", 500_000, 500_000, null, null, false],
    ],
  );
  const listed = (await s.get("/v1/driver-accounts")).body.items.find((d: { driverId: string }) => d.driverId === driver);
  assert.deepEqual([listed.holdsIqd, listed.active], [65_000, true]);

  // The delivery costs count the receipts, in dollars at the day's rate: 135,000 IQD is $90.00.
  const after = await costs();
  assert.equal(after.delivery.usdCents - before.delivery.usdCents, 9_000);
  assert.equal(after.delivery.iqdPaid - before.delivery.iqdPaid, 135_000);
  const transport = (r: { byCategory: { category: string; usdCents: number }[] }) => r.byCategory.find((c) => c.category === "transport")?.usdCents ?? 0;
  assert.equal(transport(after) - transport(before), 5_000);
  const erbil = after.byCity.find((c: { city: string }) => c.city === "Erbil");
  assert.ok(erbil !== undefined && erbil.usdCents >= 8_000);
  const roundRow = after.byRound.find((x: { roundId: string }) => x.roundId === round);
  assert.deepEqual([roundRow.usdCents, roundRow.driverName], [9_000, "Hemin"]);
  await s.sound();
});

test("a receipt says what kind it was; the amount, the driver and the round must be real", async () => {
  const driver = await s.driver();
  const cases = [
    [{ what: "expense", amount: { amount: 1000, currency: "IQD" } }, "category"],
    [{ what: "advance", amount: { amount: 1000, currency: "IQD" }, category: "fuel_car" }, "category"],
    [{ what: "expense", amount: { amount: 1000, currency: "IQD" }, category: "lunch" }, "category"],
    [{ what: "advance", amount: { amount: 0, currency: "IQD" } }, "amount.amount"],
    [{ what: "bonus", amount: { amount: 1000, currency: "IQD" } }, "what"],
  ] as const;
  for (const [body, field] of cases) {
    const reply = await s.send("POST", `/v1/drivers/${driver}/money`, body);
    assert.equal(reply.status, 400, JSON.stringify(body));
    assert.ok(field in reply.body.fields, JSON.stringify(reply.body));
  }
  assert.equal((await s.send("POST", `/v1/drivers/${randomUUID()}/money`, { what: "advance", amount: { amount: 1000, currency: "IQD" } })).status, 404);
  assert.equal((await s.send("POST", `/v1/drivers/${driver}/money`, { what: "advance", amount: { amount: 1000, currency: "IQD" }, roundId: randomUUID() })).status, 404);
  assert.equal((await s.get(`/v1/drivers/${randomUUID()}/account`)).status, 404);
  assert.equal((await call(h.app, "GET", "/v1/driver-accounts")).status, 401);
  assert.equal((await call(h.app, "GET", "/v1/reports/delivery-costs")).status, 401);
});

test("change at the door: $500 to the driver for $490 of goods, 15,000 IQD back from his account", async () => {
  const customer = await s.customer();
  const file = await s.file([[customer, 49_000]]);
  const driver = await s.driver("Change Giver");
  const round = (await s.send("POST", "/v1/rounds", { driverId: driver, stops: [{ consignmentId: file.by[customer] }] })).body.id;
  await s.send("POST", `/v1/rounds/${round}/depart`, {});
  await s.send("POST", `/v1/drivers/${driver}/money`, { what: "advance", amount: { amount: 100_000, currency: "IQD" } });

  const row = { id: randomUUID(), consignmentId: file.by[customer], outcome: "paid", received: { amount: 50_000, currency: "USD" }, method: "driver_cash", happenedAt: new Date().toISOString() };
  // Change goes only on dollars paid to the driver.
  const wrong = await s.send("PUT", `/v1/rounds/${round}/results`, { results: [{ ...row, received: { amount: 735_000, currency: "IQD" }, changeIqd: 15_000 }] });
  assert.equal(wrong.status, 400);
  assert.ok("results.0.changeIqd" in wrong.body.fields);

  const saved = await s.send("PUT", `/v1/rounds/${round}/results`, { results: [{ ...row, changeIqd: 15_000 }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const stop = saved.body.stopList[0];
  assert.deepEqual([stop.payments[0].receivedAmount, stop.payments[0].changeIqd, stop.payments[0].creditedUsdCents, stop.remainingUsdCents], [50_000, 15_000, 49_000, 0]);
  assert.equal(await s.balance(customer), 0);
  assert.deepEqual(saved.body.cash.map((c: { currency: string; collected: number }) => [c.currency, c.collected]), [["USD", 50_000]]);

  const account = (await s.get(`/v1/drivers/${driver}/account`)).body;
  assert.equal(account.holdsIqd, 85_000);
  assert.deepEqual([account.lines[0].kind, account.lines[0].amount, account.lines[0].customerName], ["change", -15_000, (await s.get(`/v1/customers/${customer}`)).body.name]);
  await s.sound();
});

test("an expense paid from the vault can say its city and round, and counts in the delivery costs", async () => {
  const driver = await s.driver();
  const round = (await s.send("POST", "/v1/rounds", { driverId: driver, stops: [] })).body.id;
  const before = await costs();
  const paid = await s.send("POST", "/v1/cash-outs", { category: "transport", amount: { amount: 4_000, currency: "USD" }, reason: "Duhok transport company", city: "Duhok", roundId: round });
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  await s.send("POST", "/v1/cash-outs", { category: "rent_salaries", amount: { amount: 50_000, currency: "USD" }, reason: "Rent" });
  const after = await costs();
  assert.equal(after.delivery.usdCents - before.delivery.usdCents, 4_000, "rent is not a delivery cost");
  assert.equal(after.other.usdCents - before.other.usdCents, 50_000);
  assert.equal(after.byCity.find((c: { city: string }) => c.city === "Duhok")?.usdCents, 4_000);
  assert.equal(after.byRound.find((x: { roundId: string }) => x.roundId === round)?.usdCents, 4_000);
  // A range in the past has none of it.
  const past = (await s.get("/v1/reports/delivery-costs?from=2020-01-01&to=2020-12-31")).body;
  assert.deepEqual([past.delivery.usdCents, past.delivered.customers, past.perDeliveryUsdCents], [0, 0, null]);
  await s.sound();
});
