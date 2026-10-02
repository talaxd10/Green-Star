import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baghdadDay,
  baghdadDayStart,
  conversionAgrees,
  impliedRate,
  iqdToUsdCents,
  rateFromPerDollar,
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
