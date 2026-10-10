// Fills a development database with a made-up office, so the screens have
// something to show. Every name, number and amount here is invented.
//
//   pnpm db:reset
//   pnpm --filter @green-star/api seed-demo
//
// Sign in as the CEO with 0770 000 0001. The password is in DEMO_PASSWORD below.
//
// Everything goes in through the API's own routes, the way the office app
// sends it, so the demo data obeys every rule the real data will.

import { randomUUID } from "node:crypto";
import { requireEnv } from "@green-star/db";
import pg from "pg";
import { buildApp } from "../src/app.ts";
import { hashPassword } from "../src/auth/passwords.ts";
import { configFromEnv, SCRYPT_COST } from "../src/config.ts";
import { Db } from "../src/db.ts";

const DEMO_PASSWORD = "greenstar-demo";
const RATE = 145_000;

const ownerUrl = requireEnv("DATABASE_URL");
const database = new URL(ownerUrl).pathname.slice(1);
if (!/dev|test/.test(database)) {
  console.error(`Refusing to put demo data into "${database}". This is for dev and test databases only.`);
  process.exit(1);
}

const config = { ...configFromEnv(), log: false, cookieSecure: false };
const db = new Db(config.databaseUrl);
const app = await buildApp(config, db);
const owner = new pg.Client({ connectionString: ownerUrl });
await owner.connect();

const existing = await owner.query("select count(*)::int as n from users");
if (existing.rows[0].n > 0) {
  console.error("This database already has users. Run `pnpm db:reset` first.");
  process.exit(1);
}

// The first CEO, the way create-ceo makes him.
const ceo = await owner.query<{ id: string }>("insert into users (name, role, phone) values ('Sarkar', 'ceo', '+9647700000001') returning id");
await owner.query("insert into user_credentials (user_id, password_hash) values ($1, $2)", [
  (ceo.rows[0] as { id: string }).id,
  await hashPassword(DEMO_PASSWORD, SCRYPT_COST),
]);

let cookie = "";
// The replies are whatever the API sent; this script only reads ids from them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function send(method: string, url: string, body?: unknown): Promise<any> {
  const response = await app.inject({
    method: method as "POST",
    url,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  if (response.statusCode >= 400) {
    throw new Error(`${method} ${url} -> ${response.statusCode} ${response.body}`);
  }
  const set = response.headers["set-cookie"];
  const line = Array.isArray(set) ? set[0] : set;
  if (typeof line === "string" && line.startsWith("gs_session=")) cookie = line.split(";")[0] as string;
  return response.body.length > 0 ? JSON.parse(response.body) : null;
}

const ago = (days: number, hour = 9) => {
  const d = new Date(Date.now() - days * 86_400_000);
  d.setUTCHours(hour - 3, 0, 0, 0);   // Baghdad is UTC+3
  return d > new Date() ? new Date(Date.now() - 60_000).toISOString() : d.toISOString();
};
const dayOf = (iso: string) => new Date(Date.parse(iso) + 3 * 3_600_000).toISOString().slice(0, 10);

await send("POST", "/v1/auth/login", { phone: "0770 000 0001", password: DEMO_PASSWORD });

// A week of rates, the way he sets one each morning.
for (const [days, rate] of [[6, 144_500], [5, 144_750], [4, 145_250], [3, 145_000], [2, 144_750], [1, 145_250], [0, RATE]] as const) {
  await send("PUT", `/v1/fx-rates/${dayOf(ago(days, 1))}`, { iqdPer100Usd: rate, confirm: true });
}

const customer = async (name: string, phone: string, marks: unknown[] = [], trusted?: number | null, kind = "person") => {
  const made = await send("POST", "/v1/customers", { name, kind, phones: [phone], marks });
  if (trusted !== undefined) {
    await send("PATCH", `/v1/customers/${made.id}`, { trust: { trust: "trusted", creditLimitUsdCents: trusted, askedBy: "China office", note: "Ships every week" } });
  }
  return made.id as string;
};

const rebwar = await customer("Rebwar A.", "0750 111 2001", [{ mark: "REBWAR ALI" }]);
const shvan = await customer("Shvan K.", "0750 111 2002", [{ mark: "SHVAN" }]);
const dara = await customer("Dara M.", "0770 111 2003", [{ mark: "DARA M" }], 500_000);
const hemn = await customer("Hemn S.", "0750 111 2004", [{ mark: "HEMN SALIH" }]);
const yaro = await customer("Yaro Trading", "0770 111 2005", [{ mark: "YARO", match: "prefix" }], 1_500_000, "agent_company");
const avin = await customer("Avin R.", "0751 111 2006", [{ mark: "AVIN" }], 200_000);
const karzan = await customer("Karzan H.", "0750 111 2007", [{ mark: "KARZAN" }]);
const nasrin = await customer("نەسرین ئەحمەد", "0770 111 2008", [{ mark: "NASRIN" }]);
const goran = await customer("Goran T.", "0750 111 2009", [{ mark: "GORAN" }], 300_000);
const soran = await customer("Soran B.", "0771 111 2010", [{ mark: "SORAN" }]);
const lana = await customer("Lana J.", "0750 111 2011", [{ mark: "LANA" }]);
const baxtyar = await customer("Baxtyar O.", "0770 111 2012", [{ mark: "BAXTYAR" }]);

const file = async (code: string, days: number, rows: [string, number, number?, string?][], confirm = true) => {
  const made = await send("POST", "/v1/shipments", {
    code,
    arrivedOn: dayOf(ago(days)),
    consignments: rows.map(([customerId, amountDueUsdCents, cartonsExpected, city]) => ({
      customerId,
      amountDueUsdCents,
      ...(cartonsExpected === undefined ? {} : { cartonsExpected }),
      ...(city === undefined ? {} : { city }),
    })),
  });
  if (confirm) await send("POST", `/v1/shipments/${made.id}/confirm`, { confirmedAt: ago(days, 10) });
  const by: Record<string, string> = {};
  for (const c of made.consignmentList) by[c.customerId] = c.id;
  return { id: made.id as string, by };
};

const karwan = (await send("POST", "/v1/drivers", { name: "Karwan", phone: "0750 222 3001" })).id;
const bestun = (await send("POST", "/v1/drivers", { name: "Bestun", phone: "0770 222 3002" })).id;
await send("POST", "/v1/carriers", { name: "Mosul transport office", kind: "transport_office", city: "Mosul" });

const round = async (driverId: string, stops: [string, number?][], leftDays: number) => {
  const made = await send("POST", "/v1/rounds", { driverId, stops: stops.map(([consignmentId, cartonsCounted]) => ({ consignmentId, ...(cartonsCounted === undefined ? {} : { cartonsCounted }) })) });
  await send("POST", `/v1/rounds/${made.id}/depart`, { at: ago(leftDays, 8) });
  return made.id as string;
};
const result = (consignmentId: string, outcome: string, at: string, received?: { amount: number; currency: string }, method = "driver_cash") => ({
  id: randomUUID(),
  consignmentId,
  outcome,
  happenedAt: at,
  ...(received === undefined ? {} : { received, method }),
});

// -- Last week: a file that went out, was paid, counted in, and closed itself.
const f1 = await file("GSSK6926", 6, [[rebwar, 12_400, 4, "Erbil"], [dara, 46_000, 11, "Sulaymaniyah"], [karzan, 7_500, 2, "Erbil"], [lana, 0, 1, "Erbil"]]);
const r1 = await round(karwan, [[f1.by[rebwar] as string, 4], [f1.by[dara] as string, 11], [f1.by[karzan] as string, 2], [f1.by[lana] as string, 1]], 5);
// Money for the road before Karwan left.
const driverMoney = (driverId: string, body: object) => send("POST", `/v1/drivers/${driverId}/money`, body);
await driverMoney(karwan, { what: "advance", amount: { amount: 500_000, currency: "IQD" }, roundId: r1, happenedAt: ago(5, 7), note: "For the Erbil round" });
await send("PUT", `/v1/rounds/${r1}/results`, {
  results: [
    // Rebwar owed $124.00 and paid $130.00; Karwan gave him 8,700 IQD back from his own account.
    { ...result(f1.by[rebwar] as string, "paid", ago(5, 12), { amount: 13_000, currency: "USD" }), changeIqd: 8_700 },
    result(f1.by[dara] as string, "on_account", ago(5, 14)),
    result(f1.by[karzan] as string, "paid", ago(5, 15), { amount: 108_750, currency: "IQD" }),
    result(f1.by[lana] as string, "prepaid", ago(5, 16)),
  ],
});
await send("POST", `/v1/rounds/${r1}/hand-in`, { id: randomUUID(), happenedAt: ago(4, 10), usdNotes: { 10000: 1, 2000: 1, 1000: 1 }, iqdNotes: { 50000: 2, 5000: 1, 1000: 3, 250: 3 } });
// His receipts from that round, and what he gave back.
await driverMoney(karwan, { what: "expense", category: "fuel_car", amount: { amount: 45_000, currency: "IQD" }, roundId: r1, city: "Erbil", happenedAt: ago(4, 10) });
await driverMoney(karwan, { what: "expense", category: "transport", amount: { amount: 75_000, currency: "IQD" }, roundId: r1, city: "Erbil", note: "Erbil transport company took 6 cartons", happenedAt: ago(4, 10) });
await driverMoney(karwan, { what: "expense", category: "workers", amount: { amount: 15_000, currency: "IQD" }, roundId: r1, city: "Sulaymaniyah", happenedAt: ago(4, 10) });
await driverMoney(karwan, { what: "return", amount: { amount: 300_000, currency: "IQD" }, happenedAt: ago(4, 11) });
await send("POST", "/v1/payments", { customerId: dara, received: { amount: 30_000, currency: "USD" }, method: "fib", happenedAt: ago(3, 11), note: "FIB transfer, ref 88214" });

// -- This week: the board's round 14. One paid in dinars, one held, one on account, one the driver forgot.
const f2 = await file("GSSK6931", 3, [[rebwar, 8_500, 3, "Erbil"], [shvan, 4_000, 1, "Kirkuk"], [yaro, 128_000, 26, "Erbil"], [nasrin, 15_500, 5, "Duhok"]]);
const f3 = await file("GSSK6934", 2, [[dara, 31_000, 8, "Sulaymaniyah"], [hemn, 6_200, 2, "Duhok"], [avin, 22_750, 6, "Erbil"], [soran, 9_800, 3, "Kirkuk"]]);
const r2 = await round(karwan, [[f2.by[rebwar] as string, 3], [f2.by[shvan] as string, 1], [f3.by[dara] as string, 8], [f3.by[hemn] as string, 2], [f3.by[soran] as string, 2]], 1);
await driverMoney(karwan, { what: "advance", amount: { amount: 250_000, currency: "IQD" }, roundId: r2, happenedAt: ago(1, 7) });
await driverMoney(karwan, { what: "expense", category: "fuel_car", amount: { amount: 35_000, currency: "IQD" }, roundId: r2, city: "Kirkuk", happenedAt: ago(1, 18) });
await driverMoney(karwan, { what: "expense", category: "car_parts", amount: { amount: 60_000, currency: "IQD" }, roundId: r2, city: "Kirkuk", note: "New tyre", happenedAt: ago(1, 18) });
await send("PUT", `/v1/rounds/${r2}/results`, {
  results: [
    result(f2.by[rebwar] as string, "paid", ago(1, 13), { amount: 123_500, currency: "IQD" }),
    result(f2.by[shvan] as string, "held", ago(1, 14)),
    result(f3.by[dara] as string, "on_account", ago(1, 15)),
    result(f3.by[hemn] as string, "unpaid", ago(1, 16)),
    result(f3.by[soran] as string, "paid", ago(1, 17), { amount: 9_800, currency: "USD" }, "fastpay"),
  ],
});
await send("POST", "/v1/disputes", { consignmentId: f2.by[nasrin], kind: "damaged", note: "Two cartons crushed at the corners" });

// -- Out now: Bestun, with the agent company's goods.
await round(bestun, [[f2.by[yaro] as string, 26], [f3.by[avin] as string, 6]], 0);

// -- Arrived yesterday and confirmed, waiting for a round. And one still a draft.
await file("GSSK6940", 1, [[goran, 18_250, 5, "Erbil"], [baxtyar, 5_400, 1, "Erbil"], [karzan, 11_000, 3, "Erbil"], [lana, 0, 2, "Erbil"]]);
await file("GSSK6944", 0, [[rebwar, 9_900, 3, "Erbil"], [nasrin, 14_000, 4, "Duhok"]], false);

// -- Money at the office.
await send("POST", "/v1/payments", { customerId: karzan, received: { amount: 5_000, currency: "USD" }, method: "office_cash", happenedAt: ago(1, 11) });
await send("POST", "/v1/payments", { customerId: goran, received: { amount: 145_000, currency: "IQD" }, method: "zaincash", happenedAt: ago(0, 9) });
// Baxtyar pays for the file that is waiting, in two ways: $27 in dollars and the rest in dinars.
// The rest is 39,150 IQD at 1,450; he hands over 39,000, and that settles it.
await send("POST", "/v1/payments/parts", {
  customerId: baxtyar,
  parts: [
    { received: { amount: 2_700, currency: "USD" }, method: "office_cash" },
    { received: { amount: 39_000, currency: "IQD" }, method: "office_cash" },
  ],
  happenedAt: ago(0, 10),
  note: "Paid before the goods went out",
});
// Two dollars nobody will chase.
await send("POST", "/v1/errors", { customerId: karzan, amountUsdCents: 200, happenedAt: ago(0, 10), note: "Change he was owed from last week" });
await send("POST", "/v1/cash-outs", { category: "fuel_car", amount: { amount: 40_000, currency: "IQD" }, reason: "Fuel for the Kirkuk round", happenedAt: ago(1, 8) });
await send("POST", "/v1/cash-outs", { category: "driver_pay", amount: { amount: 5_000, currency: "USD" }, reason: "Karwan, week of 27 September", happenedAt: ago(2, 17) });
await send("POST", "/v1/cash-outs", { category: "china", amount: { amount: 10_000, currency: "USD" }, reason: "Sent with Kak Azad's transfer", happenedAt: ago(2, 12) });

// -- Yesterday's vault close: counted, and $2 short with a note.
const vault = await send("GET", "/v1/vault");
const expected = (currency: string) => vault.currencies.find((c: { currency: string }) => c.currency === currency).expectedNow as number;
const notesFor = (amount: number, values: number[]) => {
  const notes: Record<string, number> = {};
  let left = amount;
  for (const value of values) {
    const count = Math.floor(left / value);
    if (count > 0) notes[value] = count;
    left -= count * value;
  }
  return notes;
};
await send("POST", "/v1/vault/close", {
  id: randomUUID(),
  closedAt: ago(0, 8),
  usdNotes: notesFor(Math.max(expected("USD") - 200, 0), [10000, 5000, 2000, 1000, 500, 200, 100]),
  iqdNotes: notesFor(expected("IQD"), [50000, 25000, 10000, 5000, 1000, 500, 250]),
  note: "$2 short. Counted twice. Will check yesterday's receipts.",
});

// -- The wallet check: FastPay was read in its app and matches. FIB and ZainCash are still to check.
const { wallets } = await send("GET", "/v1/wallets");
const fastpay = wallets.find((w: { code: string }) => w.code === "wallet_fastpay_usd");
await send("POST", "/v1/wallets/checks", { id: randomUUID(), wallet: "wallet_fastpay_usd", appBalance: fastpay.expectedInApp });

// -- Statements: Yaro Trading was sent what it owes. The other trusted customers are still to send.
const yaroStatement = randomUUID();
await send("POST", `/v1/customers/${yaro}/statement/export`, { id: yaroStatement });
await send("POST", `/v1/statements/${yaroStatement}/sent`, {});

const health = await owner.query("select problem, detail from gs_ledger_health()");
if (health.rows.length > 0) {
  console.error("The demo data left the books unsound:", health.rows);
  process.exit(1);
}

await owner.end();
await app.close();
await db.close();
console.log(`Demo office ready in ${database}.
  CEO      0770 000 0001
  Password ${DEMO_PASSWORD}`);
