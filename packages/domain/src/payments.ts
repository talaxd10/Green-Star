// What a customer hands over in one visit, or at one stop: one or more parts,
// each one amount in one currency. This works out what each part is worth on
// his account. The office app uses it to show the result before Save, the API
// uses it to post, and the database checks every entry against the same rule.

import { dinarCredit, iqdToUsdCents, DINAR_ROUNDING_IQD } from "./fx.ts";
import type { Money } from "./money.ts";

export interface PartPlan {
  /** Where this part was in the list given. */
  index: number;
  received: Money;
  /** What the part converts to at the rate, to the cent. For dollars, the amount itself. */
  exactUsdCents: bigint;
  /** What goes on his account. Differs from exactUsdCents only for dinars that settle what he owes. */
  creditUsdCents: bigint;
}

export interface PaymentPlan {
  /** The parts in the order they are applied: dollars first, then dinars, each kind in the order given. */
  parts: PartPlan[];
  creditUsdCents: bigint;
  /** What he owes after it. Negative when he is left in credit. */
  leftUsdCents: bigint;
}

export interface PlanOptions {
  /** Dinars per 100 dollars. Needed as soon as one part is in dinars. */
  ratePer100?: number | undefined;
  /** Everything he owes now. Zero or negative when he owes nothing. */
  owedUsdCents: bigint;
  /** What is still owed on the consignment the money is for, when it is for one. */
  owedForConsignmentUsdCents?: bigint | undefined;
  /** The rounding step from Settings. 1,000 dinars when left out. */
  stepIqd?: bigint | undefined;
}

/**
 * Dollars go on first, so that it is the dinars that settle what is left:
 * "$400 in dollars, and 209,000 dinars for the other $133". Each dinar part
 * is worth what is still owed when it settles that (on the consignment the
 * money is for first, then on everything), and otherwise exactly what it
 * converts to.
 */
export function planPayment(parts: readonly Money[], options: PlanOptions): PaymentPlan {
  if (parts.length === 0) throw new RangeError("a payment has at least one part");
  for (const part of parts) {
    if (part.amount <= 0n) throw new RangeError("the amount received must be more than zero");
  }
  const order = parts
    .map((received, index) => ({ received, index }))
    .sort((a, b) => Number(a.received.currency === "IQD") - Number(b.received.currency === "IQD") || a.index - b.index);

  let owed = options.owedUsdCents;
  let forConsignment = options.owedForConsignmentUsdCents;
  const planned: PartPlan[] = [];
  for (const { received, index } of order) {
    let exactUsdCents = received.amount;
    let creditUsdCents = received.amount;
    if (received.currency === "IQD") {
      if (options.ratePer100 === undefined) throw new Error("rate_missing: set today's dinar rate first");
      exactUsdCents = iqdToUsdCents(received.amount, options.ratePer100);
      const candidates = forConsignment === undefined ? [owed] : [forConsignment, owed];
      creditUsdCents = dinarCredit(received.amount, options.ratePer100, candidates, options.stepIqd ?? DINAR_ROUNDING_IQD);
    }
    planned.push({ index, received, exactUsdCents, creditUsdCents });
    owed -= creditUsdCents;
    // Money for a consignment pays that one first; what is over goes to his older ones.
    if (forConsignment !== undefined) forConsignment = forConsignment > creditUsdCents ? forConsignment - creditUsdCents : 0n;
  }
  return {
    parts: planned,
    creditUsdCents: planned.reduce((sum, part) => sum + part.creditUsdCents, 0n),
    leftUsdCents: owed,
  };
}
