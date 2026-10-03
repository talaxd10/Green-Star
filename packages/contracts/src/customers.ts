// Customers: people and agent companies, their phones and shipping marks,
// trust and limits.

import { z } from "zod";
import { IdParams, Name, Note, PageQuery, UsdCents, Uuid } from "./common.ts";

export const CUSTOMER_KINDS = ["person", "agent_company"] as const;
export const TRUSTS = ["trusted", "pay_first"] as const;
export const MARK_MATCHES = ["exact", "prefix"] as const;
export type CustomerKind = (typeof CUSTOMER_KINDS)[number];
export type Trust = (typeof TRUSTS)[number];
export type MarkMatch = (typeof MARK_MATCHES)[number];

const Phone = z.string().trim().min(1, "Enter a phone number").max(64);
const Mark = z.string().trim().min(1, "Enter a mark").max(80, "Use at most 80 characters");

/**
 * GET /v1/customers. `q` is a phone, a mark or part of a name.
 * `filter`: over_limit is trusted customers above their own limit; owing is anyone with a balance.
 */
export const CustomerQuery = PageQuery.extend({
  q: z.string().trim().max(120).optional(),
  trust: z.enum(TRUSTS).optional(),
  filter: z.enum(["over_limit", "owing"]).optional(),
});
export type CustomerQuery = z.infer<typeof CustomerQuery>;

export const NewMark = z.strictObject({
  mark: Mark,
  /** prefix is for an agent company whose mark changes on every file: YARO matches YARO MHAMAD. */
  match: z.enum(MARK_MATCHES).default("exact"),
});
export type NewMark = z.infer<typeof NewMark>;

export const NewPhone = z.strictObject({ phone: Phone, primary: z.boolean().default(false) });
export type NewPhone = z.infer<typeof NewPhone>;

/** POST /v1/customers. A person or an agent company. */
export const NewCustomerRequest = z.strictObject({
  name: Name,
  kind: z.enum(CUSTOMER_KINDS).default("person"),
  phones: z.array(Phone).max(10).default([]),
  marks: z.array(NewMark).max(20).default([]),
});
export type NewCustomerRequest = z.infer<typeof NewCustomerRequest>;

/**
 * PATCH /v1/customers/:id. Trust and limit are the China office's call, so a
 * change to either says who asked. The limit is in cents; null is no limit.
 */
export const UpdateCustomerRequest = z
  .strictObject({
    name: Name.optional(),
    kind: z.enum(CUSTOMER_KINDS).optional(),
    trust: z
      .strictObject({
        trust: z.enum(TRUSTS),
        creditLimitUsdCents: UsdCents.nullable().default(null),
        askedBy: z.string().trim().min(1, "Say who asked for this").max(120),
        note: Note.optional(),
      })
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to change");
export type UpdateCustomerRequest = z.infer<typeof UpdateCustomerRequest>;

/** POST /v1/customers/:id/merge. The duplicate's phones, marks and names move to this customer. */
export const MergeCustomerRequest = z.strictObject({ duplicateId: Uuid });
export type MergeCustomerRequest = z.infer<typeof MergeCustomerRequest>;

export const CustomerChildParams = IdParams.extend({ childId: Uuid });

export interface CustomerSummary {
  id: string;
  name: string;
  kind: CustomerKind;
  trust: Trust;
  /** His own limit, in cents. Null when he has none or is pay first. */
  creditLimitUsdCents: number | null;
  /** What he owes now, in cents. Negative is credit: he paid more than he owes. */
  balanceUsdCents: number;
  overLimit: boolean;
  /** His main phone. */
  phone: string | null;
  phones: string[];
  marks: string[];
  unpaidConsignments: number;
  createdAt: string;
}

export interface CustomerPhone {
  id: string;
  phone: string;
  primary: boolean;
}

export interface CustomerMark {
  id: string;
  mark: string;
  match: MarkMatch;
  firstSeenOn: string;
}

export interface TrustChange {
  trustBefore: Trust;
  trustAfter: Trust;
  limitBeforeUsdCents: number | null;
  limitAfterUsdCents: number | null;
  askedBy: string;
  note: string | null;
  changedBy: string;
  changedAt: string;
}

export interface CustomerDetail extends CustomerSummary {
  phoneList: CustomerPhone[];
  markList: CustomerMark[];
  /** His name exactly as files have written it. */
  aliases: string[];
  trustChanges: TrustChange[];
  /** Set when this customer was a duplicate and was merged into another. */
  mergedInto: string | null;
}
