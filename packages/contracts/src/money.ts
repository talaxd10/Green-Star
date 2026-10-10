// Money at the office: the day's rate, payments, cash out, exchange, the
// vault close, the ledger and the China account.

import { z } from "zod";
import { type Currency, Day, Instant, Money, Note, Notes, PageQuery, Reason, Uuid } from "./common.ts";

/** How a customer can pay at the office. On a round it is driver cash or a wallet. */
export const OFFICE_METHODS = ["office_cash", "fib", "fastpay", "zaincash"] as const;
export type OfficeMethod = (typeof OFFICE_METHODS)[number];

export const PAYMENT_METHODS = ["driver_cash", ...OFFICE_METHODS] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Where cash leaves the vault to. His exact list, plus money sent to China. */
export const CASH_OUT_CATEGORIES = ["china", "fuel_car", "car_parts", "workers", "transport", "driver_pay", "customs_airport", "rent_salaries", "other"] as const;
export type CashOutCategory = (typeof CASH_OUT_CATEGORIES)[number];

export const ENTRY_KINDS = [
  "file_confirmed",
  "driver_collected",
  "round_handed_in",
  "office_payment",
  "wallet_payment",
  "sent_to_china",
  "cash_out",
  "currency_exchange",
  "reversal",
  "error_correction",
  "driver_advance",
  "driver_expense",
  "driver_return",
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const ACCOUNT_KINDS = ["customer", "driver_cash", "vault", "wallet", "china_payable", "expense", "exchange_clearing", "adjustment", "driver_float"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** "today", or a Baghdad day: the rate that applies is the rate of the day the money moved. */
export const RateDayParams = z.object({ day: z.union([z.literal("today"), Day]) });

/**
 * PUT /v1/fx-rates/:day. Whole dinars per 100 dollars, the way the market
 * quotes it: 145000 is 1,450 per dollar. A rate more than 20% from the last
 * one is refused as a typing mistake until it is sent again with confirm.
 */
export const SetRateRequest = z.strictObject({
  iqdPer100Usd: z.number().int("The rate is a whole number of dinars per 100 dollars").positive().max(100_000_000),
  confirm: z.boolean().default(false),
});

export const RateQuery = z.object({ from: Day.optional(), to: Day.optional() });

/**
 * POST /v1/payments. A customer pays at the office, in cash or by wallet. It
 * pays his oldest unpaid consignment first, unless it names one. Dinars that
 * come to what he owes, give or take half the rounding step, settle it.
 */
export const NewPaymentRequest = z.strictObject({
  customerId: Uuid,
  received: Money,
  method: z.enum(OFFICE_METHODS),
  /** When the money arrived. Now, if left out. A dinar amount converts at that day's rate. */
  happenedAt: Instant.optional(),
  forConsignmentId: Uuid.optional(),
  note: Note.optional(),
});
export type NewPaymentRequest = z.infer<typeof NewPaymentRequest>;

/** The most ways one visit, or one stop on a round, can be paid in. */
export const MAX_PAYMENT_PARTS = 4;

/** True when no two parts are in the same currency and paid the same way: those are one payment. */
export function partsDiffer(parts: readonly { received: { currency: string }; method: string }[]): boolean {
  return new Set(parts.map((part) => `${part.received.currency} ${part.method}`)).size === parts.length;
}

/**
 * POST /v1/payments/parts. One visit paid in more than one way: dollars and
 * dinars, cash and a wallet. Every part is saved or none is. Dollars are
 * applied first, so it is the dinars that settle what is left.
 */
export const NewPaymentPartsRequest = z.strictObject({
  customerId: Uuid,
  parts: z
    .array(z.strictObject({ received: Money, method: z.enum(OFFICE_METHODS) }))
    .min(2, "One payment goes to /v1/payments")
    .max(MAX_PAYMENT_PARTS, `At most ${MAX_PAYMENT_PARTS} payments in one visit`)
    .refine(partsDiffer, "Two payments in the same currency and the same way are one payment. Add them up."),
  happenedAt: Instant.optional(),
  forConsignmentId: Uuid.optional(),
  note: Note.optional(),
});
export type NewPaymentPartsRequest = z.infer<typeof NewPaymentPartsRequest>;

/**
 * POST /v1/errors. The CEO's "Error" entry: an amount taken off what a
 * customer owes, or added to it, with no money moving. No limit. Taking off
 * never goes below nothing. Adding goes onto one of his consignments
 * (`consignmentId`); taking off pays that one first when it is given.
 */
export const NewErrorRequest = z
  .strictObject({
    customerId: Uuid,
    amountUsdCents: z.number().int("An amount is a whole number of cents").positive("Enter an amount").max(100_000_000),
    /** true adds to what he owes; false or left out takes off. */
    add: z.boolean().optional(),
    consignmentId: Uuid.optional(),
    happenedAt: Instant.optional(),
    note: Note.optional(),
  })
  .refine((body) => body.add !== true || body.consignmentId !== undefined, {
    message: "Pick the consignment it adds to",
    path: ["consignmentId"],
  });
export type NewErrorRequest = z.infer<typeof NewErrorRequest>;

export const ErrorQuery = PageQuery.extend({ customerId: Uuid.optional() });

export const PaymentQuery = PageQuery.extend({ customerId: Uuid.optional(), from: Day.optional(), to: Day.optional() });

/** POST /v1/cash-outs. Cash leaves the vault. A reason is always required. Money to China leaves the dollar vault. */
export const NewCashOutRequest = z
  .strictObject({
    category: z.enum(CASH_OUT_CATEGORIES),
    amount: Money,
    reason: Reason,
    happenedAt: Instant.optional(),
    /** For the delivery costs: the round it was for, and the city. */
    roundId: Uuid.optional(),
    city: z.string().trim().min(1).max(80).optional(),
  })
  .refine((body) => body.category !== "china" || body.amount.currency === "USD", {
    path: ["amount", "currency"],
    message: "Money sent to China leaves the dollar vault",
  });
export type NewCashOutRequest = z.infer<typeof NewCashOutRequest>;

export const CashOutQuery = PageQuery.extend({ from: Day.optional(), to: Day.optional() });

/** POST /v1/exchanges. Vault money changed from one currency into the other. Both amounts are what really changed hands. */
export const NewExchangeRequest = z
  .strictObject({ given: Money, received: Money, happenedAt: Instant.optional() })
  .refine((body) => body.given.currency !== body.received.currency, {
    path: ["received", "currency"],
    message: "An exchange is between dollars and dinars",
  });
export type NewExchangeRequest = z.infer<typeof NewExchangeRequest>;

/** POST /v1/vault/close. The vault, counted note by note. A gap needs a note. */
export const VaultCloseRequest = z.strictObject({
  /** Made up by the office app. The same id twice is one close. */
  id: Uuid,
  closedAt: Instant.optional(),
  usdNotes: Notes.optional(),
  iqdNotes: Notes.optional(),
  note: Note.optional(),
});
export type VaultCloseRequest = z.infer<typeof VaultCloseRequest>;

/** POST /v1/entries/:id/reverse. The only way to fix a mistake in the ledger. */
export const ReverseRequest = z.strictObject({ reason: Reason });

/** GET /v1/ledger. Entries by account and date, newest first. `account` is an id or a code such as vault_usd. */
export const LedgerQuery = PageQuery.extend({
  account: z.string().trim().min(1).max(80).optional(),
  customerId: Uuid.optional(),
  kind: z.enum(ENTRY_KINDS).optional(),
  from: Day.optional(),
  to: Day.optional(),
});

export const ChinaAccountQuery = PageQuery.extend({ from: Day.optional(), to: Day.optional() });

export interface Rate {
  day: string;
  iqdPer100Usd: number;
  setBy: string;
  setAt: string;
}

export interface RateToday {
  day: string;
  /** Null until today's rate is set. Dinars cannot be taken before it is. */
  rate: Rate | null;
  /** The last rate set before today, to show beside the box. */
  last: Rate | null;
}

export interface Payment {
  entryId: string;
  customerId: string;
  customerName: string;
  kind: EntryKind;
  method: PaymentMethod;
  receivedAmount: number;
  receivedCurrency: Currency;
  iqdPer100Usd: number | null;
  creditedUsdCents: number;
  happenedAt: string;
  createdAt: string;
  note: string | null;
  roundId: string | null;
  paidForConsignmentId: string | null;
  reversed: boolean;
}

/** What POST /v1/payments/parts returns: one payment per part, in the order they were applied. */
export interface PaymentParts {
  payments: Payment[];
}

/** An Error entry: what was taken off a customer's account, or added to it, with no money moving. */
export interface ErrorEntry {
  entryId: string;
  customerId: string;
  customerName: string;
  /** Always positive. `added` says which way. */
  amountUsdCents: number;
  /** true when it added to what he owes. */
  added: boolean;
  /** The consignment it went onto, or paid first. */
  consignmentId: string | null;
  happenedAt: string;
  createdAt: string;
  note: string | null;
  reversed: boolean;
}

export interface CashOut {
  entryId: string;
  happenedAt: string;
  day: string;
  category: CashOutCategory;
  amount: number;
  currency: Currency;
  reason: string;
  reversed: boolean;
}

export interface EntryLine {
  accountId: string;
  accountCode: string | null;
  accountKind: AccountKind;
  accountName: string;
  currency: Currency;
  amount: number;
}

export interface Entry {
  id: string;
  kind: EntryKind;
  happenedAt: string;
  createdAt: string;
  createdBy: string;
  createdByName: string;
  reason: string | null;
  reversesId: string | null;
  /** The entry that reversed this one, if any. */
  reversedById: string | null;
  iqdPer100Usd: number | null;
  lines: EntryLine[];
}

export interface Account {
  id: string;
  code: string | null;
  kind: AccountKind;
  currency: Currency;
  name: string;
  customerId: string | null;
  roundId: string | null;
  balance: number;
}

export interface CashCount {
  notes: Record<string, number>;
  counted: number;
  expected: number;
  /** Counted minus expected. Negative is short. */
  difference: number;
}

export interface VaultClose {
  id: string;
  day: string;
  closedAt: string;
  note: string | null;
  voided: boolean;
  usd: CashCount;
  iqd: CashCount;
}

export interface VaultCurrency {
  currency: Currency;
  /** What the ledger says is in the vault. */
  ledgerBalance: number;
  /** Gaps found and noted at earlier closes. */
  notedGap: number;
  /** What should be in the box now: the last count plus everything entered since. */
  expectedNow: number;
  lastCloseId: string | null;
  lastCloseDay: string | null;
  lastClosedAt: string | null;
  lastCounted: number | null;
  lastDifference: number | null;
}

export interface Denomination {
  currency: Currency;
  /** In the ledger's unit: a $100 note is 10000, a 25,000 dinar note is 25000. */
  value: number;
  label: string;
}

export interface Vault {
  currencies: VaultCurrency[];
  denominations: Denomination[];
  closes: VaultClose[];
}

export interface ChinaAccountLine {
  entryId: string;
  happenedAt: string;
  day: string;
  kind: EntryKind;
  isReversal: boolean;
  /** Positive when more is owed, negative when it is paid down. */
  owedChangeUsdCents: number;
  owedAfterUsdCents: number;
  shipmentCode: string | null;
  customerId: string | null;
  reason: string | null;
}

export interface ChinaAccount {
  owedUsdCents: number;
  chargedUsdCents: number;
  sentUsdCents: number;
  byDay: { day: string; chargedUsdCents: number; sentUsdCents: number; owedAfterUsdCents: number }[];
  lines: ChinaAccountLine[];
  nextCursor: string | null;
}
