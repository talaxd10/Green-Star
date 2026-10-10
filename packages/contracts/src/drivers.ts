// The driver's own account, his receipts, and what delivery costs.

import { z } from "zod";
import { Currency, Day, Instant, Money, Note, Uuid } from "./common.ts";

/** What an expense was for. The first five are the cost of delivering. */
export const EXPENSE_CATEGORIES = ["fuel_car", "car_parts", "workers", "transport", "driver_pay", "customs_airport", "rent_salaries", "other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const DELIVERY_CATEGORIES: readonly ExpenseCategory[] = ["fuel_car", "car_parts", "workers", "transport", "driver_pay"];

const City = z.string().trim().min(1).max(80);

export const DRIVER_MONEY = ["advance", "expense", "return"] as const;
export type DriverMoneyKind = (typeof DRIVER_MONEY)[number];

/**
 * POST /v1/drivers/:id/money. Money given to the driver from the vault
 * (advance), a receipt he brought back (expense), or what he gave back
 * (return). An expense says what kind it was; a city and a round are optional.
 */
export const DriverMoneyRequest = z
  .strictObject({
    what: z.enum(DRIVER_MONEY),
    amount: Money,
    category: z.enum(EXPENSE_CATEGORIES).optional(),
    roundId: Uuid.optional(),
    city: City.optional(),
    note: Note.optional(),
    happenedAt: Instant.optional(),
  })
  .refine((body) => (body.what === "expense") === (body.category !== undefined), {
    path: ["category"],
    message: "Say what kind of expense it was",
  });
export type DriverMoneyRequest = z.infer<typeof DriverMoneyRequest>;

export interface DriverAccount {
  driverId: string;
  name: string;
  phone: string | null;
  active: boolean;
  /** The office's money he holds. Below zero: the office owes him (he spent his own). */
  holdsUsdCents: number;
  holdsIqd: number;
  lastMovedAt: string | null;
}

export type DriverLineKind = "advance" | "expense" | "return" | "change";

export interface DriverAccountLine {
  entryId: string;
  kind: DriverLineKind;
  currency: Currency;
  /** Positive when he holds more of the office's money. */
  amount: number;
  balanceAfter: number;
  category: ExpenseCategory | null;
  roundId: string | null;
  roundNumber: number | null;
  city: string | null;
  note: string | null;
  /** For change at a door: whose. */
  customerName: string | null;
  happenedAt: string;
  isReversal: boolean;
  reversed: boolean;
}

export interface DriverAccountDetail extends DriverAccount {
  lines: DriverAccountLine[];
}

export const DeliveryCostsQuery = z.object({ from: Day.optional(), to: Day.optional() });
export type DeliveryCostsQuery = z.infer<typeof DeliveryCostsQuery>;

export interface CostLine {
  usdCents: number;
  /** As paid, before counting in dollars. */
  usdPaid: number;
  iqdPaid: number;
}

/** GET /v1/reports/delivery-costs. Every expense in the time, counted in dollars at the rate of its day. */
export interface DeliveryCosts {
  from: string;
  to: string;
  /** The cost of delivering: fuel, car parts, workers, transport between cities, driver pay. */
  delivery: CostLine;
  /** Everything else that was paid out: customs and airport, rent and salaries, other. */
  other: CostLine;
  /** Goods handed over to customers on rounds in the time. */
  delivered: { rounds: number; customers: number; weightGrams: number };
  /** Delivery cost per customer's goods handed over, and per kilogram. Null when nothing was delivered. */
  perDeliveryUsdCents: number | null;
  perKgUsdCents: number | null;
  byCategory: (CostLine & { category: ExpenseCategory; label: string; delivery: boolean })[];
  byMonth: (CostLine & { month: string; deliveredCustomers: number; rounds: number })[];
  byCity: (CostLine & { city: string; deliveredCustomers: number })[];
  byRound: (CostLine & { roundId: string; number: number; driverName: string | null; carrierName: string | null; leftAt: string | null; deliveredCustomers: number })[];
  /** Days with dinar expenses and no rate set: counted at the nearest day's rate. */
  daysWithoutRate: string[];
}
