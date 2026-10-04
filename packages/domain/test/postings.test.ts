import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertBalanced,
  cashOut,
  currencyExchange,
  currencyExchangeToDinars,
  driverCollected,
  errorCorrection,
  fileConfirmed,
  iqd,
  officePayment,
  roundHandedIn,
  sentToChina,
  usd,
  walletPayment,
} from "../src/index.ts";

const customerId = "11111111-1111-4111-8111-111111111111";
const roundId = "22222222-2222-4222-8222-222222222222";

function total(lines: { currency: string; amount: bigint }[], currency: string): bigint {
  return lines.filter((l) => l.currency === currency).reduce((sum, l) => sum + l.amount, 0n);
}

test("a confirmed file charges the customer and owes China the same amount", () => {
  const entry = fileConfirmed({ customerId, amountDueUsdCents: 8500n })!;
  assert.equal(entry.kind, "file_confirmed");
  assert.deepEqual(
    entry.lines.map((l) => [l.account.type === "system" ? l.account.code : l.account.type, l.amount]),
    [
      ["customer", 8500n],
      ["china_payable", -8500n],
    ],
  );
});

test("a prepaid consignment posts nothing", () => {
  assert.equal(fileConfirmed({ customerId, amountDueUsdCents: 0n }), null);
});

test("the board's round: Rebwar pays 123,250 IQD for $85.00 at 1,450", () => {
  const entry = driverCollected({ roundId, customerId, received: iqd(123250), ratePer100: 145000 });
  assert.equal(entry.ratePer100, 145000);
  assert.equal(entry.lines.length, 4);
  assert.equal(total(entry.lines, "IQD"), 0n);
  assert.equal(total(entry.lines, "USD"), 0n);
  const customerLine = entry.lines.find((l) => l.account.type === "customer")!;
  assert.equal(customerLine.amount, -8500n);
  const driverLine = entry.lines.find((l) => l.account.type === "driver_cash")!;
  assert.deepEqual([driverLine.currency, driverLine.amount], ["IQD", 123250n]);
});

test("the CEO's example: 209,000 IQD settles $133.00, and the 12 cents are on the rounding account", () => {
  const draft = officePayment({ customerId, received: iqd(209000n), ratePer100: 157000, rounding: { creditUsdCents: 13300n } });
  assertBalanced(draft.lines);
  assert.equal(draft.ratePer100, 157000);
  const by = (code: string) => draft.lines.filter((l) => l.account.type === "system" && l.account.code === code).map((l) => l.amount);
  assert.deepEqual(by("vault_iqd"), [209000n]);
  assert.deepEqual(by("exchange_clearing_iqd"), [-209000n]);
  assert.deepEqual(by("exchange_clearing_usd"), [13312n], "the dinars pass through at exactly what they are worth");
  assert.deepEqual(by("dinar_rounding_usd"), [-12n], "rounding gave 12 cents");
  assert.deepEqual(draft.lines.filter((l) => l.account.type === "customer").map((l) => l.amount), [-13300n]);

  // 500 dinars short of $133.00 settles it too, and rounding took 32 cents.
  const short = driverCollected({ roundId, customerId, received: iqd(208310n), ratePer100: 157000, rounding: { creditUsdCents: 13300n } });
  assertBalanced(short.lines);
  assert.deepEqual(short.lines.filter((l) => l.account.type === "system" && l.account.code === "dinar_rounding_usd").map((l) => l.amount), [32n]);
});

test("a payment is rounded only in dinars and only within half a step", () => {
  // No rounding asked for, or the credit is what the dinars are worth anyway: no rounding line.
  for (const draft of [
    officePayment({ customerId, received: iqd(209000n), ratePer100: 157000 }),
    officePayment({ customerId, received: iqd(209000n), ratePer100: 157000, rounding: { creditUsdCents: 13312n } }),
    walletPayment({ customerId, wallet: "fib", received: usd(13300n), rounding: { creditUsdCents: 13300n } }),
  ]) {
    assert.ok(!draft.lines.some((l) => l.account.type === "system" && l.account.code === "dinar_rounding_usd"));
  }
  assert.throws(() => officePayment({ customerId, received: iqd(208000n), ratePer100: 157000, rounding: { creditUsdCents: 13300n } }), /rounding_too_large/);
  assert.throws(() => officePayment({ customerId, received: iqd(209000n), ratePer100: 157000, rounding: { creditUsdCents: 13300n, stepIqd: 250n } }), /rounding_too_large/);
  assert.throws(() => officePayment({ customerId, received: iqd(209000n), ratePer100: 157000, rounding: { creditUsdCents: 0n } }), /rounding_too_large/);
  assert.throws(() => officePayment({ customerId, received: usd(13312n), rounding: { creditUsdCents: 13300n } }), /rounding_invalid/);
});

test("an Error entry takes an amount off what the customer owes, with no money arriving", () => {
  const draft = errorCorrection({ customerId, amountUsdCents: 500n, reason: "  short at the door " });
  assertBalanced(draft.lines);
  assert.equal(draft.kind, "error_correction");
  assert.equal(draft.reason, "short at the door");
  assert.deepEqual(
    draft.lines.map((l) => [l.account.type === "system" ? l.account.code : l.account.type, l.amount]),
    [["errors_usd", 500n], ["customer", -500n]],
  );
  assert.equal(errorCorrection({ customerId, amountUsdCents: 1n }).reason, undefined);
  assert.equal(errorCorrection({ customerId, amountUsdCents: 1n, reason: "   " }).reason, undefined);
  assert.throws(() => errorCorrection({ customerId, amountUsdCents: 0n }), RangeError);
  assert.throws(() => errorCorrection({ customerId, amountUsdCents: -500n }), RangeError);
});

test("a dollar payment needs no rate and no conversion", () => {
  const entry = officePayment({ customerId, received: usd(4000) });
  assert.equal(entry.ratePer100, undefined);
  assert.equal(entry.lines.length, 2);
});

test("a dinar payment without today's rate is refused", () => {
  assert.throws(() => officePayment({ customerId, received: iqd(50000) }), /rate_missing/);
  assert.throws(() => walletPayment({ customerId, wallet: "fib", received: iqd(50000) }), /rate_missing/);
});

test("wallet payments land in that wallet's account", () => {
  const entry = walletPayment({ customerId, wallet: "zaincash", received: iqd(145000), ratePer100: 145000 });
  const walletLine = entry.lines[0]!;
  assert.deepEqual(walletLine.account, { type: "system", code: "wallet_zaincash_iqd" });
});

test("a hand-in moves only what was counted, per currency", () => {
  const entry = roundHandedIn({ roundId, countedUsdCents: 0n, countedIqd: 123250n });
  assert.equal(entry.lines.length, 2);
  const both = roundHandedIn({ roundId, countedUsdCents: 4000n, countedIqd: 123250n });
  assert.equal(both.lines.length, 4);
  assert.throws(() => roundHandedIn({ roundId, countedUsdCents: 0n, countedIqd: 0n }), RangeError);
});

test("cash out needs a reason; sending to China pays the debt down", () => {
  assert.throws(() => cashOut({ category: "fuel_car", amount: iqd(25000), reason: "  " }), /reason/);
  const out = cashOut({ category: "fuel_car", amount: iqd(25000), reason: "Fuel for round 14" });
  assert.deepEqual(out.lines[0]!.account, { type: "system", code: "expense_fuel_car_iqd" });
  const sent = sentToChina({ amountUsdCents: 500000n });
  assert.deepEqual(sent.lines[0], { account: { type: "system", code: "china_payable" }, currency: "USD", amount: 500000n });
});

test("an exchange records both real amounts and the rate they imply", () => {
  const entry = currencyExchange({ iqdGiven: 1451000n, usdCentsReceived: 100000n });
  assert.equal(entry.ratePer100, 145100);
  assert.equal(total(entry.lines, "IQD"), 0n);
  assert.equal(total(entry.lines, "USD"), 0n);
});

test("zero, negative and unbalanced amounts are refused", () => {
  assert.throws(() => officePayment({ customerId, received: usd(0) }), RangeError);
  assert.throws(() => sentToChina({ amountUsdCents: -1n }), RangeError);
  assert.throws(() => fileConfirmed({ customerId, amountDueUsdCents: -1n }), RangeError);
  // 1 IQD is worth less than half a cent, so it would credit nothing.
  assert.throws(() => officePayment({ customerId, received: iqd(1), ratePer100: 145000 }), RangeError);
  assert.throws(
    () =>
      assertBalanced([
        { account: { type: "system", code: "vault_usd" }, currency: "USD", amount: 100n },
        { account: { type: "system", code: "china_payable" }, currency: "USD", amount: -99n },
      ]),
    /does not balance/,
  );
});

test("every builder balances for random amounts in both currencies", () => {
  let seed = 42;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed % n) + 1;
  };
  for (let run = 0; run < 2000; run++) {
    const rate = 130000 + next(30000);
    const dinars = BigInt(next(4000) * 250);
    const cents = BigInt(next(500000));
    const drafts = [
      driverCollected({ roundId, customerId, received: iqd(dinars), ratePer100: rate }),
      driverCollected({ roundId, customerId, received: usd(cents) }),
      officePayment({ customerId, received: iqd(dinars), ratePer100: rate }),
      walletPayment({ customerId, wallet: "fastpay", received: usd(cents) }),
      roundHandedIn({ roundId, countedUsdCents: cents, countedIqd: dinars }),
      currencyExchange({ iqdGiven: dinars, usdCentsReceived: cents }),
      cashOut({ category: "other", amount: iqd(dinars), reason: "test" }),
      sentToChina({ amountUsdCents: cents }),
    ];
    for (const d of drafts) assertBalanced(d.lines);
  }
});

test("an exchange works both ways and each way balances", () => {
  const toDollars = currencyExchange({ iqdGiven: 1470000n, usdCentsReceived: 100000n });
  const toDinars = currencyExchangeToDinars({ usdCentsGiven: 100000n, iqdReceived: 1465000n });
  assert.equal(toDollars.ratePer100, 147000);
  assert.equal(toDinars.ratePer100, 146500);
  const vault = (draft: typeof toDollars, currency: "USD" | "IQD") =>
    draft.lines.find((l) => l.account.type === "system" && l.account.code === `vault_${currency.toLowerCase()}`)!.amount;
  assert.deepEqual([vault(toDollars, "USD"), vault(toDollars, "IQD")], [100000n, -1470000n]);
  assert.deepEqual([vault(toDinars, "USD"), vault(toDinars, "IQD")], [-100000n, 1465000n]);
  assert.throws(() => currencyExchangeToDinars({ usdCentsGiven: 0n, iqdReceived: 1n }), /more than zero/);
});
