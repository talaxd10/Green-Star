// Statements: every charge and payment on a customer's account with a running
// balance, and the copy the CEO makes to send.

import { z } from "zod";
import { type Currency, Day, Uuid } from "./common.ts";
import type { Trust } from "./customers.ts";
import type { PaymentMethod } from "./money.ts";
import type { ConsignmentStatus } from "./shipments.ts";

export interface StatementLine {
  entryId: string;
  /** The Baghdad day it happened. */
  day: string;
  happenedAt: string;
  /** A charge from a file, or a payment. */
  kind: "charge" | "payment";
  /** True for a line that takes an earlier one back. Only seen when corrections are asked for. */
  isReversal: boolean;
  /** True for an entry that was taken back, and for the line that took it back. */
  isCorrection: boolean;
  /** Positive: he owes more. Negative: he paid. */
  changeUsdCents: number;
  balanceAfterUsdCents: number;
  shipmentId: string | null;
  shipmentCode: string | null;
  consignmentId: string | null;
  method: PaymentMethod | null;
  /** What was handed over, as on the receipt. */
  receivedAmount: number | null;
  receivedCurrency: Currency | null;
  iqdPer100Usd: number | null;
  roundId: string | null;
  note: string | null;
}

/** A file he has not paid in full. */
export interface StatementOpenFile {
  consignmentId: string;
  shipmentId: string;
  shipmentCode: string;
  /** The Baghdad day the file was confirmed. */
  day: string | null;
  status: ConsignmentStatus;
  dueUsdCents: number;
  paidUsdCents: number;
  remainingUsdCents: number;
}

/** GET /v1/customers/:id/statement. */
export interface Statement {
  customerId: string;
  customerName: string;
  phone: string | null;
  trust: Trust;
  creditLimitUsdCents: number | null;
  asOf: string;
  /** What he owes now. Negative when he is in credit. */
  balanceUsdCents: number;
  /** The first day shown, or null when the account is shown from its start. */
  from: string | null;
  /** What he owed before the first line shown. */
  openingBalanceUsdCents: number;
  /** Charged and paid in the lines shown. */
  chargedUsdCents: number;
  paidUsdCents: number;
  /** Oldest first. The last line's balance is balanceUsdCents. */
  lines: StatementLine[];
  /** Files not paid in full, oldest first. */
  open: StatementOpenFile[];
  lastPayment: { day: string; amountUsdCents: number } | null;
}

const flag = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

/**
 * from: lines before this day are summed into the opening balance.
 * corrections: also show entries that were taken back, and what took them back.
 */
export const StatementQuery = z.object({ from: Day.optional(), corrections: flag });

/** POST /v1/customers/:id/statement/export. Makes the copy to send: an image, a PDF and a text. */
export const ExportStatementRequest = z.strictObject({
  /** Made up by the office app for this statement. The same id twice is one statement. */
  id: Uuid,
  from: Day.optional(),
});

/** A statement that was made to send, kept exactly as it was drawn. */
export interface StatementRecord {
  id: string;
  customerId: string;
  customerName: string;
  asOf: string;
  from: string | null;
  balanceUsdCents: number;
  /** Ready to paste into a message. */
  text: string;
  /** Where the image and the PDF are read from. */
  imageUrl: string;
  pdfUrl: string;
  createdByName: string;
  sentAt: string | null;
  sentByName: string | null;
}

/** GET /v1/statements. Who to send a statement to: trusted customers who owe something. */
export interface StatementListItem {
  customerId: string;
  customerName: string;
  phone: string | null;
  balanceUsdCents: number;
  creditLimitUsdCents: number | null;
  overLimit: boolean;
  lastStatementId: string | null;
  lastSentAt: string | null;
  lastSentBalanceUsdCents: number | null;
  /** True when the last one was sent a week ago or more, or never. */
  due: boolean;
}
