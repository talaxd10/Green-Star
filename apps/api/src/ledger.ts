// Posting to the ledger. The lines of each money event are built by
// packages/domain; this hands them to gs_post_entry, the only way in.

import type { AccountRef, EntryDraft } from "@green-star/domain";
import type { Queryable } from "./db.ts";

export interface PostOptions {
  happenedAt: Date;
  /** The signed-in CEO. The database refuses an entry that names anyone else. */
  createdBy: string;
  /** Posts once, however many times it is sent. */
  key: string;
  /** The consignment a payment was made for. It is paid before the customer's older ones. */
  forConsignment?: string | undefined;
  /** Overrides the draft's reason: a note typed with a payment. */
  reason?: string | undefined;
}

/** Posts one entry and returns its id. */
export async function postEntry(q: Queryable, draft: EntryDraft, options: PostOptions): Promise<string> {
  const params: unknown[] = [];
  const p = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const account = (ref: AccountRef): string => {
    switch (ref.type) {
      case "system":
        return `gs_account(${p(ref.code)}::text)`;
      case "customer": {
        const id = p(ref.customerId);
        return `gs_customer_account(${id}::uuid, (select display_name from customers where id = ${id}::uuid))`;
      }
      case "driver_cash":
        // Round money is posted by the round's own functions, never from here.
        throw new Error("driver cash is posted by entering a round result");
    }
  };
  const lines = draft.lines
    .map(
      (line) =>
        `jsonb_build_object('account_id', ${account(line.account)}, 'currency', ${p(line.currency)}::text, 'amount', ${p(line.amount.toString())}::bigint)`,
    )
    .join(", ");
  const sql = `select gs_post_entry(
    ${p(draft.kind)}::entry_kind, ${p(options.happenedAt)}::timestamptz, ${p(options.createdBy)}::uuid, ${p(options.key)}::text,
    jsonb_build_array(${lines}),
    ${p(options.reason ?? draft.reason ?? null)}::text, ${p(draft.ratePer100 ?? null)}::integer, null::uuid, ${p(options.forConsignment ?? null)}::uuid)`;
  return q.value<string>(sql, params);
}

/** The dinar rate of the Baghdad day an instant falls on. Raises rate_missing when it is not set. */
export function dayRate(q: Queryable, at: Date): Promise<number> {
  return q.value<number>("select gs_day_rate($1::timestamptz)", [at]);
}
