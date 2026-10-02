import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateOldestFirst } from "../src/index.ts";

const open = [
  { id: "file-3", remainingUsdCents: 6200n, confirmedAt: new Date("2026-09-20T09:00:00Z") },
  { id: "file-1", remainingUsdCents: 4000n, confirmedAt: new Date("2026-09-01T09:00:00Z") },
  { id: "file-2", remainingUsdCents: 8500n, confirmedAt: new Date("2026-09-10T09:00:00Z") },
];

test("the late payer from three files ago clears the oldest file first", () => {
  const result = allocateOldestFirst(10000n, open);
  assert.deepEqual(result.allocations, [
    { consignmentId: "file-1", amountUsdCents: 4000n },
    { consignmentId: "file-2", amountUsdCents: 6000n },
  ]);
  assert.equal(result.unappliedUsdCents, 0n);
});

test("money left after everything is paid stays as credit", () => {
  const result = allocateOldestFirst(20000n, open);
  assert.equal(result.allocations.length, 3);
  assert.equal(result.unappliedUsdCents, 1300n);
});

test("allocations never exceed the payment or what is owed", () => {
  let seed = 7;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let run = 0; run < 500; run++) {
    const list = Array.from({ length: next(6) }, (_, i) => ({
      id: `c${i}`,
      remainingUsdCents: BigInt(next(20000)),
      confirmedAt: new Date(Date.UTC(2026, 8, 1 + next(28))),
    }));
    const payment = BigInt(next(50000));
    const { allocations, unappliedUsdCents } = allocateOldestFirst(payment, list);
    const applied = allocations.reduce((sum, a) => sum + a.amountUsdCents, 0n);
    assert.equal(applied + unappliedUsdCents, payment);
    for (const a of allocations) {
      const owed = list.find((c) => c.id === a.consignmentId)!.remainingUsdCents;
      assert.ok(a.amountUsdCents > 0n && a.amountUsdCents <= owed);
    }
    const owedTotal = list.reduce((sum, c) => sum + c.remainingUsdCents, 0n);
    assert.equal(applied, payment < owedTotal ? payment : owedTotal);
  }
});

test("a negative payment is refused and paid consignments are skipped", () => {
  assert.throws(() => allocateOldestFirst(-1n, open), RangeError);
  const result = allocateOldestFirst(500n, [{ id: "paid", remainingUsdCents: 0n, confirmedAt: new Date(0) }]);
  assert.deepEqual(result, { allocations: [], unappliedUsdCents: 500n });
});
