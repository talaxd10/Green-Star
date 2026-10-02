// Money is a whole number in the smallest unit plus a currency.
// USD is counted in cents. IQD is counted in whole dinars. Never floating point.

export type Currency = "USD" | "IQD";

export const CURRENCIES: readonly Currency[] = ["USD", "IQD"];

export interface Money {
  readonly amount: bigint;
  readonly currency: Currency;
}

/** The shape money takes in API requests: { "amount": 8500, "currency": "USD" }. */
export interface MoneyJson {
  amount: number;
  currency: Currency;
}

export function isCurrency(value: unknown): value is Currency {
  return value === "USD" || value === "IQD";
}

export function money(amount: bigint | number, currency: Currency): Money {
  if (typeof amount === "number") {
    if (!Number.isSafeInteger(amount)) {
      throw new RangeError(`money amount must be a whole number, got ${amount}`);
    }
    return { amount: BigInt(amount), currency };
  }
  return { amount, currency };
}

/** Dollars in cents: usd(8500) is $85.00. */
export const usd = (cents: bigint | number): Money => money(cents, "USD");

/** Dinars in whole dinars: iqd(123250) is 123,250 IQD. */
export const iqd = (dinars: bigint | number): Money => money(dinars, "IQD");

export function fromJson(json: MoneyJson): Money {
  if (!isCurrency(json.currency)) {
    throw new TypeError(`unknown currency: ${String(json.currency)}`);
  }
  return money(json.amount, json.currency);
}

export function toJson(m: Money): MoneyJson {
  if (m.amount > BigInt(Number.MAX_SAFE_INTEGER) || m.amount < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError("money amount is too large to send as a JSON number");
  }
  return { amount: Number(m.amount), currency: m.currency };
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`cannot combine ${a.currency} with ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function negate(m: Money): Money {
  return { amount: -m.amount, currency: m.currency };
}

export function isZero(m: Money): boolean {
  return m.amount === 0n;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "$85.00", "-$0.07", "123,250 IQD". For screens and statements. */
export function format(m: Money): string {
  const negative = m.amount < 0n;
  const abs = negative ? -m.amount : m.amount;
  const sign = negative ? "-" : "";
  if (m.currency === "USD") {
    const dollars = groupThousands((abs / 100n).toString());
    const cents = (abs % 100n).toString().padStart(2, "0");
    return `${sign}$${dollars}.${cents}`;
  }
  return `${sign}${groupThousands(abs.toString())} IQD`;
}
