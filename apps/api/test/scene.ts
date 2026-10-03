// Sets a scene through the API itself, the way the office app will.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { call, nextPhone, type Harness, type Reply } from "./helpers.ts";

export const RATE = 145_000; // 1,450 dinars per dollar

function ok(reply: Reply, status: number, what: string): Reply {
  assert.equal(reply.status, status, `${what}: ${reply.status} ${JSON.stringify(reply.body)}`);
  return reply;
}

let counter = 0;
/** A word no other test uses, for names that are searched for. */
export const unique = (prefix = "T") => `${prefix}${Date.now().toString(36)}${(++counter).toString(36)}${randomUUID().slice(0, 4)}`.toUpperCase();

export class Scene {
  readonly h: Harness;
  /** The CEO's session. */
  readonly cookie: string;

  constructor(h: Harness, cookie: string) {
    this.h = h;
    this.cookie = cookie;
  }

  get(url: string, cookie = this.cookie) {
    return call(this.h.app, "GET", url, { cookie });
  }

  send(method: string, url: string, body?: unknown, key?: string | null) {
    return call(this.h.app, method, url, { cookie: this.cookie, body, ...(key === undefined ? {} : { key }) });
  }

  async customer(name = unique("CUST "), extra: { trusted?: boolean; limitUsdCents?: number | null; phones?: string[]; marks?: unknown[] } = {}): Promise<string> {
    const made = ok(await this.send("POST", "/v1/customers", { name, phones: extra.phones ?? [nextPhone()], marks: extra.marks ?? [] }), 201, "add a customer");
    if (extra.trusted) {
      ok(
        await this.send("PATCH", `/v1/customers/${made.body.id}`, {
          trust: { trust: "trusted", creditLimitUsdCents: extra.limitUsdCents ?? null, askedBy: "China office" },
        }),
        200,
        "make him trusted",
      );
    }
    return made.body.id;
  }

  /** A draft file with one row per [customer, cents]. Returns the file and its consignments by customer. */
  async draft(rows: readonly (readonly [string, number])[], code = unique("GSSK")): Promise<{ id: string; code: string; by: Record<string, string> }> {
    const made = ok(
      await this.send("POST", "/v1/shipments", { code, consignments: rows.map(([customerId, amountDueUsdCents]) => ({ customerId, amountDueUsdCents })) }),
      201,
      "type a file in",
    );
    const by: Record<string, string> = {};
    for (const c of made.body.consignmentList) by[c.customerId] = c.id;
    return { id: made.body.id, code, by };
  }

  /** A confirmed file. Each customer on it now owes his amount. */
  async file(rows: readonly (readonly [string, number])[]): Promise<{ id: string; code: string; by: Record<string, string> }> {
    const draft = await this.draft(rows);
    ok(await this.send("POST", `/v1/shipments/${draft.id}/confirm`, {}), 200, "confirm the file");
    return draft;
  }

  async rate(iqdPer100Usd = RATE, day = "today"): Promise<void> {
    ok(await this.send("PUT", `/v1/fx-rates/${day}`, { iqdPer100Usd, confirm: true }), 200, "set the rate");
  }

  async driver(name = unique("Driver ")): Promise<string> {
    return ok(await this.send("POST", "/v1/drivers", { name }), 201, "add a driver").body.id;
  }

  /** A round that has left with these consignments. */
  async roundOut(consignmentIds: readonly string[]): Promise<string> {
    const driverId = await this.driver();
    const round = ok(await this.send("POST", "/v1/rounds", { driverId, stops: consignmentIds.map((consignmentId) => ({ consignmentId })) }), 201, "create a round");
    ok(await this.send("POST", `/v1/rounds/${round.body.id}/depart`, {}), 200, "send it out");
    return round.body.id;
  }

  async balance(customerId: string): Promise<number> {
    return ok(await this.get(`/v1/customers/${customerId}`), 200, "read a customer").body.balanceUsdCents;
  }

  /** What is on a system account now, such as vault_usd or wallet_fib_iqd. */
  async account(code: string): Promise<number> {
    const { body } = ok(await this.get("/v1/accounts"), 200, "read the accounts");
    const found = body.items.find((a: { code: string | null }) => a.code === code);
    assert.ok(found, `no account ${code}`);
    return found.balance;
  }

  /** Nothing in the ledger, the rounds or the statuses is out of step. */
  async sound(): Promise<void> {
    const { rows } = await this.h.owner.query("select problem, detail from gs_ledger_health()");
    assert.deepEqual(rows, []);
  }
}

export const result = (consignmentId: string, outcome: string, received?: { amount: number; currency: "USD" | "IQD" }, method = "driver_cash") => ({
  id: randomUUID(),
  consignmentId,
  outcome,
  happenedAt: new Date().toISOString(),
  ...(received === undefined ? {} : { received, method }),
});
