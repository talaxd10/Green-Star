// Checks and alerts, the Today screen, the wallet check and the office settings.

import { z } from "zod";
import { type Currency, Instant, Note, PageQuery, Reason, Uuid } from "./common.ts";
import type { ShipmentStatus } from "./shipments.ts";
import type { RoundSummary } from "./rounds.ts";
import type { Rate } from "./money.ts";

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export const ALERT_KINDS = [
  "missed_collection", // a pay-first customer got the goods without paying in full. His top alert
  "round_cash_gap", // a round's cash was counted in and does not match its receipts
  "vault_gap", // the vault was counted and does not match
  "vault_not_closed", // cash moved and the vault was not counted by closing time
  "carton_mismatch", // cartons counted at the airport differ from the file
  "over_limit", // a trusted customer owes more than his own limit
  "held_too_long", // goods held in the car longer than the set number of days
  "wallet_gap", // a wallet's app showed something else than the books
  "wallet_check_due", // wallet money has gone unchecked for too long
  "payment_at_old_rate", // a dinar payment stands at a rate the day no longer has
  "books_out_of_step", // the ledger's own health check found something
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_SEVERITIES = ["high", "medium", "low"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/**
 * open: waiting for the CEO. resolved: he closed it with a note. cleared: it
 * stopped being wrong by itself (the customer paid, the rest of the cash came in).
 */
export const ALERT_STATUSES = ["open", "resolved", "cleared"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export interface Alert {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  status: AlertStatus;
  /** One line a person can read. */
  title: string;
  /** True while the thing is still wrong. A resolved alert can still be true here. */
  stillWrong: boolean;
  customerId: string | null;
  customerName: string | null;
  consignmentId: string | null;
  shipmentId: string | null;
  shipmentCode: string | null;
  roundId: string | null;
  roundNumber: number | null;
  /** The amount it is about, when there is one. Negative is short. */
  amount: number | null;
  currency: Currency | null;
  openedAt: string;
  resolvedAt: string | null;
  resolvedByName: string | null;
  note: string | null;
  clearedAt: string | null;
}

/** GET /v1/alerts. Open alerts unless a status is named. Newest first. */
export const AlertQuery = PageQuery.extend({
  status: z.enum(ALERT_STATUSES).default("open"),
  kind: z.enum(ALERT_KINDS).optional(),
});

/** GET /v1/alerts/count. For the badge in the menu. */
export interface AlertCount {
  open: number;
  /** How many of the open ones are the serious kind. */
  high: number;
}

/** POST /v1/alerts/:id/resolve. Say what was done about it. */
export const ResolveAlertRequest = z.strictObject({ note: Reason });

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

export interface TodayCash {
  currency: Currency;
  /** What the receipts say drivers took in cash on the rounds below. */
  collected: number;
  /** What has been counted into the vault from those rounds. */
  counted: number;
  /** Still with the drivers, or missing. */
  gap: number;
}

export interface TodayFile {
  id: string;
  code: string;
  status: ShipmentStatus;
  consignments: number;
  notDelivered: number;
  deliveredNotPaid: number;
  waitingForHandIn: number;
  disputesWaiting: number;
  expectedUsdCents: number;
  collectedUsdCents: number;
}

/** GET /v1/reports/today. Everything the CEO looks at first thing. */
export interface TodayReport {
  /** The Baghdad day. */
  day: string;
  rate: Rate | null;
  /** The last rate set before today, to copy from. */
  lastRate: Rate | null;
  alerts: AlertCount;
  /** Rounds that are not finished, and rounds whose cash was counted in today. */
  rounds: RoundSummary[];
  /** What those rounds went out to collect, in dollars: what is still owed on their stops plus what they took. */
  expectedUsdCents: number;
  /** What they collected, in dollars, whichever way it was paid. */
  collectedUsdCents: number;
  /** Cash, per currency: collected against counted in. */
  cash: TodayCash[];
  /** Paid at the office today, in dollars: cash and wallets. */
  officePaymentsUsdCents: number;
  /** Files that are not closed yet. */
  files: TodayFile[];
  heldInCar: number;
}

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

export const WALLET_CODES = [
  "wallet_fib_usd",
  "wallet_fib_iqd",
  "wallet_fastpay_usd",
  "wallet_fastpay_iqd",
  "wallet_zaincash_usd",
  "wallet_zaincash_iqd",
] as const;
export type WalletCode = (typeof WALLET_CODES)[number];

export interface Wallet {
  code: WalletCode;
  name: string;
  method: "fib" | "fastpay" | "zaincash";
  currency: Currency;
  /** What the ledger says came in. */
  ledgerBalance: number;
  /** What the wallet's app should show now: the last reading plus everything entered since. */
  expectedInApp: number;
  lastCheckedAt: string | null;
  lastDifference: number | null;
  /** When the oldest money came in that nobody has checked yet. Null when everything is checked. */
  uncheckedSince: string | null;
  /** True when that money has waited longer than the set number of days. */
  checkDue: boolean;
}

export interface WalletCheck {
  id: string;
  code: WalletCode;
  name: string;
  currency: Currency;
  appBalance: number;
  expected: number;
  /** What the app showed minus what the books said. Negative is less in the app. */
  difference: number;
  note: string | null;
  checkedAt: string;
  checkedByName: string;
}

export interface Wallets {
  wallets: Wallet[];
  /** The latest checks, newest first. */
  checks: WalletCheck[];
}

/**
 * POST /v1/wallets/checks. The CEO reads a wallet's balance in its app and
 * types it in. A difference from the books needs a note.
 */
export const WalletCheckRequest = z.strictObject({
  /** Made up by the office app for this check. The same id twice is one check. */
  id: Uuid,
  wallet: z.enum(WALLET_CODES),
  appBalance: z.number().int("A balance is a whole number: cents or dinars").min(0, "A balance cannot be negative").max(1e13),
  /** When the app was read. Now, if left out. */
  checkedAt: Instant.optional(),
  note: Note.optional(),
});
export type WalletCheckRequest = z.infer<typeof WalletCheckRequest>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  /** Goods held in the car longer than this many days raise an alert. */
  heldInCarDays: number;
  /** Baghdad time, "18:00". The vault reminder starts here. */
  vaultCloseTime: string;
  /** How many days wallet money may wait before it is checked against the app. */
  walletCheckDays: number;
  /** Dinars that come to what is owed, give or take half this step, settle it. 1000 is the nearest 1,000. 0 is off. */
  dinarRoundingIqd: number;
  updatedAt: string;
}

/** PUT /v1/settings. Send only what changes. */
export const SettingsRequest = z
  .strictObject({
    heldInCarDays: z.number().int().min(1, "At least 1 day").max(60, "At most 60 days").optional(),
    vaultCloseTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "A time looks like 18:00").optional(),
    walletCheckDays: z.number().int().min(1, "At least 1 day").max(60, "At most 60 days").optional(),
    dinarRoundingIqd: z.number().int("A whole number of dinars").min(0, "0 switches rounding off").max(10_000, "At most 10,000 dinars").optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), "Nothing to change");
export type SettingsRequest = z.infer<typeof SettingsRequest>;
