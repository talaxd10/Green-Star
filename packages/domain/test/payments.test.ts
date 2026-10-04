import { test } from "node:test";
import assert from "node:assert/strict";
import { iqd, iqdToUsdCents, planPayment, usd, usdCentsToIqd } from "../src/index.ts";

const RATE = 157000;   // 1,570 per dollar

const brief = (plan: ReturnType<typeof planPayment>) => plan.parts.map((p) => `${p.index}:${p.received.currency}:${p.creditUsdCents}`).join(" ");

test("the CEO's example: $400 and 209,000 IQD pay $533, whichever is typed first", () => {
  for (const parts of [[usd(40000n), iqd(209000n)], [iqd(209000n), usd(40000n)]]) {
    const plan = planPayment(parts, { ratePer100: RATE, owedUsdCents: 53300n });
    assert.deepEqual(plan.parts.map((p) => [p.received.currency, p.creditUsdCents, p.exactUsdCents]), [["USD", 40000n, 40000n], ["IQD", 13300n, 13312n]]);
    assert.equal(plan.creditUsdCents, 53300n);
    assert.equal(plan.leftUsdCents, 0n);
  }
  // Each part keeps the place it was typed in, so the caller can match them up.
  assert.equal(brief(planPayment([iqd(209000n), usd(40000n)], { ratePer100: RATE, owedUsdCents: 53300n })), "1:USD:40000 0:IQD:13300");
});

test("dollars, dinars and a wallet in dinars: each dinar part is exact until one settles what is left", () => {
  // $533: $300 in dollars, 100,000 IQD ($63.69), then 266,000 IQD for the $169.31 that is left (265,817 exactly).
  const plan = planPayment([usd(20000n), iqd(100000n), usd(10000n), iqd(266000n)], { ratePer100: RATE, owedUsdCents: 53300n });
  assert.equal(brief(plan), "0:USD:20000 2:USD:10000 1:IQD:6369 3:IQD:16931");
  assert.equal(plan.leftUsdCents, 0n);
  assert.equal(usdCentsToIqd(16931n, RATE), 265817n);
});

test("a part payment, an overpayment and a customer who owes nothing are exact", () => {
  assert.equal(planPayment([iqd(150000n)], { ratePer100: RATE, owedUsdCents: 53300n }).leftUsdCents, 53300n - 9554n);
  const over = planPayment([usd(40000n), iqd(250000n)], { ratePer100: RATE, owedUsdCents: 53300n });
  assert.deepEqual([over.creditUsdCents, over.leftUsdCents], [40000n + 15924n, -2624n]);
  const nothing = planPayment([iqd(209000n)], { ratePer100: RATE, owedUsdCents: 0n });
  assert.deepEqual([nothing.creditUsdCents, nothing.leftUsdCents], [13312n, -13312n]);
  const credit = planPayment([iqd(209000n)], { ratePer100: RATE, owedUsdCents: -5000n });
  assert.equal(credit.leftUsdCents, -5000n - 13312n);
  // Dollars are never rounded: ten cents short stays ten cents.
  assert.equal(planPayment([usd(53290n)], { owedUsdCents: 53300n }).leftUsdCents, 10n);
});

test("money for one consignment settles that one first, then everything he owes", () => {
  // He owes $62.00 on today's goods and $100.00 on an older file.
  const today = planPayment([iqd(97000n)], { ratePer100: RATE, owedUsdCents: 16200n, owedForConsignmentUsdCents: 6200n });   // $62.00 is 97,340
  assert.deepEqual([today.creditUsdCents, today.leftUsdCents], [6200n, 10000n]);
  const all = planPayment([iqd(254000n)], { ratePer100: RATE, owedUsdCents: 16200n, owedForConsignmentUsdCents: 6200n });    // $162.00 is 254,340
  assert.deepEqual([all.creditUsdCents, all.leftUsdCents], [16200n, 0n]);
  // Dollars first pay the consignment down; the dinars then settle what is left of it.
  const mixed = planPayment([iqd(50000n), usd(3000n)], { ratePer100: RATE, owedUsdCents: 16200n, owedForConsignmentUsdCents: 6200n });  // $32.00 is 50,240
  assert.equal(brief(mixed), "1:USD:3000 0:IQD:3200");
  assert.equal(mixed.leftUsdCents, 10000n);
  // $62.00 on today's goods and 30 cents from before: 90,300 dinars ($62.28 at 1,450) is nearer to everything, and settles everything.
  const both = planPayment([iqd(90300n)], { ratePer100: 145000, owedUsdCents: 6230n, owedForConsignmentUsdCents: 6200n });
  assert.deepEqual([both.creditUsdCents, both.leftUsdCents], [6230n, 0n]);
  // 89,950 is nearer to the goods alone (89,900) than to everything (90,335): the 30 cents stay owed.
  const goods = planPayment([iqd(89950n)], { ratePer100: 145000, owedUsdCents: 6230n, owedForConsignmentUsdCents: 6200n });
  assert.deepEqual([goods.creditUsdCents, goods.leftUsdCents], [6200n, 30n]);
  // Dollars that more than pay the consignment leave nothing of it to settle; the dinars are then measured against everything.
  const beyond = planPayment([usd(7000n), iqd(144000n)], { ratePer100: RATE, owedUsdCents: 16200n, owedForConsignmentUsdCents: 6200n });  // $92.00 is 144,440
  assert.deepEqual([beyond.creditUsdCents, beyond.leftUsdCents], [16200n, 0n]);
});

test("the rounding step is the one given, and 0 switches it off", () => {
  const options = { ratePer100: RATE, owedUsdCents: 13300n };
  assert.equal(planPayment([iqd(209000n)], options).creditUsdCents, 13300n);
  assert.equal(planPayment([iqd(209000n)], { ...options, stepIqd: 250n }).creditUsdCents, 13312n);
  assert.equal(planPayment([iqd(208750n)], { ...options, stepIqd: 250n }).creditUsdCents, 13300n);
  assert.equal(planPayment([iqd(209000n)], { ...options, stepIqd: 0n }).creditUsdCents, 13312n);
});

test("what cannot be a payment is refused", () => {
  assert.throws(() => planPayment([], { owedUsdCents: 100n }), RangeError);
  assert.throws(() => planPayment([usd(0n)], { owedUsdCents: 100n }), RangeError);
  assert.throws(() => planPayment([usd(100n), iqd(-5n)], { ratePer100: RATE, owedUsdCents: 100n }), RangeError);
  assert.throws(() => planPayment([iqd(1000n)], { owedUsdCents: 100n }), /rate_missing/);
  // Dollars alone need no rate.
  assert.equal(planPayment([usd(100n)], { owedUsdCents: 100n }).leftUsdCents, 0n);
});

test("whatever is paid, the credits add up and no part is rounded by more than half a step's worth", () => {
  let seed = 99;
  const next = (max: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed >>> 12) % max;
  };
  let rounded = 0;
  for (let run = 0; run < 3000; run += 1) {
    const rate = 130000 + next(30000);
    const owed = BigInt(next(400000)) - 20000n;
    const count = 1 + next(4);
    let left = owed;
    const parts = Array.from({ length: count }, (_, i) => {
      const dinars = next(2) === 0;
      // The last part is often about what is left, the way a customer pays.
      const about = i === count - 1 && left > 0n && next(3) > 0;
      if (dinars) {
        const amount = about ? usdCentsToIqd(left, rate) - 600n + BigInt(next(1200)) : BigInt(250 * (1 + next(2000)));
        const part = iqd(amount > 0n ? amount : 250n);
        left -= iqdToUsdCents(part.amount, rate);
        return part;
      }
      const part = usd(about ? left : BigInt(1 + next(200000)));
      left -= part.amount;
      return part;
    });
    const plan = planPayment(parts, { ratePer100: rate, owedUsdCents: owed });
    assert.equal(plan.parts.length, parts.length);
    assert.deepEqual([...plan.parts.map((p) => p.index)].sort(), parts.map((_, i) => i));
    assert.equal(plan.creditUsdCents, plan.parts.reduce((sum, p) => sum + p.creditUsdCents, 0n));
    assert.equal(plan.leftUsdCents, owed - plan.creditUsdCents);
    // Dollars come before dinars.
    const firstDinar = plan.parts.findIndex((p) => p.received.currency === "IQD");
    if (firstDinar !== -1) assert.ok(plan.parts.slice(firstDinar).every((p) => p.received.currency === "IQD"));
    for (const part of plan.parts) {
      if (part.received.currency === "USD") assert.equal(part.creditUsdCents, part.received.amount);
      if (part.creditUsdCents === part.exactUsdCents) continue;
      rounded += 1;
      const off = part.creditUsdCents > part.exactUsdCents ? part.creditUsdCents - part.exactUsdCents : part.exactUsdCents - part.creditUsdCents;
      assert.ok(off <= 39n, `rounded by ${off} cents`);
    }
  }
  assert.ok(rounded > 200, `only ${rounded} parts were rounded`);
});
