import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOTES,
  checkCash,
  checkRoundResult,
  countNotes,
  deliveryStatus,
  expectedInVault,
  iqd,
  isMissedCollection,
  notesFor,
  usd,
  type RoundResultInput,
} from "../src/index.ts";

const payFirst: Omit<RoundResultInput, "outcome"> = { trust: "pay_first", amountDueUsdCents: 8500n, remainingUsdCents: 8500n };
const trusted: Omit<RoundResultInput, "outcome"> = { ...payFirst, trust: "trusted" };
const prepaid: Omit<RoundResultInput, "outcome"> = { trust: "pay_first", amountDueUsdCents: 0n, remainingUsdCents: 0n };
const cash = { received: usd(8500), method: "driver_cash" } as const;

test("goods go on account only for a trusted customer", () => {
  assert.equal(checkRoundResult({ ...trusted, outcome: "on_account" }), null);
  assert.equal(checkRoundResult({ ...trusted, outcome: "on_account", received: usd(1000), method: "fib" }), null);
  assert.equal(checkRoundResult({ ...payFirst, outcome: "on_account" }), "not_trusted");
  assert.equal(checkRoundResult({ ...trusted, outcome: "unpaid" }), "outcome_invalid");
  assert.equal(checkRoundResult({ ...payFirst, outcome: "unpaid" }), null);
});

test("paid needs money unless it was already paid", () => {
  assert.equal(checkRoundResult({ ...payFirst, outcome: "paid" }), "payment_missing");
  assert.equal(checkRoundResult({ ...payFirst, outcome: "paid", ...cash }), null);
  assert.equal(checkRoundResult({ ...payFirst, remainingUsdCents: 0n, outcome: "paid" }), null);
  assert.equal(checkRoundResult({ ...payFirst, outcome: "paid", received: iqd(123250), method: "driver_cash" }), null);
  assert.equal(checkRoundResult({ ...payFirst, outcome: "paid", received: usd(0), method: "driver_cash" }), "amount_invalid");
  assert.equal(checkRoundResult({ ...payFirst, outcome: "paid", received: usd(8500) }), "payment_incomplete");
  assert.equal(checkRoundResult({ ...payFirst, outcome: "paid", method: "fib" }), "payment_incomplete");
});

test("held goods take no money, and prepaid has nothing to collect", () => {
  assert.equal(checkRoundResult({ ...payFirst, outcome: "held" }), null);
  assert.equal(checkRoundResult({ ...payFirst, outcome: "held", ...cash }), "outcome_invalid");
  assert.equal(checkRoundResult({ ...payFirst, outcome: "prepaid" }), "outcome_invalid");
  assert.equal(checkRoundResult({ ...prepaid, outcome: "prepaid" }), null);
  assert.equal(checkRoundResult({ ...prepaid, outcome: "held" }), null);
  assert.equal(checkRoundResult({ ...prepaid, outcome: "prepaid", ...cash }), "outcome_invalid");
  assert.equal(checkRoundResult({ ...prepaid, outcome: "paid", ...cash }), "outcome_invalid");
  assert.equal(checkRoundResult({ ...prepaid, outcome: "unpaid" }), "outcome_invalid");
});

test("the driver forgot to collect: pay first, delivered, still owing, not allowed", () => {
  const base = { outcome: "unpaid", trust: "pay_first", remainingAfterUsdCents: 6200n, hasException: false } as const;
  assert.equal(isMissedCollection(base), true);
  assert.equal(isMissedCollection({ ...base, outcome: "paid", remainingAfterUsdCents: 10n }), true); // paid short
  assert.equal(isMissedCollection({ ...base, hasException: true }), false);
  assert.equal(isMissedCollection({ ...base, remainingAfterUsdCents: 0n }), false);
  assert.equal(isMissedCollection({ ...base, outcome: "held" }), false);
  assert.equal(isMissedCollection({ ...base, outcome: "on_account", trust: "trusted" }), false);
  // A trusted customer who paid part is on account, whatever word was picked.
  assert.equal(isMissedCollection({ ...base, outcome: "paid", trust: "trusted", remainingAfterUsdCents: 10n }), false);
});

test("after delivery the status follows what is owed, not the word that was picked", () => {
  const base = { amountDueUsdCents: 8500n, remainingUsdCents: 0n, roundHandedIn: false } as const;
  assert.equal(deliveryStatus({ ...base, outcome: "held", trust: "pay_first", remainingUsdCents: 8500n }), "held");
  assert.equal(deliveryStatus({ ...base, outcome: "paid", trust: "pay_first" }), "delivered_paid");
  assert.equal(deliveryStatus({ ...base, outcome: "paid", trust: "pay_first", roundHandedIn: true }), "closed");
  assert.equal(deliveryStatus({ ...base, outcome: "prepaid", trust: "pay_first", amountDueUsdCents: 0n }), "delivered_prepaid");
  // Paid short: a trusted customer goes on account, a pay-first customer is not paid.
  assert.equal(deliveryStatus({ ...base, outcome: "paid", trust: "trusted", remainingUsdCents: 10n }), "delivered_on_account");
  assert.equal(deliveryStatus({ ...base, outcome: "paid", trust: "pay_first", remainingUsdCents: 10n }), "delivered_not_paid");
  assert.equal(deliveryStatus({ ...base, outcome: "paid", trust: "pay_first", remainingUsdCents: 10n, roundHandedIn: true }), "delivered_not_paid");
  // On account and then paid in full: it closes like any other.
  assert.equal(deliveryStatus({ ...base, outcome: "on_account", trust: "trusted", roundHandedIn: true }), "closed");
});

test("the board's hand-in: 123,250 IQD counted note by note", () => {
  assert.equal(countNotes("IQD", { 50000: 2, 10000: 2, 1000: 3, 250: 1 }), 123250n);
  assert.equal(countNotes("USD", { 10000: 1, 5000: 1 }), 15000n); // one $100 and one $50
  assert.equal(countNotes("USD", {}), 0n);
  assert.deepEqual(checkCash("USD", 20000n, { 10000: 1, 5000: 1 }), { expected: 20000n, counted: 15000n, difference: -5000n });
});

test("a typo cannot become money", () => {
  assert.throws(() => countNotes("IQD", { 300: 1 }), /no IQD note of 300/);
  assert.throws(() => countNotes("USD", { 250: 1 }), /no USD note of 250/);
  assert.throws(() => countNotes("USD", { "10000.0": 1 }), /no USD note/);
  assert.throws(() => countNotes("USD", { 10000: 1.5 }), /whole number/);
  assert.throws(() => countNotes("USD", { 10000: -1 }), /whole number/);
});

test("notesFor makes any countable amount and counts back to it", () => {
  assert.deepEqual(notesFor("IQD", 123250n), { 50000: 2, 10000: 2, 1000: 3, 250: 1 });
  assert.deepEqual(notesFor("USD", 0n), {});
  assert.throws(() => notesFor("USD", 8550n), /cannot be made from notes/); // $85.50
  assert.throws(() => notesFor("IQD", 123300n), /cannot be made from notes/);
  let seed = 99;
  const next = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let i = 0; i < 300; i++) {
    const dollars = BigInt(next(5000)) * 100n;
    const dinars = BigInt(next(8000)) * 250n;
    assert.equal(countNotes("USD", notesFor("USD", dollars)), dollars);
    assert.equal(countNotes("IQD", notesFor("IQD", dinars)), dinars);
  }
  // Largest first, so the greedy count is the fewest notes.
  for (const values of Object.values(NOTES)) {
    assert.deepEqual([...values], [...values].sort((a, b) => (a < b ? 1 : -1)));
  }
});

test("expected vault cash is the ledger plus the gaps already noted", () => {
  assert.equal(expectedInVault(100000n, []), 100000n);
  // Short by $50 on Monday, found on Tuesday.
  assert.equal(expectedInVault(100000n, [-5000n]), 95000n);
  assert.equal(expectedInVault(100000n, [-5000n, 5000n]), 100000n);
});
