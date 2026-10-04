// Money as a person types and reads it, and as the system keeps it: a whole
// number in the smallest unit. Dollars in cents, dinars in whole dinars.
// Nothing here uses floating point for an amount.

import type { Currency } from "@green-star/contracts";
import { planPayment, roundDinars as roundDinarsExactly } from "@green-star/domain";

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "$85.00", "-$0.07", "123,250 IQD". */
export function formatMoney(amount: number, currency: Currency): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const sign = negative ? "-" : "";
  if (currency === "USD") {
    const dollars = groupThousands(Math.trunc(abs / 100).toString());
    const cents = (abs % 100).toString().padStart(2, "0");
    return `${sign}$${dollars}.${cents}`;
  }
  return `${sign}${groupThousands(abs.toString())} IQD`;
}

export const usd = (cents: number) => formatMoney(cents, "USD");
export const iqd = (dinars: number) => formatMoney(dinars, "IQD");

/**
 * What was typed in an amount box, as cents or dinars. Null when it is not an
 * amount: empty, letters, a third decimal place, half a dinar.
 *
 *   "85" -> 8500    "85.5" -> 8550    "1,234.56" -> 123456    "$62" -> 6200
 *   "123,250" (IQD) -> 123250
 */
export function parseAmount(typed: string, currency: Currency): number | null {
  const text = typed.trim().replace(/^\$\s*/, "").replace(/\s*IQD$/i, "");
  // Whole part: plain digits, or groups of three split by commas or spaces.
  // "85,5" is not an amount: a comma is a thousands mark, never a decimal
  // point, and guessing would turn 85.5 into 855.
  const match = /^(\d+|\d{1,3}(?:[, ]\d{3})+)?(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null || (match[1] === undefined && match[2] === undefined)) return null;
  const whole = (match[1] ?? "0").replace(/[, ]/g, "");
  if (whole.length > 13) return null;
  if (currency === "IQD") {
    if (match[2] !== undefined) return null;   // no half dinars
    return Number(whole);
  }
  if (whole.length > 11) return null;
  const cents = match[2] === undefined ? 0 : Number(match[2].padEnd(2, "0"));
  return Number(whole) * 100 + cents;
}

/** An amount ready to go back into its box: "85.00", "123250". */
export function amountForInput(amount: number, currency: Currency): string {
  if (currency === "USD") return `${Math.trunc(amount / 100)}.${(amount % 100).toString().padStart(2, "0")}`;
  return amount.toString();
}

/**
 * The rate is kept as whole dinars per 100 dollars, the way the market quotes
 * it. 145000 reads "145,000 per $100" and is 1,450 per dollar; 152750 is
 * 1,527.5 per dollar.
 */
export function formatRate(iqdPer100Usd: number): string {
  return groupThousands(iqdPer100Usd.toString());
}

export function formatRatePerDollar(iqdPer100Usd: number): string {
  const whole = Math.trunc(iqdPer100Usd / 100);
  const rest = iqdPer100Usd % 100;
  const decimals = rest === 0 ? "" : `.${rest.toString().padStart(2, "0").replace(/0$/, "")}`;
  return `${groupThousands(whole.toString())}${decimals}`;
}

/** What was typed in the rate box, as whole dinars per 100 dollars. */
export function parseRate(typed: string): number | null {
  const text = typed.trim().replace(/[,\s]/g, "");
  if (!/^\d{1,9}$/.test(text)) return null;
  const rate = Number(text);
  return rate > 0 ? rate : null;
}

/** Dinars as cents at a rate, the same arithmetic as the database. Half a cent rounds up. */
export function iqdToUsdCents(dinars: number, iqdPer100Usd: number): number {
  const d = BigInt(dinars);
  const r = BigInt(iqdPer100Usd);
  return Number((d * 20000n + r) / (2n * r));
}

/** Cents as dinars at a rate. Half a dinar rounds up. */
export function usdCentsToIqd(cents: number, iqdPer100Usd: number): number {
  return Number((BigInt(cents) * BigInt(iqdPer100Usd) * 2n + 10000n) / 20000n);
}

/** 192,850 to the nearest 1,000 is 193,000. A step of 0 leaves it as it is. */
export function roundDinars(dinars: number, stepIqd: number): number {
  return Number(roundDinarsExactly(BigInt(dinars), BigInt(stepIqd)));
}

export interface PartsPlan {
  /** What each part goes on his account as, in the order the parts were given. */
  credited: number[];
  /** What each part converts to, to the cent. Differs from credited only for dinars that settle what he owes. */
  exact: number[];
  /** Everything together, as it goes on his account. */
  total: number;
  /** What he owes after it. Negative when he is left in credit. */
  left: number;
}

/**
 * What a payment in one or more parts will do, before it is saved: the same
 * working-out the API posts with. Dollars go on first, then the dinars, and
 * dinars that come to what is still owed (give or take half the rounding
 * step) settle it. Null when a part is in dinars and today's rate is not set.
 */
export function planParts(
  parts: readonly { amount: number; currency: Currency }[],
  options: { iqdPer100Usd: number | null; owedUsdCents: number; owedForConsignmentUsdCents?: number; stepIqd: number },
): PartsPlan | null {
  if (parts.length === 0 || parts.some((part) => part.amount <= 0)) return null;
  if (options.iqdPer100Usd === null && parts.some((part) => part.currency === "IQD")) return null;
  const plan = planPayment(
    parts.map((part) => ({ amount: BigInt(part.amount), currency: part.currency })),
    {
      ratePer100: options.iqdPer100Usd ?? undefined,
      owedUsdCents: BigInt(options.owedUsdCents),
      owedForConsignmentUsdCents: options.owedForConsignmentUsdCents === undefined ? undefined : BigInt(options.owedForConsignmentUsdCents),
      stepIqd: BigInt(options.stepIqd),
    },
  );
  const credited = parts.map(() => 0);
  const exact = parts.map(() => 0);
  for (const part of plan.parts) {
    credited[part.index] = Number(part.creditUsdCents);
    exact[part.index] = Number(part.exactUsdCents);
  }
  return { credited, exact, total: Number(plan.creditUsdCents), left: Number(plan.leftUsdCents) };
}

/** Adds up a count of notes: { "10000": 3, "5000": 1 } is 35000. */
export function countNotes(notes: Record<string, number>): number {
  let total = 0;
  for (const [value, count] of Object.entries(notes)) total += Number(value) * count;
  return total;
}
