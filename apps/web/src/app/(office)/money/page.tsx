"use client";

import type { Account, CashOut, CashOutCategory, Consignment, Currency, CustomerDetail, CustomerSummary, ErrorEntry, OfficeMethod, Page, Payment, PaymentParts, Rate, Settings } from "@green-star/contracts";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { CustomerPicker } from "@/components/customer-picker";
import { useToast } from "@/components/toast";
import { Button, Card, CardHead, Dialog, Empty, Field, FormActions, Input, Loading, Money, PageHead, Problem, Segmented, Select, Stat, Table, Td, Textarea, Th } from "@/components/ui";
import { WalletsCard } from "@/components/wallets";
import { api } from "@/lib/api";
import { useGet, useRateToday, useSave } from "@/lib/hooks";
import { CASH_OUT, dayTime, METHOD } from "@/lib/labels";
import { amountForInput, formatMoney, formatRate, formatRatePerDollar, parseAmount, parseRate, planParts, roundDinars, usdCentsToIqd } from "@/lib/money";

// ---------------------------------------------------------------------------
// Today's rate
// ---------------------------------------------------------------------------

function RateCard() {
  const today = useRateToday();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [editing, setEditing] = useState(false);
  const set = useSave(
    (body: unknown, key: string) => api.put<Rate>("/v1/fx-rates/today", body, key),
    () => {
      setEditing(false);
      setTyped("");
      toast("Today's rate is set");
    },
  );
  const rate = parseRate(typed);
  // The database refuses a rate far from the last one until it is sent again: 1,450 typed instead of 145,000.
  const jump = set.problem?.code === "rate_jump";

  if (today.data === undefined) return <Loading />;
  const current = today.data.rate;
  const showForm = current === null || editing;

  return (
    <Card>
      <CardHead title="Today's dinar rate" hint="One rate per day, the city's market rate. Every dinar taken today converts at it." />
      <div className="flex flex-col gap-4 p-5">
        {current !== null ? (
          <div className="flex items-start justify-between gap-4">
            <p>
              <span className="num text-[26px] font-semibold leading-none">{formatRate(current.iqdPer100Usd)}</span>
              <span className="ml-2 text-sm text-muted">dinars per $100</span>
              <span className="mt-1 block text-[13px] text-muted">
                <span className="num">{formatRatePerDollar(current.iqdPer100Usd)}</span> per $1 · set by {current.setBy}, {dayTime(current.setAt)}
              </span>
            </p>
            {!editing ? (
              <Button small onClick={() => setEditing(true)}>
                Change
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="rounded-md bg-amber-soft px-3 py-2 text-sm text-amber-ink">
            Not set yet. No dinars can be taken today until it is.
            {today.data.last ? <> Yesterday&apos;s was <b className="num">{formatRate(today.data.last.iqdPer100Usd)}</b>.</> : null}
          </p>
        )}
        {showForm ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void set.save({ iqdPer100Usd: rate, confirm: jump });
            }}
          >
            <Field label="Dinars per $100" hint={rate === null ? "As the market quotes it: 145,000" : <>That is <b className="num">{formatRatePerDollar(rate)}</b> dinars per dollar.</>} problem={typed.trim() !== "" && rate === null ? "A whole number, like 145,000" : undefined}>
              {(id) => (
                <Input
                  id={id}
                  className="num w-48"
                  inputMode="numeric"
                  placeholder="145,000"
                  value={typed}
                  onChange={(e) => {
                    setTyped(e.target.value);
                    set.clear();
                  }}
                />
              )}
            </Field>
            {jump ? (
              <p className="rounded-md border border-amber bg-amber-soft px-3 py-2 text-sm text-amber-ink" role="alert">
                <b>{rate === null ? typed : formatRate(rate)}</b> is far from the last rate{today.data.last || current ? <> (<span className="num">{formatRate((current ?? today.data.last)?.iqdPer100Usd ?? 0)}</span>)</> : null}. If it is right, press the button again.
              </p>
            ) : (
              <Problem of={set.problem} />
            )}
            <div className="flex gap-2">
              <Button type="submit" tone="primary" busy={set.saving} disabled={rate === null}>
                {jump ? "Yes, that is the rate" : "Set the rate"}
              </Button>
              {editing ? (
                <Button tone="quiet" onClick={() => { setEditing(false); set.clear(); }}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The three things that move money at the office
// ---------------------------------------------------------------------------

function AmountBox({ id, amount, currency, onAmount, onCurrency, problem, fixedCurrency = false }: { id: string; amount: string; currency: Currency; onAmount: (v: string) => void; onCurrency: (c: Currency) => void; problem?: string | undefined; fixedCurrency?: boolean }) {
  return (
    <div className="flex gap-2">
      <Input id={id} className="num text-right" inputMode="decimal" placeholder={currency === "USD" ? "0.00" : "0"} value={amount} onChange={(e) => onAmount(e.target.value)} problem={problem} />
      <Select aria-label="Currency" className="w-28" value={currency} disabled={fixedCurrency} onChange={(e) => onCurrency(e.target.value as Currency)}>
        <option value="USD">Dollars</option>
        <option value="IQD">Dinars</option>
      </Select>
    </div>
  );
}

/** One way he paid: an amount, its currency, and how. */
interface PartRow {
  key: number;
  amount: string;
  currency: Currency;
  method: OfficeMethod;
}

const MAX_PARTS = 4;
let partKey = 0;
const newPart = (currency: Currency = "USD"): PartRow => ({ key: ++partKey, amount: "", currency, method: "office_cash" });

/**
 * What a customer hands over in one visit: dollars, dinars, a wallet, or any
 * mix of them. Dollars are applied first, so the dinars settle what is left.
 */
function PaymentForm({ initial }: { initial: CustomerSummary | null }) {
  const toast = useToast();
  const rate = useRateToday();
  const settings = useGet<Settings>("/v1/settings");
  const [customer, setCustomer] = useState<CustomerSummary | null>(initial);
  const [rows, setRows] = useState<PartRow[]>(() => [newPart()]);
  const [note, setNote] = useState("");

  useEffect(() => setCustomer(initial), [initial]);

  const done = (credited: number, name: string) => {
    toast(`${formatMoney(credited, "USD")} taken from ${name}`);
    setRows([newPart()]);
    setNote("");
    setCustomer(null);
  };
  const payOne = useSave(
    (body: unknown, key: string) => api.post<Payment>("/v1/payments", body, key),
    (payment) => done(payment.creditedUsdCents, payment.customerName),
  );
  const payParts = useSave(
    (body: unknown, key: string) => api.post<PaymentParts>("/v1/payments/parts", body, key),
    (made) => done(made.payments.reduce((sum, p) => sum + p.creditedUsdCents, 0), made.payments[0]?.customerName ?? ""),
  );
  const pay = rows.length === 1 ? payOne : payParts;

  const edit = (key: number, change: Partial<PartRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
    payOne.clear();
    payParts.clear();
  };

  const todayRate = rate.data?.rate?.iqdPer100Usd ?? null;
  const step = settings.data?.dinarRoundingIqd ?? 1000;
  const owed = customer?.balanceUsdCents ?? 0;
  const typed = rows.map((row) => (row.amount.trim() === "" ? null : parseAmount(row.amount, row.currency)));
  const bad = rows.map((row, i) => row.amount.trim() !== "" && typed[i] === null);
  const needsRate = todayRate === null && rows.some((row) => row.currency === "IQD");
  const twice = rows.some((row, i) => rows.findIndex((other) => other.currency === row.currency && other.method === row.method) !== i);
  const complete = typed.every((amount) => amount !== null && amount > 0);
  const filled = rows.flatMap((row, i) => (typed[i] ? [{ at: i, amount: typed[i] as number, currency: row.currency }] : []));
  // What each part will be worth, worked out the way the API will.
  const plan = filled.length === 0 ? null : planParts(filled, { iqdPer100Usd: todayRate, owedUsdCents: owed, stepIqd: step });
  const creditOf = (i: number) => {
    const at = filled.findIndex((part) => part.at === i);
    return plan === null || at === -1 ? null : { credited: plan.credited[at] as number, exact: plan.exact[at] as number };
  };
  // What is left for the dinars once the dollars typed so far are counted.
  const dollars = filled.filter((part) => part.currency === "USD").reduce((sum, part) => sum + part.amount, 0);
  const rest = owed - dollars;
  const restInDinars = rest > 0 && todayRate !== null ? usdCentsToIqd(rest, todayRate) : null;

  return (
    <form
      className="flex flex-col gap-4 p-5"
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const parts = rows.map((row, i) => ({ received: { amount: typed[i], currency: row.currency }, method: row.method }));
        const extra = note.trim() === "" ? {} : { note };
        if (parts.length === 1) void payOne.save({ customerId: customer?.id, ...parts[0], ...extra });
        else void payParts.save({ customerId: customer?.id, parts, ...extra });
      }}
    >
      <Field label="Customer" hint={customer ? (customer.balanceUsdCents > 0 ? <>He owes <b className="num">{formatMoney(customer.balanceUsdCents, "USD")}</b>. It pays his oldest unpaid file first.</> : "He owes nothing. The money will stay on his account as credit.") : undefined} problem={pay.fieldProblem("customerId")}>
        {(id) => <CustomerPicker id={id} value={customer} onChange={setCustomer} />}
      </Field>

      <div className="flex flex-col gap-3">
        {rows.map((row, i) => {
          const worth = creditOf(i);
          const suggest = row.currency === "IQD" && row.amount.trim() === "" && restInDinars !== null ? roundDinars(restInDinars, step) : null;
          const hint =
            row.currency === "IQD" && worth !== null && todayRate !== null ? (
              worth.credited === worth.exact ? (
                <>→ <b className="num">{formatMoney(worth.credited, "USD")}</b> on his account at {formatRatePerDollar(todayRate)}</>
              ) : (
                <>→ counts as <b className="num">{formatMoney(worth.credited, "USD")}</b>: it settles what he owes. Exactly, it is <span className="num">{formatMoney(worth.exact, "USD")}</span> at {formatRatePerDollar(todayRate)}.</>
              )
            ) : suggest !== null && restInDinars !== null ? (
              <>
                {rest === owed ? "What he owes" : "What is left"} is <span className="num">{formatMoney(restInDinars, "IQD")}</span>.{" "}
                <button type="button" className="font-semibold text-green hover:underline" onClick={() => edit(row.key, { amount: amountForInput(suggest, "IQD") })}>
                  Use <span className="num">{formatMoney(suggest, "IQD")}</span>
                </button>
              </>
            ) : null;
          return (
            <div key={row.key} className="flex flex-col gap-1.5" data-part={i + 1}>
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label={i === 0 ? "Amount received" : "And"}
                  problem={bad[i] ? (row.currency === "IQD" ? "Dinars are whole numbers" : "That is not an amount") : row.currency === "IQD" && todayRate === null ? "Set today's rate first" : pay.fieldProblem(rows.length === 1 ? "received.amount" : `parts.${i}.received.amount`)}
                >
                  {(id) => <AmountBox id={id} amount={row.amount} currency={row.currency} onAmount={(amount) => edit(row.key, { amount })} onCurrency={(currency) => edit(row.key, { currency })} problem={bad[i] ? "bad" : undefined} />}
                </Field>
                <Field label={i === 0 ? "How it was paid" : "Paid by"}>
                  {(id) => (
                    <Select id={id} value={row.method} onChange={(e) => edit(row.key, { method: e.target.value as OfficeMethod })}>
                      {(["office_cash", "fib", "fastpay", "zaincash"] as const).map((m) => (
                        <option key={m} value={m}>
                          {METHOD[m]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
              {hint !== null || rows.length > 1 ? (
                <div className="flex items-start justify-between gap-4 text-[13px] text-muted">
                  <p>{hint}</p>
                  {rows.length > 1 ? (
                    <button type="button" className="shrink-0 hover:text-red hover:underline" aria-label={`Remove row ${i + 1}`} onClick={() => setRows((current) => current.filter((other) => other.key !== row.key))}>
                      Remove
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {rows.length < MAX_PARTS ? (
            <button
              type="button"
              className="text-[13px] font-semibold text-green hover:underline"
              onClick={() => setRows((current) => [...current, newPart(current.some((row) => row.currency === "IQD") ? "USD" : "IQD")])}
            >
              + He also paid another way
            </button>
          ) : (
            <span />
          )}
          {rows.length > 1 && plan !== null && complete ? (
            <p className="text-sm" data-testid="payment-total">
              Together <b className="num">{formatMoney(plan.total, "USD")}</b>.{" "}
              {customer === null ? null : plan.left > 0 ? (
                <>He will still owe <b className="num">{formatMoney(plan.left, "USD")}</b>.</>
              ) : plan.left < 0 ? (
                <><b className="num">{formatMoney(-plan.left, "USD")}</b> stays on his account as credit.</>
              ) : (
                "He will owe nothing."
              )}
            </p>
          ) : null}
        </div>
        {twice ? <p className="text-[13px] text-red">Two of these are in the same currency and paid the same way. Add them up into one.</p> : null}
      </div>

      <Field label="Note" hint="Optional: a receipt number, who brought it">
        {(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      <Problem of={pay.problem} />
      <div>
        <Button type="submit" tone="primary" busy={pay.saving} disabled={customer === null || !complete || needsRate || twice}>
          Take the payment
        </Button>
      </div>
    </form>
  );
}

/** The CEO's "Error" entry: an amount off what a customer owes, or onto it, with no money moving. No limit. */
function ErrorForm({ initial, initialCents, initialConsignment }: { initial: CustomerSummary | null; initialCents: number | null; initialConsignment: string | null }) {
  const toast = useToast();
  const [customer, setCustomer] = useState<CustomerSummary | null>(initial);
  const [direction, setDirection] = useState<"off" | "add">("off");
  // Opened from a stop that came up short: the amount and the goods are already filled in.
  const [amount, setAmount] = useState(initialCents === null ? "" : amountForInput(initialCents, "USD"));
  const [consignmentId, setConsignmentId] = useState<string>(initialConsignment ?? "");
  const [note, setNote] = useState("");
  const consignments = useGet<{ items: Consignment[] }>(customer === null ? null : `/v1/consignments?customerId=${customer.id}`);

  useEffect(() => setCustomer(initial), [initial]);
  useEffect(() => {
    // Adding goes onto one of his consignments: his newest, unless one was picked.
    const items = consignments.data?.items ?? [];
    if (items.length > 0 && !items.some((c) => c.id === consignmentId)) setConsignmentId(items[items.length - 1]?.id ?? "");
  }, [consignments.data, consignmentId]);

  const enter = useSave(
    (body: unknown, key: string) => api.post<ErrorEntry>("/v1/errors", body, key),
    (made) => {
      toast(made.added ? `${formatMoney(made.amountUsdCents, "USD")} added to ${made.customerName}'s account` : `${formatMoney(made.amountUsdCents, "USD")} taken off ${made.customerName}'s account`);
      setAmount("");
      setNote("");
      setCustomer(null);
    },
  );

  const adding = direction === "add";
  const typed = amount.trim() === "" ? null : parseAmount(amount, "USD");
  const owes = customer?.balanceUsdCents ?? null;
  const items = consignments.data?.items ?? [];
  // What the screen can see is wrong before it is sent. The database holds the same rules.
  const local =
    amount.trim() !== "" && typed === null
      ? "That is not an amount"
      : !adding && typed !== null && owes !== null && typed > Math.max(owes, 0)
        ? owes > 0
          ? `He owes ${formatMoney(owes, "USD")}`
          : "He owes nothing"
        : undefined;
  const problem = local ?? enter.fieldProblem("amountUsdCents");
  const noGoods = adding && customer !== null && consignments.data !== undefined && items.length === 0;

  return (
    <form
      className="flex flex-col gap-4 p-5"
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void enter.save({
          customerId: customer?.id,
          amountUsdCents: typed,
          ...(adding ? { add: true, consignmentId } : consignmentId !== "" && initialConsignment === consignmentId ? { consignmentId } : {}),
          ...(note.trim() === "" ? {} : { note }),
        });
      }}
    >
      <p className="rounded-md bg-sunken px-3 py-2 text-[13px] text-muted">
        For a difference that is not worth chasing, or an amount that was left off. No money moves, and there is no limit. It shows on his statement as its own line.
      </p>
      <Segmented
        label="Which way"
        value={direction}
        onChange={(v) => {
          setDirection(v);
          enter.clear();
        }}
        options={[
          { value: "off", label: "Take off what he owes" },
          { value: "add", label: "Add to what he owes" },
        ]}
      />
      <Field label="Customer" hint={customer ? (customer.balanceUsdCents > 0 ? <>He owes <b className="num">{formatMoney(customer.balanceUsdCents, "USD")}</b>.</> : adding ? "He owes nothing now." : "He owes nothing, so there is nothing to take off.") : undefined} problem={enter.fieldProblem("customerId")}>
        {(id) => <CustomerPicker id={id} value={customer} onChange={setCustomer} />}
      </Field>
      {adding && customer !== null ? (
        <Field label="Add it to" hint="Everything a customer owes belongs to a file. Payments pay it like the rest." problem={noGoods ? "He has no goods on a confirmed file to add it to" : enter.fieldProblem("consignmentId")}>
          {(id) => (
            <Select id={id} value={consignmentId} onChange={(e) => setConsignmentId(e.target.value)} disabled={items.length === 0}>
              {items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.shipmentCode} · {formatMoney(c.amountDueUsdCents, "USD")}
                  {c.remainingUsdCents > 0 ? ` · ${formatMoney(c.remainingUsdCents, "USD")} left` : " · paid"}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      <div className="grid grid-cols-2 gap-4">
        <Field label={adding ? "Amount to add, in dollars" : "Amount to take off, in dollars"} problem={problem}>
          {(id) => <Input id={id} className="num text-right" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => { setAmount(e.target.value); enter.clear(); }} problem={problem} />}
        </Field>
        <Field label="Note" hint="Optional: what the difference was">
          {(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
      <Problem of={enter.problem} />
      <div>
        <Button type="submit" tone="primary" busy={enter.saving} disabled={customer === null || typed === null || typed === 0 || local !== undefined || noGoods || (adding && consignmentId === "")}>
          {adding ? "Add the error" : "Enter the error"}
        </Button>
      </div>
    </form>
  );
}

function CashOutForm() {
  const toast = useToast();
  const [category, setCategory] = useState<CashOutCategory>("fuel_car");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("USD");
  const [reason, setReason] = useState("");
  const out = useSave(
    (body: unknown, key: string) => api.post<CashOut>("/v1/cash-outs", body, key),
    (made) => {
      toast(`${formatMoney(made.amount, made.currency)} out of the vault`);
      setAmount("");
      setReason("");
    },
  );
  const china = category === "china";
  const used = china ? "USD" : currency;
  const typed = amount.trim() === "" ? null : parseAmount(amount, used);
  const bad = amount.trim() !== "" && typed === null;

  return (
    <form
      className="flex flex-col gap-4 p-5"
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void out.save({ category, amount: { amount: typed, currency: used }, reason });
      }}
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="What for">
          {(id) => (
            <Select id={id} value={category} onChange={(e) => setCategory(e.target.value as CashOutCategory)}>
              {(Object.keys(CASH_OUT) as CashOutCategory[]).map((c) => (
                <option key={c} value={c}>
                  {CASH_OUT[c]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Amount" hint={china ? "Money to China leaves the dollar vault." : undefined} problem={bad ? "That is not an amount" : out.fieldProblem("amount.amount")}>
          {(id) => <AmountBox id={id} amount={amount} currency={used} onAmount={setAmount} onCurrency={setCurrency} problem={bad ? "bad" : undefined} fixedCurrency={china} />}
        </Field>
      </div>
      <Field label="Reason" problem={out.fieldProblem("reason")}>
        {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={china ? "Sent with Kak Azad's transfer" : "Fuel for the Kirkuk round"} />}
      </Field>
      <Problem of={out.problem} />
      <div>
        <Button type="submit" tone="primary" busy={out.saving} disabled={typed === null || typed === 0 || reason.trim() === ""}>
          Pay it out
        </Button>
      </div>
    </form>
  );
}

function ExchangeForm() {
  const toast = useToast();
  const [from, setFrom] = useState<Currency>("IQD");
  const [given, setGiven] = useState("");
  const [received, setReceived] = useState("");
  const to: Currency = from === "IQD" ? "USD" : "IQD";
  const exchange = useSave(
    (body: unknown, key: string) => api.post("/v1/exchanges", body, key),
    () => {
      toast("Exchange saved");
      setGiven("");
      setReceived("");
    },
  );
  const g = given.trim() === "" ? null : parseAmount(given, from);
  const r = received.trim() === "" ? null : parseAmount(received, to);
  const dinars = from === "IQD" ? g : r;
  const cents = from === "IQD" ? r : g;
  const implied = dinars !== null && cents !== null && cents > 0 ? Math.round((dinars * 10000) / cents) : null;

  return (
    <form
      className="flex flex-col gap-4 p-5"
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void exchange.save({ given: { amount: g, currency: from }, received: { amount: r, currency: to } });
      }}
    >
      <Field label="Changing">
        {(id) => (
          <Select id={id} value={from} onChange={(e) => setFrom(e.target.value as Currency)}>
            <option value="IQD">Dinars into dollars</option>
            <option value="USD">Dollars into dinars</option>
          </Select>
        )}
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label={`${from === "IQD" ? "Dinars" : "Dollars"} given`} problem={given.trim() !== "" && g === null ? "That is not an amount" : exchange.fieldProblem("given.amount")}>
          {(id) => <Input id={id} className="num text-right" inputMode="decimal" value={given} onChange={(e) => setGiven(e.target.value)} />}
        </Field>
        <Field label={`${to === "IQD" ? "Dinars" : "Dollars"} received`} problem={received.trim() !== "" && r === null ? "That is not an amount" : exchange.fieldProblem("received.amount")}>
          {(id) => <Input id={id} className="num text-right" inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} />}
        </Field>
      </div>
      <p className="text-[13px] text-muted">
        Both amounts are what really changed hands.{implied !== null ? <> That is <b className="num text-ink">{formatRatePerDollar(implied)}</b> dinars per dollar.</> : null}
      </p>
      <Problem of={exchange.problem} />
      <div>
        <Button type="submit" tone="primary" busy={exchange.saving} disabled={!g || !r}>
          Save the exchange
        </Button>
      </div>
    </form>
  );
}

function Reverse({ entryId, what, onClose }: { entryId: string; what: string; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const reverse = useSave((body: unknown, key: string) => api.post(`/v1/entries/${entryId}/reverse`, body, key), onClose);
  return (
    <Dialog open onClose={onClose} title={`Reverse ${what}`} hint="Nothing in the books is edited or deleted. This posts the exact opposite, with your reason, and both stay on record.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void reverse.save({ reason });
        }}
      >
        <Field label="Why">{(id) => <Textarea id={id} rows={2} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Entered for the wrong customer" />}</Field>
        <Problem of={reverse.problem} />
        <FormActions onCancel={onClose} saving={reverse.saving} save="Reverse it" danger disabled={reason.trim() === ""} />
      </form>
    </Dialog>
  );
}

/** What rounding dinars has given or taken, and what was let go as errors: the two accounts nobody was paid or charged for. */
function SmallDifferences() {
  const accounts = useGet<{ items: Account[] }>("/v1/accounts");
  if (accounts.data === undefined) return null;
  const on = (code: string) => accounts.data.items.find((account) => account.code === code)?.balance ?? 0;
  // The rounding account goes down when a customer's dinars were worth more than he was credited.
  const rounding = -on("dinar_rounding_usd");
  const errors = on("errors_usd");
  return (
    <Card>
      <CardHead title="Small differences" hint="Money nobody was paid or charged: the cents rounding dinars gave or took, and what was let go as errors." />
      <div className="grid grid-cols-2 gap-6 p-5">
        <Stat label="Dinar rounding" hint={rounding === 0 ? "Even so far" : rounding > 0 ? "Rounding gave this, in all" : "Rounding took this, in all"} tone={rounding < 0 ? "amber" : undefined}>
          {formatMoney(Math.abs(rounding), "USD")}
        </Stat>
        <Stat label="Errors" hint="Taken off customers' accounts, in all" tone={errors > 0 ? "amber" : undefined}>
          {formatMoney(errors, "USD")}
        </Stat>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

type Tab = "payment" | "cash_out" | "exchange" | "error";
const TABS: { value: Tab; label: string }[] = [
  { value: "payment", label: "A customer pays" },
  { value: "cash_out", label: "Cash out" },
  { value: "exchange", label: "Exchange" },
  { value: "error", label: "Error" },
];

function MoneyScreen() {
  const search = useSearchParams();
  const customerId = search.get("customer");
  // /money?customer=…&error=44 opens the Error tab with 44 cents filled in.
  const errorCents = /^[1-9]\d{0,9}$/.test(search.get("error") ?? "") ? Number(search.get("error")) : null;
  const errorConsignment = /^[0-9a-f-]{36}$/.test(search.get("consignment") ?? "") ? search.get("consignment") : null;
  const preset = useGet<CustomerDetail>(customerId === null ? null : `/v1/customers/${customerId}`);
  const [tab, setTab] = useState<Tab>(errorCents === null ? "payment" : "error");
  const [reversing, setReversing] = useState<{ entryId: string; what: string } | null>(null);
  const payments = useGet<Page<Payment>>("/v1/payments?limit=12");
  const cashOuts = useGet<Page<CashOut>>("/v1/cash-outs?limit=8");
  const errors = useGet<Page<ErrorEntry>>("/v1/errors?limit=8");

  return (
    <>
      <PageHead title="Money" hint="What comes in at the office and what goes out of the vault. Money collected on a round is entered on the round." />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="flex flex-col gap-5">
          <RateCard />
          <Card>
            <div className="border-b border-rule px-5 py-3.5">
              <Segmented label="What is being entered" value={tab} onChange={setTab} options={TABS} />
            </div>
            {tab === "payment" ? <PaymentForm initial={preset.data ?? null} /> : tab === "cash_out" ? <CashOutForm /> : tab === "exchange" ? <ExchangeForm /> : <ErrorForm initial={preset.data ?? null} initialCents={errorCents} initialConsignment={errorConsignment} />}
          </Card>
          <WalletsCard />
        </div>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHead title="Latest payments" hint="At the office, by wallet, and on rounds." />
            {payments.data === undefined ? (
              <Loading />
            ) : payments.data.items.length === 0 ? (
              <Empty title="No payments yet" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Customer</Th>
                    <Th>How</Th>
                    <Th right>Received</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {payments.data.items.map((p) => (
                    <tr key={p.entryId} className={p.reversed ? "text-faint" : undefined}>
                      <Td className="whitespace-nowrap text-[13px] text-muted">{dayTime(p.happenedAt)}</Td>
                      <Td>
                        <Link href={`/customers/${p.customerId}`} className="font-semibold hover:text-green" dir="auto">
                          {p.customerName}
                        </Link>
                        {p.note ? <span className="block text-[12px] text-muted">{p.note}</span> : null}
                      </Td>
                      <Td className="text-[13px]">{METHOD[p.method]}</Td>
                      <Td right>
                        <Money amount={p.receivedAmount} currency={p.receivedCurrency} className={p.reversed ? "line-through" : undefined} />
                        {p.receivedCurrency === "IQD" ? <span className="num block text-[12px] text-muted">{formatMoney(p.creditedUsdCents, "USD")}</span> : null}
                      </Td>
                      <Td right className="whitespace-nowrap">
                        {p.reversed ? (
                          <span className="text-[12px]">reversed</span>
                        ) : p.roundId !== null ? (
                          <Link href={`/rounds/${p.roundId}`} className="text-[13px] text-muted hover:text-green hover:underline">
                            On a round
                          </Link>
                        ) : (
                          <button type="button" className="text-[13px] text-muted hover:text-red hover:underline" onClick={() => setReversing({ entryId: p.entryId, what: `${p.customerName}'s payment` })}>
                            Reverse
                          </button>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHead title="Latest cash out" />
            {cashOuts.data === undefined ? (
              <Loading />
            ) : cashOuts.data.items.length === 0 ? (
              <Empty title="Nothing paid out yet" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>What for</Th>
                    <Th right>Amount</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {cashOuts.data.items.map((c) => (
                    <tr key={c.entryId} className={c.reversed ? "text-faint" : undefined}>
                      <Td className="whitespace-nowrap text-[13px] text-muted">{dayTime(c.happenedAt)}</Td>
                      <Td>
                        <span className="font-semibold">{CASH_OUT[c.category]}</span>
                        <span className="block text-[12px] text-muted">{c.reason}</span>
                      </Td>
                      <Td right>
                        <Money amount={c.amount} currency={c.currency} className={c.reversed ? "line-through" : undefined} />
                      </Td>
                      <Td right>
                        {c.reversed ? (
                          <span className="text-[12px]">reversed</span>
                        ) : (
                          <button type="button" className="text-[13px] text-muted hover:text-red hover:underline" onClick={() => setReversing({ entryId: c.entryId, what: `this cash out` })}>
                            Reverse
                          </button>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {errors.data !== undefined && errors.data.items.length > 0 ? (
            <Card>
              <CardHead title="Latest errors" hint="Amounts taken off a customer's account, or added to it, with no money moving." />
              <Table>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Customer</Th>
                    <Th right>Amount</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {errors.data.items.map((x) => (
                    <tr key={x.entryId} className={x.reversed ? "text-faint" : undefined}>
                      <Td className="whitespace-nowrap text-[13px] text-muted">{dayTime(x.happenedAt)}</Td>
                      <Td>
                        <Link href={`/customers/${x.customerId}`} className="font-semibold hover:text-green" dir="auto">
                          {x.customerName}
                        </Link>
                        {x.note ? <span className="block text-[12px] text-muted">{x.note}</span> : null}
                      </Td>
                      <Td right>
                        <span className="mr-2 text-[12px] text-muted">{x.added ? "added" : "taken off"}</span>
                        <Money amount={x.amountUsdCents} className={x.reversed ? "line-through" : undefined} />
                      </Td>
                      <Td right>
                        {x.reversed ? (
                          <span className="text-[12px]">reversed</span>
                        ) : (
                          <button type="button" className="text-[13px] text-muted hover:text-red hover:underline" onClick={() => setReversing({ entryId: x.entryId, what: `${x.customerName}'s error entry` })}>
                            Reverse
                          </button>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : null}

          <SmallDifferences />
        </div>
      </div>
      {reversing ? <Reverse entryId={reversing.entryId} what={reversing.what} onClose={() => setReversing(null)} /> : null}
    </>
  );
}

export default function MoneyPage() {
  return (
    <Suspense>
      <MoneyScreen />
    </Suspense>
  );
}
