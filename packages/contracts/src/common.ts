// Shapes used everywhere.

import { z } from "zod";

export const CURRENCIES = ["USD", "IQD"] as const;
export const Currency = z.enum(CURRENCIES);
export type Currency = z.infer<typeof Currency>;

/**
 * Money in every request: a whole number in the smallest unit, and a currency.
 * { "amount": 8500, "currency": "USD" } is $85.00.
 * { "amount": 123250, "currency": "IQD" } is 123,250 dinars.
 */
export const Money = z.strictObject({
  amount: z.number().int("Money is a whole number: cents or dinars").positive("The amount must be more than zero").max(1e13),
  currency: Currency,
});
export type Money = z.infer<typeof Money>;

/** Dollars only, in cents. Zero is allowed: a prepaid consignment has nothing to collect. */
export const UsdCents = z.number().int("Dollars are sent in cents, as a whole number").min(0, "The amount cannot be negative").max(1e13);

/** A count of notes: note value -> how many. { "10000": 3, "5000": 1 } is three $100 notes and one $50. */
export const Notes = z.record(
  z.string().regex(/^\d{1,12}$/, "A note is named by its value"),
  z.number().int("How many notes is a whole number").min(0).max(999_999_999),
);
export type Notes = z.infer<typeof Notes>;

export const Uuid = z.uuid("That is not an id");

/** An instant, with its offset: "2026-10-03T12:00:00+03:00" or "...Z". */
export const Instant = z.iso.datetime({ offset: true, message: "That is not a date and time" });

/** A Baghdad day: "2026-10-03". */
export const Day = z.iso.date("That is not a day");

/** Why something was done. Required wherever a mistake is being fixed. */
export const Reason = z.string().trim().min(1, "Say why").max(500, "Use at most 500 characters");

export const Note = z.string().trim().max(500, "Use at most 500 characters");

export const Name = z.string().trim().min(1, "Enter a name").max(120, "Use at most 120 characters");

/** Lists come a page at a time, newest first. Send back `nextCursor` to get the next page. */
export const PageQuery = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PageQuery = z.infer<typeof PageQuery>;

export interface Page<T> {
  items: T[];
  /** Null when this was the last page. */
  nextCursor: string | null;
}

export const IdParams = z.object({ id: Uuid });
