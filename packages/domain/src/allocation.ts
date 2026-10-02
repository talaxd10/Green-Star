// Which payment paid which consignment. A payment is applied to the
// customer's oldest unpaid consignments first, so the late payer from three
// files ago clears the oldest file before the newest.

export interface OpenConsignment {
  id: string;
  /** What is still owed on this consignment, in USD cents. */
  remainingUsdCents: bigint;
  /** When the file was confirmed. Oldest is paid first. */
  confirmedAt: Date;
}

export interface Allocation {
  consignmentId: string;
  amountUsdCents: bigint;
}

export interface AllocationResult {
  allocations: Allocation[];
  /** Money left after every open consignment is paid: credit on the account. */
  unappliedUsdCents: bigint;
}

export function allocateOldestFirst(paymentUsdCents: bigint, open: readonly OpenConsignment[]): AllocationResult {
  if (paymentUsdCents < 0n) {
    throw new RangeError("a payment cannot be negative");
  }
  const ordered = [...open]
    .filter((c) => c.remainingUsdCents > 0n)
    .sort((a, b) => a.confirmedAt.getTime() - b.confirmedAt.getTime() || a.id.localeCompare(b.id));

  const allocations: Allocation[] = [];
  let left = paymentUsdCents;
  for (const consignment of ordered) {
    if (left === 0n) break;
    const applied = left < consignment.remainingUsdCents ? left : consignment.remainingUsdCents;
    allocations.push({ consignmentId: consignment.id, amountUsdCents: applied });
    left -= applied;
  }
  return { allocations, unappliedUsdCents: left };
}
