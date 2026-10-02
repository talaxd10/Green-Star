import { test } from "node:test";
import assert from "node:assert/strict";
import { add, format, fromJson, iqd, money, subtract, toJson, usd } from "../src/index.ts";

test("money is whole numbers in the smallest unit", () => {
  assert.deepEqual(usd(8500), { amount: 8500n, currency: "USD" });
  assert.deepEqual(iqd(123250), { amount: 123250n, currency: "IQD" });
  assert.throws(() => money(85.5, "USD"), RangeError);
  assert.throws(() => money(Number.NaN, "IQD"), RangeError);
});

test("money never mixes currencies", () => {
  assert.deepEqual(add(usd(100), usd(250)), usd(350));
  assert.deepEqual(subtract(iqd(1000), iqd(250)), iqd(750));
  assert.throws(() => add(usd(100), iqd(100)), TypeError);
});

test("money formats for screens", () => {
  assert.equal(format(usd(8500)), "$85.00");
  assert.equal(format(usd(-7)), "-$0.07");
  assert.equal(format(usd(123456789)), "$1,234,567.89");
  assert.equal(format(iqd(123250)), "123,250 IQD");
  assert.equal(format(iqd(-500)), "-500 IQD");
});

test("money round-trips through the API shape", () => {
  assert.deepEqual(toJson(usd(8500)), { amount: 8500, currency: "USD" });
  assert.deepEqual(fromJson({ amount: 123250, currency: "IQD" }), iqd(123250));
  assert.throws(() => fromJson({ amount: 1, currency: "EUR" as never }), TypeError);
});
