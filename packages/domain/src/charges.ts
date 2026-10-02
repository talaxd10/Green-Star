// What a customer owes on one file.
//
// The file's money to collect is the truth. Freight, packing and customs
// explain it: anything above them is shown as other charges (such as buying
// the item), anything below them is flagged, and $0 means prepaid.

export interface ChargeInput {
  /** The amount to collect, as written on the file. */
  collectUsdCents: bigint;
  freightUsdCents: bigint;
  packingUsdCents: bigint;
  customsUsdCents: bigint;
}

export interface ChargeAssessment {
  amountDueUsdCents: bigint;
  /** Freight + packing + customs. */
  expectedUsdCents: bigint;
  /** The part of the amount due above freight + packing + customs. */
  otherChargesUsdCents: bigint;
  prepaid: boolean;
  /** Collecting less than freight + packing + customs. Needs a look before confirming. */
  undercharged: boolean;
  shortByUsdCents: bigint;
}

export function assessCharge(input: ChargeInput): ChargeAssessment {
  for (const [name, value] of Object.entries(input)) {
    if (value < 0n) throw new RangeError(`${name} cannot be negative`);
  }
  const expected = input.freightUsdCents + input.packingUsdCents + input.customsUsdCents;
  const collect = input.collectUsdCents;
  const prepaid = collect === 0n;
  const undercharged = !prepaid && collect < expected;
  return {
    amountDueUsdCents: collect,
    expectedUsdCents: expected,
    otherChargesUsdCents: collect > expected ? collect - expected : 0n,
    prepaid,
    undercharged,
    shortByUsdCents: undercharged ? expected - collect : 0n,
  };
}

/** Freight for a weight at a price per kilo. Half a cent rounds up. */
export function freightFromWeight(weightGrams: bigint, pricePerKgUsdCents: bigint): bigint {
  if (weightGrams < 0n || pricePerKgUsdCents < 0n) {
    throw new RangeError("weight and price cannot be negative");
  }
  return (weightGrams * pricePerKgUsdCents * 2n + 1000n) / 2000n;
}
