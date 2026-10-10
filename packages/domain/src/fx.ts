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

/** The step dinars are rounded to unless Settings says otherwise: the nearest 1,000. */
export const DINAR_ROUNDING_IQD = 1000n;

/** 208,810 to the nearest 1,000 is 209,000. Half a step rounds up. A step of 0 leaves it as it is. */
export function roundDinars(dinars: bigint, stepIqd: bigint = DINAR_ROUNDING_IQD): bigint {
  if (stepIqd < 0n) throw new RangeError("the rounding step cannot be negative");
  if (stepIqd === 0n) return dinars;
  if (dinars < 0n) return -roundDinars(-dinars, stepIqd);
  return ((2n * dinars + stepIqd) / (2n * stepIqd)) * stepIqd;
}

/**
 * True when these dinars come to this many cents, give or take half the
 * rounding step. $133.00 at 157,000 is 208,810 IQD: 209,000 settles it and so
 * does 208,500; 208,000 does not. Nothing settles a customer who owes nothing.
 * The database applies the same test (gs_dinars_settle).
 */
export function dinarsSettle(dinars: bigint, ratePer100: number, owedUsdCents: bigint, stepIqd: bigint = DINAR_ROUNDING_IQD): boolean {
  assertRate(ratePer100);
  if (stepIqd < 0n) throw new RangeError("the rounding step cannot be negative");
  if (owedUsdCents <= 0n || dinars <= 0n) return false;
  const exactly = usdCentsToIqd(owedUsdCents, ratePer100);
  const off = dinars > exactly ? dinars - exactly : exactly - dinars;
  return 2n * off <= stepIqd;
}

/**
 * What a dinar payment is worth on the customer's account. The amounts owed
 * are the ones it could settle: the consignment the money is for, and
 * everything he owes. It is worth the one it settles; when it settles both
 * (they are less than a step apart), the nearer one, and everything when
 * they are as near. Otherwise the dinars are worth exactly what they convert
 * to. The database works it out the same way (gs_dinar_credit).
 */
export function dinarCredit(dinars: bigint, ratePer100: number, owedUsdCents: readonly bigint[], stepIqd: bigint = DINAR_ROUNDING_IQD): bigint {
  let best: { owed: bigint; off: bigint } | null = null;
  for (const owed of owedUsdCents) {
    if (!dinarsSettle(dinars, ratePer100, owed, stepIqd)) continue;
    const exactly = usdCentsToIqd(owed, ratePer100);
    const off = dinars > exactly ? dinars - exactly : exactly - dinars;
    if (best === null || off < best.off || (off === best.off && owed > best.owed)) best = { owed, off };
  }
  return best === null ? iqdToUsdCents(dinars, ratePer100) : best.owed;
}

/** The nearest whole rate for an exchange where both amounts are known. */
export function impliedRate(dinars: bigint, cents: bigint): number {
  if (dinars <= 0n || cents <= 0n) {
    throw new RangeError("both sides of an exchange must be positive");
  }
  return Number((dinars * 20000n + cents) / (2n * cents));
}

/**
 * True when a new rate is more than 20% away from the last one. That is almost
 * always a typing mistake (1,450 instead of 145,000), so the screen asks again
 * before sending it. The database applies the same test in gs_set_rate.
 */
export function isRateJump(lastRatePer100: number, newRatePer100: number): boolean {
  assertRate(lastRatePer100);
  assertRate(newRatePer100);
  return Math.abs(newRatePer100 - lastRatePer100) * 5 > lastRatePer100;
}

/**
 * What dollars handed to the driver are worth when he gave dinars back from
 * his own account: the dollars less the dinars at the day's rate. When that
 * comes to what is owed, give or take half the rounding step (counted in
 * dinars), it settles it; the goods first, then everything, the nearer one
 * when both. The database works it out the same way (gs_change_credit).
 */
export function changeCredit(usdCents: bigint, changeIqd: bigint, ratePer100: number, owedUsdCents: readonly bigint[], stepIqd: bigint = DINAR_ROUNDING_IQD): bigint {
  assertRate(ratePer100);
  const exact = usdCents - iqdToUsdCents(changeIqd, ratePer100);
  let best: { owed: bigint; off: bigint } | null = null;
  for (const owed of owedUsdCents) {
    if (owed <= 0n) continue;
    const off = exact > owed ? exact - owed : owed - exact;
    if (2n * usdCentsToIqd(off, ratePer100) > stepIqd) continue;
    if (best === null || off < best.off || (off === best.off && owed > best.owed)) best = { owed, off };
  }
  return best === null ? exact : best.owed;
}
