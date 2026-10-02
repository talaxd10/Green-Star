// Dinar conversion.
//
// A rate is whole dinars per 100 US dollars, e.g. 145000 (which is 1,450 per
// dollar). It is kept per hundred because that is how the market quotes it,
// and a quote such as 152,750 per $100 is 1,527.5 per dollar, which a
// per-dollar whole number cannot hold.
//
// Customer accounts are in dollars, so dinars received are converted to cents
// at the day's rate. Half a cent rounds up.

export function assertRate(ratePer100: number): void {
  if (!Number.isSafeInteger(ratePer100) || ratePer100 <= 0) {
    throw new RangeError(`rate must be a positive whole number of dinars per 100 dollars, got ${ratePer100}`);
  }
}

/** A per-dollar rate such as 1450 as the per-hundred rate the system stores. */
export function rateFromPerDollar(dinarsPerDollar: number): number {
  const per100 = Math.round(dinarsPerDollar * 100);
  assertRate(per100);
  return per100;
}

/** 123,250 IQD at 145,000 per $100 is 8500 cents ($85.00). */
export function iqdToUsdCents(dinars: bigint, ratePer100: number): bigint {
  assertRate(ratePer100);
  if (dinars < 0n) return -iqdToUsdCents(-dinars, ratePer100);
  const r = BigInt(ratePer100);
  return (dinars * 20000n + r) / (2n * r);
}

/** $85.00 at 145,000 per $100 is 123,250 IQD. Half a dinar rounds up. */
export function usdCentsToIqd(cents: bigint, ratePer100: number): bigint {
  assertRate(ratePer100);
  if (cents < 0n) return -usdCentsToIqd(-cents, ratePer100);
  return (cents * BigInt(ratePer100) * 2n + 10000n) / 20000n;
}

/**
 * True when a dinar amount and a cent amount agree at this rate to within
 * half a cent. The database applies the same test to every customer payment
 * made in dinars.
 */
export function conversionAgrees(dinars: bigint, cents: bigint, ratePer100: number): boolean {
  assertRate(ratePer100);
  const abs = (n: bigint) => (n < 0n ? -n : n);
  return 2n * abs(abs(dinars) * 10000n - abs(cents) * BigInt(ratePer100)) <= BigInt(ratePer100);
}

/** The nearest whole rate for an exchange where both amounts are known. */
export function impliedRate(dinars: bigint, cents: bigint): number {
  if (dinars <= 0n || cents <= 0n) {
    throw new RangeError("both sides of an exchange must be positive");
  }
  return Number((dinars * 20000n + cents) / (2n * cents));
}
