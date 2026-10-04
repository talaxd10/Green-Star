// What a person types in an amount box, and what he reads back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { iqdToUsdCents as domainIqdToUsd, usdCentsToIqd as domainUsdToIqd } from "@green-star/domain";
import {
  amountForInput,
  countNotes,
  formatMoney,
  formatRate,
  formatRatePerDollar,
  iqdToUsdCents,
  parseAmount,
  parseRate,
  planParts,
  roundDinars,
  usdCentsToIqd,
} from "../src/lib/money.ts";

test("dollars typed any sensible way become cents", () => {
  const cases: [string, number | null][] = [
    ["85", 8500],
    ["85.5", 8550],
    ["85.50", 8550],
    ["85.05", 8505],
    ["0.07", 7],
    [".5", 50],
    ["1,234.56", 123456],
    [" $62 ", 6200],
    ["0", 0],
    ["1234567.89", 123456789],
    ["", null],
    ["   ", null],
    ["85.505", null],
    ["85.", null],
    ["eighty", null],
    ["-5", null],
    ["1e3", null],
    ["1 234.56", 123456],
    // A comma is a thousands mark, never a decimal point. 85,5 is refused, not read as 855.
    ["85,5", null],
    ["1,23", null],
    ["12 34", null],
    ["1,2345", null],
    [",500", null],
    ["85.5.5", null],
  ];
  for (const [typed, cents] of cases) assert.equal(parseAmount(typed, "USD"), cents, `"${typed}"`);
});

test("dinars are whole: no half dinars", () => {
  const cases: [string, number | null][] = [
    ["123250", 123250],
    ["123,250", 123250],
    ["123 250", 123250],
    ["123,250 IQD", 123250],
    ["0", 0],
    ["123250.5", null],
    ["123.250", null],
    ["123,25", null],
    ["1,23,250", null],
    ["1,500,000", 1500000],
    ["", null],
    ["-1000", null],
    ["ten", null],
  ];
  for (const [typed, dinars] of cases) assert.equal(parseAmount(typed, "IQD"), dinars, `"${typed}"`);
});

test("amounts are shown the way he writes them", () => {
  assert.equal(formatMoney(8500, "USD"), "$85.00");
  assert.equal(formatMoney(7, "USD"), "$0.07");
  assert.equal(formatMoney(-50, "USD"), "-$0.50");
  assert.equal(formatMoney(123456789, "USD"), "$1,234,567.89");
  assert.equal(formatMoney(0, "USD"), "$0.00");
  assert.equal(formatMoney(123250, "IQD"), "123,250 IQD");
  assert.equal(formatMoney(-250, "IQD"), "-250 IQD");
});

test("an amount put back into its box parses to the same amount", () => {
  for (const cents of [0, 7, 50, 8500, 8505, 123456789]) {
    assert.equal(parseAmount(amountForInput(cents, "USD"), "USD"), cents);
    assert.equal(parseAmount(formatMoney(cents, "USD"), "USD"), cents);
  }
  for (const dinars of [0, 250, 123250, 50_000_000]) {
    assert.equal(parseAmount(amountForInput(dinars, "IQD"), "IQD"), dinars);
    assert.equal(parseAmount(formatMoney(dinars, "IQD"), "IQD"), dinars);
  }
});

test("the rate reads the way the market quotes it, and per dollar beside it", () => {
  assert.equal(formatRate(145000), "145,000");
  assert.equal(formatRatePerDollar(145000), "1,450");
  assert.equal(formatRatePerDollar(152750), "1,527.5");
  assert.equal(formatRatePerDollar(152775), "1,527.75");
  assert.equal(formatRatePerDollar(152705), "1,527.05");
  assert.equal(parseRate("145,000"), 145000);
  assert.equal(parseRate(" 152750 "), 152750);
  assert.equal(parseRate("1450.5"), null);
  assert.equal(parseRate("0"), null);
  assert.equal(parseRate(""), null);
  assert.equal(parseRate("rate"), null);
});

test("dinars convert exactly as the database and the domain package do", () => {
  assert.equal(iqdToUsdCents(123250, 145000), 8500);
  assert.equal(usdCentsToIqd(6200, 147000), 91140);
  let seed = 20261003;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) >>> 8;
  for (let i = 0; i < 2000; i += 1) {
    const dinars = next() % 50_000_000;
    const cents = next() % 5_000_000;
    const rate = 100_000 + (next() % 100_000);
    assert.equal(iqdToUsdCents(dinars, rate), Number(domainIqdToUsd(BigInt(dinars), rate)));
    assert.equal(usdCentsToIqd(cents, rate), Number(domainUsdToIqd(BigInt(cents), rate)));
  }
});

test("a count of notes adds up", () => {
  assert.equal(countNotes({ 10000: 3, 5000: 1 }), 35000);
  assert.equal(countNotes({ 25000: 4, 10000: 2, 1000: 3, 250: 1 }), 123250);
  assert.equal(countNotes({}), 0);
});

test("what a payment in parts will do is shown before it is saved, in the order the parts were typed", () => {
  // The CEO's example: he owes $533, pays 209,000 IQD and $400. Typed dinars first.
  const plan = planParts([{ amount: 209000, currency: "IQD" }, { amount: 40000, currency: "USD" }], { iqdPer100Usd: 157000, owedUsdCents: 53300, stepIqd: 1000 });
  assert.deepEqual(plan, { credited: [13300, 40000], exact: [13312, 40000], total: 53300, left: 0 });

  // Not rounded: a part payment, and with rounding switched off.
  assert.deepEqual(planParts([{ amount: 150000, currency: "IQD" }], { iqdPer100Usd: 157000, owedUsdCents: 53300, stepIqd: 1000 }), { credited: [9554], exact: [9554], total: 9554, left: 43746 });
  assert.equal(planParts([{ amount: 209000, currency: "IQD" }], { iqdPer100Usd: 157000, owedUsdCents: 13300, stepIqd: 0 })?.left, -12);
  // For one consignment while he owes more.
  assert.deepEqual(planParts([{ amount: 97000, currency: "IQD" }], { iqdPer100Usd: 157000, owedUsdCents: 16200, owedForConsignmentUsdCents: 6200, stepIqd: 1000 })?.credited, [6200]);

  // Nothing to show yet: no parts, an empty amount, or dinars with no rate today.
  assert.equal(planParts([], { iqdPer100Usd: 157000, owedUsdCents: 100, stepIqd: 1000 }), null);
  assert.equal(planParts([{ amount: 0, currency: "USD" }], { iqdPer100Usd: 157000, owedUsdCents: 100, stepIqd: 1000 }), null);
  assert.equal(planParts([{ amount: 1000, currency: "IQD" }], { iqdPer100Usd: null, owedUsdCents: 100, stepIqd: 1000 }), null);
  assert.deepEqual(planParts([{ amount: 100, currency: "USD" }], { iqdPer100Usd: null, owedUsdCents: 100, stepIqd: 1000 })?.left, 0, "dollars need no rate");
});

test("dinars are rounded to the step in Settings", () => {
  assert.equal(roundDinars(208810, 1000), 209000);
  assert.equal(roundDinars(192850, 1000), 193000);
  assert.equal(roundDinars(192499, 1000), 192000);
  assert.equal(roundDinars(192850, 250), 192750);
  assert.equal(roundDinars(192850, 0), 192850);
});
