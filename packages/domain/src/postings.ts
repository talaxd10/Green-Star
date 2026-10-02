// The lines each money event posts to the ledger.
//
// Every builder returns a draft whose lines sum to zero in each currency.
// A positive amount is "goes up" for money held or owed to us; a negative
// amount is "goes down". Money owed to the China office is a negative balance.

import { iqdToUsdCents, assertRate, impliedRate } from "./fx.ts";
import type { Currency, Money } from "./money.ts";

export type EntryKind =
  | "file_confirmed"
  | "driver_collected"
  | "round_handed_in"
  | "office_payment"
  | "wallet_payment"
  | "sent_to_china"
  | "cash_out"
  | "currency_exchange";

export type Wallet = "fib" | "fastpay" | "zaincash";

export type ExpenseCategory = "driver_pay" | "fuel_car" | "customs_airport" | "rent_salaries" | "other";

export const WALLETS: readonly Wallet[] = ["fib", "fastpay", "zaincash"];

export const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  "driver_pay",
  "fuel_car",
  "customs_airport",
  "rent_salaries",
  "other",
];

export type AccountRef =
  | { type: "system"; code: string }
  | { type: "customer"; customerId: string }
  | { type: "driver_cash"; roundId: string; currency: Currency };

export interface DraftLine {
  account: AccountRef;
  currency: Currency;
  amount: bigint;
}

export interface EntryDraft {
  kind: EntryKind;
  lines: DraftLine[];
  /** Dinars per 100 dollars. Present only when the entry converts currency. */
  ratePer100?: number;
  reason?: string;
}

const lower = (c: Currency) => c.toLowerCase();

export const account = {
  vault: (currency: Currency): AccountRef => ({ type: "system", code: `vault_${lower(currency)}` }),
  wallet: (wallet: Wallet, currency: Currency): AccountRef => ({
    type: "system",
    code: `wallet_${wallet}_${lower(currency)}`,
  }),
  expense: (category: ExpenseCategory, currency: Currency): AccountRef => ({
    type: "system",
    code: `expense_${category}_${lower(currency)}`,
  }),
  exchangeClearing: (currency: Currency): AccountRef => ({
    type: "system",
    code: `exchange_clearing_${lower(currency)}`,
  }),
  chinaPayable: (): AccountRef => ({ type: "system", code: "china_payable" }),
  customer: (customerId: string): AccountRef => ({ type: "customer", customerId }),
  driverCash: (roundId: string, currency: Currency): AccountRef => ({ type: "driver_cash", roundId, currency }),
};

function positive(amount: bigint, what: string): void {
  if (amount <= 0n) {
    throw new RangeError(`${what} must be more than zero`);
  }
}

/** Throws unless the lines sum to zero in each currency. */
export function assertBalanced(lines: readonly DraftLine[]): void {
  if (lines.length < 2) {
    throw new Error("an entry needs at least two lines");
  }
  const totals = new Map<Currency, bigint>();
  for (const line of lines) {
    if (line.amount === 0n) {
      throw new Error("a line cannot be zero");
    }
    totals.set(line.currency, (totals.get(line.currency) ?? 0n) + line.amount);
  }
  for (const [currency, total] of totals) {
    if (total !== 0n) {
      throw new Error(`entry does not balance: ${currency} is off by ${total}`);
    }
  }
}

function draft(kind: EntryKind, lines: DraftLine[], extra: { ratePer100?: number; reason?: string } = {}): EntryDraft {
  assertBalanced(lines);
  return { kind, lines, ...extra };
}

/**
 * Money arriving for a customer. In dollars it goes straight to the account.
 * In dinars it passes through the exchange clearing accounts at the day's
 * rate, so that each currency still balances and the customer is credited in
 * dollars.
 */
function customerPayment(
  kind: EntryKind,
  into: (currency: Currency) => AccountRef,
  customerId: string,
  received: Money,
  ratePer100: number | undefined,
): EntryDraft {
  positive(received.amount, "the amount received");
  const customer = account.customer(customerId);

  if (received.currency === "USD") {
    return draft(kind, [
      { account: into("USD"), currency: "USD", amount: received.amount },
      { account: customer, currency: "USD", amount: -received.amount },
    ]);
  }

  if (ratePer100 === undefined) {
    throw new Error("rate_missing: set today's dinar rate first");
  }
  assertRate(ratePer100);
  const cents = iqdToUsdCents(received.amount, ratePer100);
  positive(cents, "the dollar value of the dinars received");
  return draft(
    kind,
    [
      { account: into("IQD"), currency: "IQD", amount: received.amount },
      { account: account.exchangeClearing("IQD"), currency: "IQD", amount: -received.amount },
      { account: account.exchangeClearing("USD"), currency: "USD", amount: cents },
      { account: customer, currency: "USD", amount: -cents },
    ],
    { ratePer100 },
  );
}

/**
 * A file is confirmed: the customer owes the amount to collect, and the same
 * amount becomes owed to the China office. A prepaid consignment ($0) posts
 * nothing, so this returns null.
 */
export function fileConfirmed(input: { customerId: string; amountDueUsdCents: bigint }): EntryDraft | null {
  if (input.amountDueUsdCents < 0n) {
    throw new RangeError("the amount due cannot be negative");
  }
  if (input.amountDueUsdCents === 0n) {
    return null;
  }
  return draft("file_confirmed", [
    { account: account.customer(input.customerId), currency: "USD", amount: input.amountDueUsdCents },
    { account: account.chinaPayable(), currency: "USD", amount: -input.amountDueUsdCents },
  ]);
}

/** The driver collected from a customer on a round, as written on his receipt. */
export function driverCollected(input: {
  roundId: string;
  customerId: string;
  received: Money;
  ratePer100?: number;
}): EntryDraft {
  return customerPayment(
    "driver_collected",
    (currency) => account.driverCash(input.roundId, currency),
    input.customerId,
    input.received,
    input.ratePer100,
  );
}

/** A customer paid cash at the office. */
export function officePayment(input: { customerId: string; received: Money; ratePer100?: number }): EntryDraft {
  return customerPayment("office_payment", account.vault, input.customerId, input.received, input.ratePer100);
}

/** A customer paid through FIB, FastPay or ZainCash. */
export function walletPayment(input: {
  customerId: string;
  wallet: Wallet;
  received: Money;
  ratePer100?: number;
}): EntryDraft {
  return customerPayment(
    "wallet_payment",
    (currency) => account.wallet(input.wallet, currency),
    input.customerId,
    input.received,
    input.ratePer100,
  );
}

/**
 * The driver hands in the round's cash and the CEO counts it. Only what was
 * counted moves to the vault. Any gap stays on the round's driver cash account.
 */
export function roundHandedIn(input: { roundId: string; countedUsdCents: bigint; countedIqd: bigint }): EntryDraft {
  if (input.countedUsdCents < 0n || input.countedIqd < 0n) {
    throw new RangeError("a counted amount cannot be negative");
  }
  const lines: DraftLine[] = [];
  if (input.countedUsdCents > 0n) {
    lines.push(
      { account: account.vault("USD"), currency: "USD", amount: input.countedUsdCents },
      { account: account.driverCash(input.roundId, "USD"), currency: "USD", amount: -input.countedUsdCents },
    );
  }
  if (input.countedIqd > 0n) {
    lines.push(
      { account: account.vault("IQD"), currency: "IQD", amount: input.countedIqd },
      { account: account.driverCash(input.roundId, "IQD"), currency: "IQD", amount: -input.countedIqd },
    );
  }
  if (lines.length === 0) {
    throw new RangeError("nothing was counted");
  }
  return draft("round_handed_in", lines);
}

/** Money sent to the China office from the dollar vault. It pays down what is owed. */
export function sentToChina(input: { amountUsdCents: bigint }): EntryDraft {
  positive(input.amountUsdCents, "the amount sent");
  return draft("sent_to_china", [
    { account: account.chinaPayable(), currency: "USD", amount: input.amountUsdCents },
    { account: account.vault("USD"), currency: "USD", amount: -input.amountUsdCents },
  ]);
}

/** Cash paid out of the vault. A category and a reason are required. */
export function cashOut(input: { category: ExpenseCategory; amount: Money; reason: string }): EntryDraft {
  positive(input.amount.amount, "the amount paid out");
  if (input.reason.trim().length === 0) {
    throw new Error("a cash out needs a reason");
  }
  const { currency, amount } = input.amount;
  return draft(
    "cash_out",
    [
      { account: account.expense(input.category, currency), currency, amount },
      { account: account.vault(currency), currency, amount: -amount },
    ],
    { reason: input.reason.trim() },
  );
}

/**
 * Dollars from the vault changed into dinars: the same exchange the other way
 * round. Both amounts are what really changed hands.
 */
export function currencyExchangeToDinars(input: { usdCentsGiven: bigint; iqdReceived: bigint }): EntryDraft {
  positive(input.usdCentsGiven, "the dollars given");
  positive(input.iqdReceived, "the dinars received");
  return draft(
    "currency_exchange",
    [
      { account: account.vault("IQD"), currency: "IQD", amount: input.iqdReceived },
      { account: account.exchangeClearing("IQD"), currency: "IQD", amount: -input.iqdReceived },
      { account: account.exchangeClearing("USD"), currency: "USD", amount: input.usdCentsGiven },
      { account: account.vault("USD"), currency: "USD", amount: -input.usdCentsGiven },
    ],
    { ratePer100: impliedRate(input.iqdReceived, input.usdCentsGiven) },
  );
}

/**
 * Dinars from the vault changed into dollars. Both amounts are what really
 * changed hands; the rate recorded is the one they imply.
 */
export function currencyExchange(input: { iqdGiven: bigint; usdCentsReceived: bigint }): EntryDraft {
  positive(input.iqdGiven, "the dinars given");
  positive(input.usdCentsReceived, "the dollars received");
  return draft(
    "currency_exchange",
    [
      { account: account.vault("USD"), currency: "USD", amount: input.usdCentsReceived },
      { account: account.exchangeClearing("USD"), currency: "USD", amount: -input.usdCentsReceived },
      { account: account.exchangeClearing("IQD"), currency: "IQD", amount: input.iqdGiven },
      { account: account.vault("IQD"), currency: "IQD", amount: -input.iqdGiven },
    ],
    { ratePer100: impliedRate(input.iqdGiven, input.usdCentsReceived) },
  );
}
