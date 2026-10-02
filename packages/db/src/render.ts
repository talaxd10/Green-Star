// Turns an entry draft from the domain package into the SQL that posts it.

import type { AccountRef, EntryDraft } from "@green-star/domain";
import { lit } from "./psql.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: string): string {
  if (!UUID.test(value)) throw new TypeError(`not a uuid: ${value}`);
  return `${lit(value)}::uuid`;
}

function accountSql(ref: AccountRef): string {
  switch (ref.type) {
    case "system":
      return `gs_account(${lit(ref.code)})`;
    case "customer":
      return `gs_customer_account(${uuid(ref.customerId)})`;
    case "driver_cash":
      return `gs_driver_cash_account(${uuid(ref.roundId)}, ${lit(ref.currency)}::currency)`;
  }
}

export interface PostOptions {
  happenedAt: Date;
  createdBy: string;
  idempotencyKey: string;
}

/** A single `select gs_post_entry(...)` statement for this draft. */
export function renderPost(draft: EntryDraft, options: PostOptions): string {
  const lines = draft.lines
    .map(
      (line) =>
        `jsonb_build_object('account_id', ${accountSql(line.account)}, 'currency', ${lit(line.currency)}, 'amount', ${line.amount.toString()})`,
    )
    .join(",\n    ");
  return [
    "select gs_post_entry(",
    `  ${lit(draft.kind)}::entry_kind,`,
    `  ${lit(options.happenedAt.toISOString())}::timestamptz,`,
    `  ${uuid(options.createdBy)},`,
    `  ${lit(options.idempotencyKey)},`,
    `  jsonb_build_array(\n    ${lines}\n  ),`,
    `  ${draft.reason === undefined ? "null" : lit(draft.reason)},`,
    `  ${draft.ratePer100 === undefined ? "null" : String(draft.ratePer100)}`,
    ");",
  ].join("\n");
}
