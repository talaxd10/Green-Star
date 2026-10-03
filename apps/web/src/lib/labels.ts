// The words on the screen for what the system stores, and the colour each one gets.

import type {
  AlertKind,
  AlertSeverity,
  CashOutCategory,
  ConsignmentStatus,
  DisputeKind,
  DisputeStatus,
  EntryKind,
  PaymentMethod,
  Role,
  RoundOutcome,
  RoundStatus,
  ShipmentStatus,
  Trust,
} from "@green-star/contracts";
import type { ChipTone } from "@/components/ui";

type Labelled<T extends string> = Record<T, { label: string; tone: ChipTone }>;

export const CONSIGNMENT: Labelled<ConsignmentStatus> = {
  listed: { label: "Listed", tone: "grey" },
  on_round: { label: "On a round", tone: "blue" },
  delivered_paid: { label: "Delivered, paid", tone: "green" },
  delivered_prepaid: { label: "Prepaid, delivered", tone: "green" },
  delivered_on_account: { label: "Delivered, on account", tone: "blue" },
  held: { label: "Held in the car", tone: "amber" },
  delivered_not_paid: { label: "Delivered, not paid", tone: "red" },
  closed: { label: "Closed", tone: "green" },
  cancelled: { label: "Cancelled", tone: "grey" },
};

export const SHIPMENT: Labelled<ShipmentStatus> = {
  draft: { label: "Draft", tone: "grey" },
  confirmed: { label: "Confirmed", tone: "blue" },
  on_rounds: { label: "On rounds", tone: "amber" },
  reconciling: { label: "Reconciling", tone: "amber" },
  closed: { label: "Closed", tone: "green" },
};

export const ROUND: Labelled<RoundStatus> = {
  planned: { label: "Planned", tone: "grey" },
  out: { label: "Out", tone: "blue" },
  returned: { label: "Back, cash not counted", tone: "amber" },
  handed_in: { label: "Handed in", tone: "green" },
};

export const OUTCOME: Labelled<RoundOutcome> = {
  paid: { label: "Paid", tone: "green" },
  on_account: { label: "On account", tone: "blue" },
  prepaid: { label: "Prepaid", tone: "green" },
  held: { label: "Held in the car", tone: "amber" },
  unpaid: { label: "Delivered, not paid", tone: "red" },
};

export const DISPUTE: Labelled<DisputeStatus> = {
  open: { label: "Not sent yet", tone: "amber" },
  sent_to_china: { label: "Waiting on China", tone: "amber" },
  answered: { label: "China answered", tone: "blue" },
  closed: { label: "Closed", tone: "green" },
};

export const DISPUTE_KIND: Record<DisputeKind, string> = { missing: "Missing", damaged: "Damaged", weight: "Weight" };

export const TRUST: Labelled<Trust> = {
  trusted: { label: "Trusted", tone: "blue" },
  pay_first: { label: "Pay first", tone: "grey" },
};

export const METHOD: Record<PaymentMethod, string> = {
  driver_cash: "Cash to the driver",
  office_cash: "Cash at the office",
  fib: "FIB",
  fastpay: "FastPay",
  zaincash: "ZainCash",
};

export const CASH_OUT: Record<CashOutCategory, string> = {
  china: "Sent to China",
  driver_pay: "Driver pay",
  fuel_car: "Fuel and car",
  customs_airport: "Customs and airport",
  rent_salaries: "Rent and salaries",
  other: "Other",
};

export const ENTRY: Record<EntryKind, string> = {
  file_confirmed: "File confirmed",
  driver_collected: "Driver collected",
  round_handed_in: "Round handed in",
  office_payment: "Paid at the office",
  wallet_payment: "Paid by wallet",
  sent_to_china: "Sent to China",
  cash_out: "Cash out",
  currency_exchange: "Currency exchange",
  reversal: "Reversal",
};

export const ROLE: Record<Role, string> = { ceo: "CEO", owner: "Owner", monitor: "Office monitor" };

/** What an alert is about, in two or three words. */
export const ALERT: Record<AlertKind, string> = {
  missed_collection: "Not collected",
  round_cash_gap: "Round cash",
  vault_gap: "Vault count",
  vault_not_closed: "Vault not counted",
  carton_mismatch: "Cartons",
  over_limit: "Over limit",
  held_too_long: "Held in the car",
  wallet_gap: "Wallet",
  wallet_check_due: "Wallet check",
  payment_at_old_rate: "Old rate",
  books_out_of_step: "The books",
};

export const SEVERITY: Labelled<AlertSeverity> = {
  high: { label: "High", tone: "red" },
  medium: { label: "Medium", tone: "amber" },
  low: { label: "Low", tone: "grey" },
};

const BAGHDAD = "Asia/Baghdad";
const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: BAGHDAD, day: "numeric", month: "short", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: BAGHDAD, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/** "3 Oct 2026", on the Baghdad calendar. Takes an instant or a plain day. */
export function day(value: string | null | undefined): string {
  if (!value) return "";
  return dayFormat.format(new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00+03:00` : value));
}

/** "3 Oct, 14:05", Baghdad time. */
export function dayTime(value: string | null | undefined): string {
  if (!value) return "";
  return timeFormat.format(new Date(value));
}

/** A phone number the way it is dialled in Iraq: +9647701234567 reads 0770 123 4567. */
export function phone(value: string | null | undefined): string {
  if (!value) return "";
  const local = /^\+964(\d{3})(\d{3})(\d{4})$/.exec(value);
  return local ? `0${local[1]} ${local[2]} ${local[3]}` : value;
}
