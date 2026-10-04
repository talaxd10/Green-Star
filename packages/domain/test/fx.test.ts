import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baghdadDay,
  baghdadDayStart,
  conversionAgrees,
  dinarCredit,
  dinarsSettle,
  impliedRate,
  isRateJump,
  iqdToUsdCents,
  rateFromPerDollar,
  roundDinars,
  usdCentsToIqd,
} from "../src/index.ts";

test("the board's example: 123,250 IQD at 1,450 per dollar is $85.00", () => {
  const rate = rateFromPerDollar(1450);
  assert.equal(rate, 145000);
  assert.equal(iqdToUsdCents(123250n, rate), 8500n);
  assert.equal(usdCentsToIqd(8500n, rate), 123250n);
});

test("a rate quoted per $100 with a half dinar per dollar is exact", () => {
  // 152,750 per $100 is 1,527.5 per dollar.
  assert.equal(iqdToUsdCents(152750n, 152750), 10000n);
  assert.equal(usdCentsToIqd(10000n, 152750), 152750n);
});

test("half a cent rounds up, and negatives mirror positives", () => {
  // 91,000 IQD at 1,470: 6190.476... cents
  assert.equal(iqdToUsdCents(91000n, 147000), 6190n);
  // 91,250 IQD at 1,470: 6207.48... cents
  assert.equal(iqdToUsdCents(91250n, 147000), 6207n);
  // exactly half a cent: 735 IQD at 147,000 per $100 is 50 cents; 7.35 IQD would be half a cent.
  assert.equal(iqdToUsdCents(22050n, 147000), 1500n);
  assert.equal(iqdToUsdCents(-91000n, 147000), -6190n);
});

test("conversionAgrees accepts the rounded value and nothing else", () => {
  for (const dinars of [250n, 91000n, 91250n, 123250n, 999750n, 12345678n]) {
    for (const rate of [145000, 147000, 152750, 131000]) {
      const cents = iqdToUsdCents(dinars, rate);
      assert.ok(conversionAgrees(dinars, cents, rate), `${dinars} at ${rate}`);
      assert.ok(!conversionAgrees(dinars, cents + 2n, rate), `${dinars} at ${rate} +2`);
      assert.ok(!conversionAgrees(dinars, cents - 2n, rate), `${dinars} at ${rate} -2`);
    }
  }
});

test("the CEO's example: $133 at 1,570 is 208,810 IQD, he takes 209,000, and it counts as $133", () => {
  const rate = rateFromPerDollar(1570);
  assert.equal(usdCentsToIqd(13300n, rate), 208810n);
  assert.equal(roundDinars(208810n), 209000n);
  assert.equal(iqdToUsdCents(209000n, rate), 13312n, "exactly, 209,000 is $133.12");
  assert.ok(dinarsSettle(209000n, rate, 13300n));
  assert.equal(dinarCredit(209000n, rate, [13300n]), 13300n);
});

test("normal rounding: to the nearest 1,000, and half a step goes up", () => {
  const cases: [bigint, bigint][] = [
    [208810n, 209000n], [208499n, 208000n], [208500n, 209000n], [208000n, 208000n], [499n, 0n], [500n, 1000n], [0n, 0n],
  ];
  for (const [dinars, rounded] of cases) assert.equal(roundDinars(dinars), rounded, String(dinars));
  assert.equal(roundDinars(208810n, 250n), 208750n);
  assert.equal(roundDinars(208875n, 250n), 209000n);
  assert.equal(roundDinars(208810n, 0n), 208810n, "a step of 0 switches rounding off");
  assert.equal(roundDinars(-208810n), -209000n);
  assert.throws(() => roundDinars(1000n, -1n), RangeError);
});

test("dinars settle what is owed give or take half a step, and not a dinar further", () => {
  const rate = 157000;                       // $133.00 is 208,810 IQD
  for (const dinars of [208310n, 208500n, 208810n, 209000n, 209310n]) assert.ok(dinarsSettle(dinars, rate, 13300n), String(dinars));
  for (const dinars of [208309n, 208000n, 209311n, 210000n, 1n]) assert.ok(!dinarsSettle(dinars, rate, 13300n), String(dinars));
  // The step is the one from Settings.
  assert.ok(dinarsSettle(208700n, rate, 13300n, 250n));
  assert.ok(!dinarsSettle(208500n, rate, 13300n, 250n));
  // Switched off, only the exact amount settles, and that needs no rounding.
  assert.ok(dinarsSettle(208810n, rate, 13300n, 0n));
  assert.ok(!dinarsSettle(208811n, rate, 13300n, 0n));
  // A customer who owes nothing, or is in credit, is never "settled".
  assert.ok(!dinarsSettle(300n, rate, 0n));
  assert.ok(!dinarsSettle(300n, rate, -13300n));
  assert.throws(() => dinarsSettle(1000n, rate, 100n, -1n), RangeError);
});

test("a dinar payment is worth what it settles, and otherwise exactly what it converts to", () => {
  const rate = 147000;                       // the README's case: $62.00 is 91,140 IQD
  assert.equal(dinarCredit(91000n, rate, [6200n]), 6200n, "140 dinars short still settles $62.00");
  assert.equal(dinarCredit(91250n, rate, [6200n]), 6200n, "110 dinars over settles it, with no credit left");
  assert.equal(dinarCredit(90000n, rate, [6200n]), 6122n, "a part payment is exact");
  assert.equal(dinarCredit(100000n, rate, [6200n]), 6803n, "an overpayment is exact, and the rest is his credit");
  // The consignment the money is for is tried first, then everything he owes.
  assert.equal(dinarCredit(91000n, rate, [6200n, 16200n]), 6200n);
  assert.equal(dinarCredit(238000n, rate, [6200n, 16200n]), 16200n);   // $162.00 is 238,140 IQD
  assert.equal(dinarCredit(150000n, rate, [6200n, 16200n]), 10204n);
  assert.equal(dinarCredit(91000n, rate, []), 6190n);
  assert.equal(dinarCredit(91000n, rate, [6200n], 0n), 6190n, "rounding switched off");
});

test("a rounded payment never moves the account by more than half a step's worth", () => {
  let seed = 7;
  const next = (max: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed >>> 12) % max;
  };
  let settled = 0;
  let exact = 0;
  for (let run = 0; run < 5000; run += 1) {
    const rate = 130000 + next(30000);
    const owed = BigInt(1 + next(300000));
    const exactly = usdCentsToIqd(owed, rate);
    // Around what he owes half the time, anywhere the other half.
    const dinars = run % 2 === 0 ? exactly - 800n + BigInt(next(1600)) : BigInt(250 * (1 + next(4000)));
    if (dinars <= 0n) continue;
    const credit = dinarCredit(dinars, rate, [owed]);
    const worth = iqdToUsdCents(dinars, rate);
    if (credit === worth) {
      exact += 1;
      continue;
    }
    settled += 1;
    assert.equal(credit, owed);
    // Half a step is 500 dinars: at these rates never more than 39 cents.
    const off = credit > worth ? credit - worth : worth - credit;
    assert.ok(off * BigInt(rate) <= 500n * 10000n + BigInt(rate), `${dinars} at ${rate} for ${owed}: off by ${off}`);
    assert.ok(off <= 39n);
  }
  assert.ok(settled > 500 && exact > 500, `${settled} settled, ${exact} exact`);
});

test("impliedRate recovers the rate of an exchange", () => {
  assert.equal(impliedRate(1451000n, 100000n), 145100);
  assert.equal(impliedRate(1000000n, 68900n), 145138);
  assert.throws(() => impliedRate(0n, 100n), RangeError);
});

test("bad rates are refused", () => {
  assert.throws(() => iqdToUsdCents(1000n, 0), RangeError);
  assert.throws(() => iqdToUsdCents(1000n, 1450.5), RangeError);
  assert.throws(() => iqdToUsdCents(1000n, -1), RangeError);
});

test("a day is a Baghdad day", () => {
  // 22:30 UTC on 1 October is 01:30 on 2 October in Baghdad.
  assert.equal(baghdadDay(new Date("2026-10-01T22:30:00Z")), "2026-10-02");
  assert.equal(baghdadDay(new Date("2026-10-01T20:59:59Z")), "2026-10-01");
  assert.equal(baghdadDayStart("2026-10-02").toISOString(), "2026-10-01T21:00:00.000Z");
  assert.throws(() => baghdadDayStart("2 Oct"), TypeError);
});

test("a rate far from the last one is a jump", () => {
  assert.equal(isRateJump(145000, 147250), false);
  assert.equal(isRateJump(145000, 174000), false); // exactly 20%
  assert.equal(isRateJump(145000, 174001), true);
  assert.equal(isRateJump(145000, 1450), true); // typed per dollar instead of per hundred
  assert.equal(isRateJump(145000, 1450000), true);
});
