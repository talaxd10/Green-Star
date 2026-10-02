import { test } from "node:test";
import assert from "node:assert/strict";
import { assessCharge, freightFromWeight, markHasPrefix, normalizeMark, normalizePhone } from "../src/index.ts";

test("Iraqi phone numbers are stored one way however they are typed", () => {
  for (const typed of [
    "+964 770 123 4567",
    "+9647701234567",
    "00964 770 123 4567",
    "9647701234567",
    "0770 123 4567",
    "0770-123-4567",
    "770 123 4567",
    " (0770) 1234567 ",
  ]) {
    assert.equal(normalizePhone(typed), "+9647701234567", typed);
  }
});

test("numbers that cannot be a phone are refused", () => {
  for (const typed of ["", "12345", "0770 123 456", "0770 123 45678", "+964 770 123 456", "abc"]) {
    assert.equal(normalizePhone(typed), null, typed);
  }
});

test("a foreign number keeps its own country code", () => {
  assert.equal(normalizePhone("+86 138 0013 8000"), "+8613800138000");
  assert.equal(normalizePhone("0090 532 123 45 67"), "+905321234567");
});

test("marks are upper case with single spaces", () => {
  assert.equal(normalizeMark("  yaro   mhamad "), "YARO MHAMAD");
  assert.equal(normalizeMark("Dara\tM"), "DARA M");
});

test("a prefix mark matches whole words only", () => {
  assert.ok(markHasPrefix("YARO", "yaro"));
  assert.ok(markHasPrefix("Yaro Mhamad", "YARO"));
  assert.ok(markHasPrefix("YARO-OSMAN", "YARO"));
  assert.ok(markHasPrefix("YARO/2", "YARO"));
  assert.ok(!markHasPrefix("YAROSLAV", "YARO"));
  assert.ok(!markHasPrefix("YARO2", "YARO"));
  assert.ok(!markHasPrefix("MR YARO", "YARO"));
  assert.ok(!markHasPrefix("YARO", ""));
});

test("the amount to collect is the truth", () => {
  // Exactly freight + packing + customs.
  assert.deepEqual(assessCharge({ collectUsdCents: 8500n, freightUsdCents: 7000n, packingUsdCents: 500n, customsUsdCents: 1000n }), {
    amountDueUsdCents: 8500n,
    expectedUsdCents: 8500n,
    otherChargesUsdCents: 0n,
    prepaid: false,
    undercharged: false,
    shortByUsdCents: 0n,
  });
  // More: the extra is other charges, such as buying the item.
  const more = assessCharge({ collectUsdCents: 31000n, freightUsdCents: 7000n, packingUsdCents: 500n, customsUsdCents: 1000n });
  assert.equal(more.otherChargesUsdCents, 22500n);
  assert.equal(more.undercharged, false);
  // Less: flagged.
  const less = assessCharge({ collectUsdCents: 6200n, freightUsdCents: 7000n, packingUsdCents: 500n, customsUsdCents: 1000n });
  assert.equal(less.undercharged, true);
  assert.equal(less.shortByUsdCents, 2300n);
  assert.equal(less.amountDueUsdCents, 6200n);
  // $0: prepaid, never flagged.
  const prepaid = assessCharge({ collectUsdCents: 0n, freightUsdCents: 7000n, packingUsdCents: 500n, customsUsdCents: 1000n });
  assert.equal(prepaid.prepaid, true);
  assert.equal(prepaid.undercharged, false);
  assert.throws(() => assessCharge({ collectUsdCents: -1n, freightUsdCents: 0n, packingUsdCents: 0n, customsUsdCents: 0n }), RangeError);
});

test("freight is weight times price per kilo, to the cent", () => {
  assert.equal(freightFromWeight(12500n, 560n), 7000n); // 12.5 kg at $5.60
  assert.equal(freightFromWeight(333n, 1000n), 333n); // 0.333 kg at $10.00 is $3.33
  assert.equal(freightFromWeight(1n, 500n), 1n); // half a cent rounds up
  assert.equal(freightFromWeight(0n, 500n), 0n);
});
