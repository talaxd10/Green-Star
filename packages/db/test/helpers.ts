// Shared by the database tests. Statements run as the application's role
// unless they go through owner().

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AccountRef, EntryDraft } from "@green-star/domain";
import { lit, psql, PsqlError, renderPost, requireEnv } from "../src/index.ts";

export const OWNER = requireEnv("DATABASE_URL");
export const APP = requireEnv("APP_DATABASE_URL");
export const USER = "99999999-9999-4999-8999-999999999999";

export const app = (sql: string) => psql(APP, sql);
export const owner = (sql: string) => psql(OWNER, sql);

export function post(draft: EntryDraft, happenedAt = new Date("2026-10-02T09:00:00Z"), key: string = randomUUID()): string {
  return app(renderPost(draft, { happenedAt, createdBy: USER, idempotencyKey: key }));
}

export function refused(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof PsqlError, `expected a database error, got ${String(error)}`);
    assert.match(error.stderr, pattern);
    return true;
  });
}

/** Sets a day's rate. Tests use rates far apart, so the jump is confirmed up front. */
export function setRate(day: string, ratePer100: number): void {
  app(`select gs_set_rate(${lit(day)}, ${ratePer100}, ${lit(USER)}, true);`);
}

export function newCustomer(name = "Test customer"): string {
  const id = randomUUID();
  app(`insert into customers (id, display_name) values (${lit(id)}, ${lit(name)});`);
  return id;
}

let shipmentCounter = 0;

/** SQL that creates a draft file with one consignment per [customer, cents] pair. */
export function draftShipmentSql(shipmentId: string, consignments: readonly (readonly [string, bigint, string?])[]): string {
  shipmentCounter += 1;
  const code = `GSSK-T${Date.now().toString(36)}${shipmentCounter}`;
  const rows = consignments
    .map(([customerId, cents, id]) => `(${lit(id ?? randomUUID())}, ${lit(shipmentId)}, ${lit(customerId)}, ${cents})`)
    .join(", ");
  return [
    `insert into shipments (id, code) values (${lit(shipmentId)}, ${lit(code)});`,
    `insert into consignments (id, shipment_id, customer_id, amount_due_usd_cents) values ${rows};`,
  ].join("\n");
}

export function confirmSql(shipmentId: string, at: Date): string {
  return `select gs_confirm_shipment(${lit(shipmentId)}, ${lit(USER)}, ${lit(at.toISOString())});`;
}

/** Charges one customer through a one-line file, the only way a charge can be posted. */
export function charge(customerId: string, cents: bigint, at = new Date("2026-10-02T08:00:00Z")): { shipmentId: string; consignmentId: string } {
  const shipmentId = randomUUID();
  const consignmentId = randomUUID();
  app(`${draftShipmentSql(shipmentId, [[customerId, cents, consignmentId]])}\n${confirmSql(shipmentId, at)}`);
  return { shipmentId, consignmentId };
}

export function balances(): Map<string, bigint> {
  const out = app(
    `select coalesce(a.code,
              case a.kind when 'customer' then 'customer:' || a.customer_id
                          else 'driver:' || a.round_id || ':' || a.currency end)
            || '=' || coalesce(b.balance, 0)
     from accounts a left join account_balances b on b.account_id = a.id;`,
  );
  const map = new Map<string, bigint>();
  for (const row of out.split("\n").filter(Boolean)) {
    const at = row.lastIndexOf("=");
    map.set(row.slice(0, at), BigInt(row.slice(at + 1)));
  }
  return map;
}

export function keyOf(ref: AccountRef): string {
  switch (ref.type) {
    case "system":
      return ref.code;
    case "customer":
      return `customer:${ref.customerId}`;
    case "driver_cash":
      return `driver:${ref.roundId}:${ref.currency}`;
  }
}

export const customerBalance = (customerId: string) =>
  BigInt(app(`select coalesce((select balance_usd_cents from customer_balances where customer_id = ${lit(customerId)}), 0);`));

export const health = () => app("select problem || ': ' || detail from gs_ledger_health();");

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

export function newDriver(name = "Karwan"): string {
  const id = randomUUID();
  app(`insert into drivers (id, name) values (${lit(id)}, ${lit(name)});`);
  return id;
}

/** A planned round for a driver, with these consignments on it. */
export function newRound(consignmentIds: readonly string[] = [], driverId: string = newDriver()): string {
  const id = randomUUID();
  app(
    [
      `insert into rounds (id, driver_id, created_by) values (${lit(id)}, ${lit(driverId)}, ${lit(USER)});`,
      ...consignmentIds.map((c) => `select gs_add_round_stop(${lit(id)}, ${lit(c)}, ${lit(USER)});`),
    ].join("\n"),
  );
  return id;
}

/** A round that has left with these consignments. */
export function roundOut(consignmentIds: readonly string[], at = new Date("2026-10-02T06:00:00Z")): string {
  const id = newRound(consignmentIds);
  app(`select gs_round_depart(${lit(id)}, ${lit(USER)}, ${lit(at.toISOString())});`);
  return id;
}

export type Outcome = "paid" | "on_account" | "prepaid" | "held" | "unpaid";
export type Method = "driver_cash" | "fib" | "fastpay" | "zaincash" | "office_cash";

export interface ResultInput {
  roundId: string;
  consignmentId: string;
  outcome: Outcome;
  received?: { amount: bigint | number; currency: "USD" | "IQD"; method?: Method };
  at?: Date;
  id?: string;
}

export function resultSql(input: ResultInput): string {
  const at = input.at ?? new Date("2026-10-02T12:00:00Z");
  const money = input.received
    ? `${input.received.amount}, ${lit(input.received.currency)}, ${lit(input.received.method ?? "driver_cash")}`
    : "null, null, null";
  return `select gs_enter_round_result(${lit(input.id ?? randomUUID())}, ${lit(input.roundId)}, ${lit(input.consignmentId)}, ${lit(input.outcome)}, ${lit(USER)}, ${lit(at.toISOString())}, ${money});`;
}

/** Enters what happened at one stop. Returns the result's id. */
export const enterResult = (input: ResultInput) => app(resultSql(input));

export type Notes = Record<number, number>;

export function handInSql(
  roundId: string,
  counted: { usd?: Notes; iqd?: Notes; note?: string; at?: Date; id?: string } = {},
): string {
  const at = counted.at ?? new Date("2026-10-02T15:00:00Z");
  const json = (notes: Notes | undefined) => (notes ? `${lit(JSON.stringify(notes))}::jsonb` : "null");
  return `select gs_hand_in_round(${lit(counted.id ?? randomUUID())}, ${lit(roundId)}, ${lit(USER)}, ${lit(at.toISOString())}, ${json(counted.usd)}, ${json(counted.iqd)}, ${counted.note === undefined ? "null" : lit(counted.note)});`;
}

/** Counts a round's cash in, note by note. Returns the hand-in's id. */
export const handIn = (roundId: string, counted: Parameters<typeof handInSql>[1] = {}) => app(handInSql(roundId, counted));

export const consignmentStatus = (consignmentId: string) =>
  app(`select status from consignments where id = ${lit(consignmentId)};`);

export const shipmentStatus = (shipmentId: string) => app(`select status from shipments where id = ${lit(shipmentId)};`);

export function makeTrusted(customerId: string, limitUsdCents: bigint | null = null): void {
  app(`select gs_set_customer_trust(${lit(customerId)}, 'trusted', ${limitUsdCents === null ? "null" : limitUsdCents}, ${lit(USER)}, 'China office');`);
}
