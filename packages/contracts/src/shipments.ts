// Files from China, the consignments on them, and problems with the goods.

import { z } from "zod";
import { Day, Instant, Note, PageQuery, Reason, UsdCents, Uuid } from "./common.ts";
import type { Trust } from "./customers.ts";

export const SHIPMENT_STATUSES = ["draft", "confirmed", "on_rounds", "reconciling", "closed"] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const CONSIGNMENT_STATUSES = [
  "listed",
  "on_round",
  "delivered_paid",
  "delivered_prepaid",
  "delivered_on_account",
  "held",
  "delivered_not_paid",
  "closed",
  "cancelled",
] as const;
export type ConsignmentStatus = (typeof CONSIGNMENT_STATUSES)[number];

export const DISPUTE_KINDS = ["missing", "damaged", "weight"] as const;
export const DISPUTE_STATUSES = ["open", "sent_to_china", "answered", "closed"] as const;
export type DisputeKind = (typeof DISPUTE_KINDS)[number];
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const ShipmentQuery = PageQuery.extend({ status: z.enum(SHIPMENT_STATUSES).optional() });
export type ShipmentQuery = z.infer<typeof ShipmentQuery>;

const DraftConsignment = z.strictObject({
  customerId: Uuid,
  /** The file's money to collect, in cents. Zero means prepaid in China. */
  amountDueUsdCents: UsdCents,
  /** The part of it above freight + packing + customs, such as buying the item. */
  otherChargesUsdCents: UsdCents.default(0),
  cartonsExpected: z.number().int().min(0).max(100_000).optional(),
  city: z.string().trim().min(1).max(80).optional(),
});

/**
 * POST /v1/shipments and PUT /v1/shipments/:id. A file typed in by hand: one
 * row per customer. It stays a draft, and charges nobody, until it is confirmed.
 */
export const DraftShipmentRequest = z
  .strictObject({
    code: z.string().trim().min(1, "Enter the file's code").max(40),
    arrivedOn: Day.optional(),
    consignments: z.array(DraftConsignment).min(1, "A file needs at least one customer").max(500),
  })
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    body.consignments.forEach((row, index) => {
      if (row.otherChargesUsdCents > row.amountDueUsdCents) {
        ctx.addIssue({ code: "custom", path: ["consignments", index, "otherChargesUsdCents"], message: "Other charges cannot be more than the amount to collect" });
      }
      if (seen.has(row.customerId)) {
        ctx.addIssue({ code: "custom", path: ["consignments", index, "customerId"], message: "This customer is on the file twice" });
      }
      seen.add(row.customerId);
    });
  });
export type DraftShipmentRequest = z.infer<typeof DraftShipmentRequest>;

/** POST /v1/shipments/:id/confirm. Posts one charge per customer, once. */
export const ConfirmShipmentRequest = z.strictObject({ confirmedAt: Instant.optional() });

/** POST /v1/consignments/:id/cancel. Reverses its charge. */
export const CancelConsignmentRequest = z.strictObject({ reason: Reason });

/** POST /v1/consignments/:id/correct. Cancels it and charges the right amount. Returns the replacement. */
export const CorrectConsignmentRequest = z
  .strictObject({ amountDueUsdCents: UsdCents, otherChargesUsdCents: UsdCents.default(0), reason: Reason })
  .refine((body) => body.otherChargesUsdCents <= body.amountDueUsdCents, {
    path: ["otherChargesUsdCents"],
    message: "Other charges cannot be more than the amount to collect",
  });

export const DisputeQuery = z.object({ status: z.enum(DISPUTE_STATUSES).optional(), waiting: z.enum(["true", "false"]).optional() });

/** POST /v1/disputes. A problem with the goods, sent to the China office. */
export const NewDisputeRequest = z.strictObject({
  consignmentId: Uuid,
  kind: z.enum(DISPUTE_KINDS),
  note: Note.optional(),
  /** False to record it now and tell China later. */
  sentToChina: z.boolean().default(true),
});

/** PATCH /v1/disputes/:id. Mark it sent, record China's answer, or close it. */
export const UpdateDisputeRequest = z
  .strictObject({
    sentToChina: z.literal(true).optional(),
    chinaAnswer: z.string().trim().min(1, "Write what China said").max(1000).optional(),
    close: z.literal(true).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to change");

export interface ShipmentSummary {
  id: string;
  code: string;
  status: ShipmentStatus;
  arrivedOn: string | null;
  confirmedAt: string | null;
  createdAt: string;
  consignments: number;
  expectedUsdCents: number;
  collectedUsdCents: number;
  remainingUsdCents: number;
  /** What stops the file closing. All zero on a closed file. */
  notDelivered: number;
  deliveredNotPaid: number;
  onAccount: number;
  waitingForHandIn: number;
  disputesWaiting: number;
}

export interface Consignment {
  id: string;
  shipmentId: string;
  shipmentCode: string;
  shipmentStatus: ShipmentStatus;
  confirmedAt: string | null;
  customerId: string;
  customerName: string;
  trust: Trust;
  status: ConsignmentStatus;
  amountDueUsdCents: number;
  otherChargesUsdCents: number;
  paidUsdCents: number;
  remainingUsdCents: number;
  cartonsExpected: number | null;
  cartonsReceived: number | null;
  city: string | null;
  createdAt: string;
  lastRoundId: string | null;
  hasException: boolean;
  /** What Error entries added to it, while they stand. Included in remaining. */
  errorsAddedUsdCents: number;
}

export interface Dispute {
  id: string;
  consignmentId: string;
  shipmentId: string;
  shipmentCode: string;
  customerId: string;
  customerName: string;
  kind: DisputeKind;
  note: string | null;
  status: DisputeStatus;
  sentToChinaAt: string | null;
  chinaAnswer: string | null;
  answeredAt: string | null;
  createdAt: string;
}

export interface ShipmentDetail extends ShipmentSummary {
  consignmentList: Consignment[];
  disputes: Dispute[];
}
