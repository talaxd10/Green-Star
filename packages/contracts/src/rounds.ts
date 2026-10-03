// Rounds: who carries the goods, what happened at each stop, and the cash
// counted in when the driver is back.

import { z } from "zod";
import { type Currency, Instant, Money, Name, Note, Notes, PageQuery, Reason, Uuid } from "./common.ts";
import type { Trust } from "./customers.ts";
import type { ConsignmentStatus } from "./shipments.ts";

export const ROUND_STATUSES = ["planned", "out", "returned", "handed_in"] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

export const ROUND_OUTCOMES = ["paid", "on_account", "prepaid", "held", "unpaid"] as const;
export type RoundOutcome = (typeof ROUND_OUTCOMES)[number];

/** How money can be taken on a round. Cash at the office is not one of them. */
export const ROUND_METHODS = ["driver_cash", "fib", "fastpay", "zaincash"] as const;
export type RoundMethod = (typeof ROUND_METHODS)[number];

export const CARRIER_KINDS = ["own_car", "transport_office"] as const;
export type CarrierKind = (typeof CARRIER_KINDS)[number];

const Phone = z.string().trim().min(1).max(64);

export const NewDriverRequest = z.strictObject({ name: Name, phone: Phone.optional() });
export const UpdateDriverRequest = z
  .strictObject({ name: Name.optional(), phone: Phone.nullable().optional(), active: z.boolean().optional() })
  .refine((body) => Object.keys(body).length > 0, "Nothing to change");

export const NewCarrierRequest = z.strictObject({
  name: Name,
  kind: z.enum(CARRIER_KINDS),
  city: z.string().trim().min(1).max(80).optional(),
});
export const UpdateCarrierRequest = z
  .strictObject({ name: Name.optional(), city: z.string().trim().min(1).max(80).nullable().optional(), active: z.boolean().optional() })
  .refine((body) => Object.keys(body).length > 0, "Nothing to change");

const Stop = z.strictObject({
  consignmentId: Uuid,
  /** Cartons counted at the airport, checked against the file. */
  cartonsCounted: z.number().int().min(0).max(100_000).optional(),
});

export const RoundQuery = PageQuery.extend({ status: z.enum(ROUND_STATUSES).optional() });

/** POST /v1/rounds. A driver or a carrier, and goods from any confirmed files. */
export const NewRoundRequest = z
  .strictObject({
    id: Uuid.optional(),
    driverId: Uuid.optional(),
    carrierId: Uuid.optional(),
    note: Note.optional(),
    stops: z.array(Stop).max(500).default([]),
  })
  .refine((body) => body.driverId !== undefined || body.carrierId !== undefined, {
    path: ["driverId"],
    message: "Pick a driver or a carrier",
  });
export type NewRoundRequest = z.infer<typeof NewRoundRequest>;

/** POST /v1/rounds/:id/stops. */
export const AddStopRequest = Stop;

export const StopParams = z.object({ id: Uuid, consignmentId: Uuid });

/** POST /v1/rounds/:id/depart. The driver leaves. */
export const DepartRequest = z.strictObject({ at: Instant.optional() });

const Result = z
  .strictObject({
    /** Made up by the office app for this row. The same id twice is one result. */
    id: Uuid,
    consignmentId: Uuid,
    outcome: z.enum(ROUND_OUTCOMES),
    /** What the customer handed over, as on the receipt. */
    received: Money.optional(),
    method: z.enum(ROUND_METHODS).optional(),
    /** When the goods and money changed hands. A dinar amount converts at that day's rate. */
    happenedAt: Instant,
    note: Note.optional(),
  })
  .refine((row) => (row.received === undefined) === (row.method === undefined), {
    path: ["method"],
    message: "An amount needs how it was paid, and the other way round",
  });

/**
 * PUT /v1/rounds/:id/results. What happened at each stop, from the receipts
 * and photos. Entering a stop again replaces its result. All rows are saved
 * or none.
 */
export const RoundResultsRequest = z.strictObject({ results: z.array(Result).min(1, "Enter at least one result").max(500) });
export type RoundResultsRequest = z.infer<typeof RoundResultsRequest>;

/** POST .../void. Takes a result, a hand-in or a vault close back. */
export const VoidRequest = z.strictObject({ reason: Reason });

/**
 * POST /v1/rounds/:id/hand-in. The round's cash, counted note by note. A gap
 * between what was counted and what the receipts say needs a note.
 */
export const HandInRequest = z.strictObject({
  /** Made up by the office app. The same id twice is one hand-in. */
  id: Uuid,
  happenedAt: Instant,
  usdNotes: Notes.optional(),
  iqdNotes: Notes.optional(),
  note: Note.optional(),
});
export type HandInRequest = z.infer<typeof HandInRequest>;

/** POST /v1/exceptions. The CEO lets a pay-first customer take goods without paying in full. */
export const NewExceptionRequest = z.strictObject({ consignmentId: Uuid, reason: Reason });

export interface Driver {
  id: string;
  name: string;
  phone: string | null;
  active: boolean;
}

export interface Carrier {
  id: string;
  name: string;
  city: string | null;
  kind: CarrierKind;
  active: boolean;
}

export interface RoundSummary {
  id: string;
  number: number;
  status: RoundStatus;
  driverId: string | null;
  driverName: string | null;
  carrierId: string | null;
  carrierName: string | null;
  leftAt: string | null;
  returnedAt: string | null;
  handedInAt: string | null;
  stops: number;
  results: number;
  /** Pay-first customers who got the goods without paying in full and without an exception. */
  missedCollections: number;
  collectedUsdCents: number;
  collectedIqd: number;
  /** Cash the receipts say was collected and that has not been counted in. */
  gapUsdCents: number;
  gapIqd: number;
}

export interface RoundStop {
  stopId: string;
  consignmentId: string;
  customerId: string;
  customerName: string;
  trust: Trust;
  shipmentId: string;
  shipmentCode: string;
  city: string | null;
  consignmentStatus: ConsignmentStatus;
  cartonsExpected: number | null;
  cartonsReceived: number | null;
  amountDueUsdCents: number;
  remainingUsdCents: number;
  resultId: string | null;
  outcome: RoundOutcome | null;
  receivedAmount: number | null;
  receivedCurrency: Currency | null;
  method: RoundMethod | null;
  iqdPer100Usd: number | null;
  creditedUsdCents: number | null;
  happenedAt: string | null;
  hasPaymentReceipt: boolean;
  hasReceivedReceipt: boolean;
  hasCartonPhoto: boolean;
  hasException: boolean;
  /** True when this stop is the driver forgetting to collect. */
  missedCollection: boolean;
}

export interface RoundCash {
  currency: Currency;
  /** What the receipts say the driver took in cash. */
  collected: number;
  /** What has been counted into the vault. */
  handedIn: number;
  /** Still on the round. */
  gap: number;
}

export interface HandIn {
  id: string;
  happenedAt: string;
  note: string | null;
  voided: boolean;
  voidReason: string | null;
  counts: { currency: Currency; notes: Record<string, number>; counted: number; expected: number; difference: number }[];
}

export interface RoundDetail extends RoundSummary {
  note: string | null;
  createdAt: string;
  stopList: RoundStop[];
  cash: RoundCash[];
  handIns: HandIn[];
}
