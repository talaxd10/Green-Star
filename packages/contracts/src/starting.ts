// Starting balances: what stood on the day the system started, typed in by
// the CEO. Typing one again replaces it; 0 clears it.

import { z } from "zod";
import { Uuid } from "./common.ts";

/** The office's own starting balances: the cash in the vault, and what is owed to China. */
export const OFFICE_STARTS = ["vault_usd", "vault_iqd", "china"] as const;
export type OfficeStart = (typeof OFFICE_STARTS)[number];

/**
 * PUT /v1/starting-balances/customers/:id. usdCents above 0 is what he owed
 * before; below 0 is the credit he had; 0 clears it. id names this request.
 */
export const CustomerStartRequest = z.strictObject({
  id: Uuid,
  usdCents: z.number().int("Dollars are sent in cents, as a whole number").min(-1e11).max(1e11),
});
export type CustomerStartRequest = z.infer<typeof CustomerStartRequest>;

/**
 * PUT /v1/starting-balances/office. The vault's cash (dollars in cents,
 * dinars whole) or what is owed to China (in cents). 0 clears it.
 */
export const OfficeStartRequest = z.strictObject({
  id: Uuid,
  what: z.enum(OFFICE_STARTS),
  amount: z.number().int("A whole number").min(0, "It cannot be below nothing").max(1e13),
});
export type OfficeStartRequest = z.infer<typeof OfficeStartRequest>;

export interface CustomerStart {
  customerId: string;
  customerName: string;
  /** Above 0 what he owed, below 0 his credit. */
  usdCents: number;
  /** What he owes now, all of it. */
  balanceUsdCents: number;
  setAt: string;
}

export interface StartingBalances {
  /** null when none was set. */
  vaultUsdCents: number | null;
  vaultIqd: number | null;
  /** What was owed to China, in cents. */
  chinaUsdCents: number | null;
  customers: CustomerStart[];
}
