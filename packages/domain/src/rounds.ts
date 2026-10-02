// Rounds: what can happen at a stop, and counting cash note by note.
//
// The database enforces the same rules (gs_enter_round_result, gs_count_notes).
// These are here so a screen can say what is wrong before anything is sent.

import type { Currency, Money } from "./money.ts";

export type Trust = "trusted" | "pay_first";

/**
 * paid        goods handed over and money received (or already paid before)
 * on_account  goods handed over to a trusted customer; what is unpaid goes on his account
 * prepaid     goods handed over, nothing to collect ($0 on the file)
 * held        goods stay in the car; no money
 * unpaid      goods handed over to a pay-first customer without full payment
 */
export type RoundOutcome = "paid" | "on_account" | "prepaid" | "held" | "unpaid";

export const ROUND_OUTCOMES: readonly RoundOutcome[] = ["paid", "on_account", "prepaid", "held", "unpaid"];

/** How money can be taken on a round. Cash at the office is not one of them. */
export type RoundMethod = "driver_cash" | "fib" | "fastpay" | "zaincash";

export const ROUND_METHODS: readonly RoundMethod[] = ["driver_cash", "fib", "fastpay", "zaincash"];

export interface RoundResultInput {
  outcome: RoundOutcome;
  /** The customer's trust today, not when the file was confirmed. */
  trust: Trust;
  /** The file's money to collect. Zero means prepaid. */
  amountDueUsdCents: bigint;
  /** What is still owed on this consignment before this result. */
  remainingUsdCents: bigint;
  received?: Money;
  method?: RoundMethod;
}

export type RoundResultProblem =
  | "payment_incomplete"
  | "amount_invalid"
  | "outcome_invalid"
  | "not_trusted"
  | "payment_missing";

/** The first thing wrong with a result, or null when it can be entered. */
export function checkRoundResult(input: RoundResultInput): RoundResultProblem | null {
  const { outcome, received, method } = input;
  if ((received === undefined) !== (method === undefined)) return "payment_incomplete";
  if (received !== undefined && received.amount <= 0n) return "amount_invalid";

  const prepaid = input.amountDueUsdCents === 0n;
  if (prepaid && outcome !== "prepaid" && outcome !== "held") return "outcome_invalid";

  switch (outcome) {
    case "prepaid":
      return !prepaid || received !== undefined ? "outcome_invalid" : null;
    case "held":
      return received !== undefined ? "outcome_invalid" : null;
    case "on_account":
      return input.trust === "trusted" ? null : "not_trusted";
    case "unpaid":
      return input.trust === "pay_first" ? null : "outcome_invalid";
    case "paid":
      return received === undefined && input.remainingUsdCents > 0n ? "payment_missing" : null;
  }
}

/**
 * True when this result means the driver forgot to collect: a pay-first
 * customer has the goods, still owes on them, and nobody allowed it.
 */
export function isMissedCollection(input: {
  outcome: RoundOutcome;
  trust: Trust;
  remainingAfterUsdCents: bigint;
  hasException: boolean;
}): boolean {
  return (
    input.outcome !== "held" &&
    input.trust === "pay_first" &&
    input.remainingAfterUsdCents > 0n &&
    !input.hasException
  );
}

export type DeliveryStatus =
  | "held"
  | "delivered_paid"
  | "delivered_prepaid"
  | "delivered_on_account"
  | "delivered_not_paid"
  | "closed";

/**
 * Where a consignment stands once its stop has a result. After the goods are
 * handed over, the status follows what is owed, not the word picked on the
 * screen. The database works it out the same way (gs_derived_consignment_status).
 */
export function deliveryStatus(input: {
  outcome: RoundOutcome;
  /** The customer's trust when the result was entered. */
  trust: Trust;
  amountDueUsdCents: bigint;
  remainingUsdCents: bigint;
  roundHandedIn: boolean;
}): DeliveryStatus {
  if (input.outcome === "held") return "held";
  if (input.remainingUsdCents === 0n) {
    if (input.roundHandedIn) return "closed";
    return input.amountDueUsdCents === 0n ? "delivered_prepaid" : "delivered_paid";
  }
  return input.trust === "trusted" ? "delivered_on_account" : "delivered_not_paid";
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * The notes in use, largest first, in the ledger's unit: cents for dollars,
 * whole dinars for dinars. A $100 note is 10000n. The database keeps the same
 * list in cash_denominations.
 */
export const NOTES: Readonly<Record<Currency, readonly bigint[]>> = {
  USD: [10000n, 5000n, 2000n, 1000n, 500n, 200n, 100n],
  IQD: [50000n, 25000n, 10000n, 5000n, 1000n, 500n, 250n],
};

/** Note value -> how many. { "10000": 3, "5000": 1 } is three $100 notes and one $50. */
export type NoteCount = Record<string, number>;

/** Adds up a count. Refuses a note that does not exist and a count that is not a whole number. */
export function countNotes(currency: Currency, notes: NoteCount): bigint {
  let total = 0n;
  for (const [key, count] of Object.entries(notes)) {
    if (!/^\d+$/.test(key) || !NOTES[currency].includes(BigInt(key))) {
      throw new RangeError(`there is no ${currency} note of ${key}`);
    }
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError(`how many ${currency} notes of ${key} must be a whole number, got ${count}`);
    }
    total += BigInt(key) * BigInt(count);
  }
  return total;
}

/** The fewest notes that make an amount. Throws when notes cannot make it. */
export function notesFor(currency: Currency, amount: bigint): NoteCount {
  if (amount < 0n) throw new RangeError("an amount to count cannot be negative");
  const notes: NoteCount = {};
  let left = amount;
  for (const value of NOTES[currency]) {
    const count = left / value;
    if (count > 0n) {
      notes[value.toString()] = Number(count);
      left -= count * value;
    }
  }
  if (left !== 0n) {
    throw new RangeError(`${amount} ${currency} cannot be made from notes: ${left} is left over`);
  }
  return notes;
}

export interface CashCheck {
  expected: bigint;
  counted: bigint;
  /** Counted minus expected. Negative is short. */
  difference: bigint;
}

/** Compares a count with what the receipts say. Any difference needs a note. */
export function checkCash(currency: Currency, expected: bigint, notes: NoteCount): CashCheck {
  const counted = countNotes(currency, notes);
  return { expected, counted, difference: counted - expected };
}

/**
 * What should be in the vault: what the ledger says, plus every gap already
 * found and noted at an earlier close. The same as "the last count plus
 * everything entered since".
 */
export function expectedInVault(ledgerBalance: bigint, noteGapsSoFar: readonly bigint[]): bigint {
  return noteGapsSoFar.reduce((sum, gap) => sum + gap, ledgerBalance);
}
