"use client";

import type { CashOut, CashOutCategory, Currency, CustomerDetail, CustomerSummary, OfficeMethod, Page, Payment, Rate } from "@green-star/contracts";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { CustomerPicker } from "@/components/customer-picker";
import { useToast } from "@/components/toast";
import { Button, Card, CardHead, Dialog, Empty, Field, FormActions, Input, Loading, Money, PageHead, Problem, Segmented, Select, Table, Td, Textarea, Th } from "@/components/ui";
import { WalletsCard } from "@/components/wallets";
import { api } from "@/lib/api";
import { useCan, useGet, useRateToday, useSave } from "@/lib/hooks";
import { CASH_OUT, dayTime, METHOD } from "@/lib/labels";
import { formatMoney, formatRate, formatRatePerDollar, iqdToUsdCents, parseAmount, parseRate } from "@/lib/money";

// ---------------------------------------------------------------------------
// Today's rate
// ---------------------------------------------------------------------------

function RateCard({ canSet }: { canSet: boolean }) {
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
  const showForm = canSet && (current === null || editing);

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
            {canSet && !editing ? (
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

function PaymentForm({ initial }: { initial: CustomerSummary | null }) {
  const toast = useToast();
  const rate = useRateToday();
  const [customer, setCustomer] = useState<CustomerSummary | null>(initial);
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("USD");
  const [method, setMethod] = useState<OfficeMethod>("office_cash");
  const [note, setNote] = useState("");

  useEffect(() => setCustomer(initial), [initial]);

  const pay = useSave(
    (body: unknown, key: string) => api.post<Payment>("/v1/payments", body, key),
    (payment) => {
      toast(`${formatMoney(payment.receivedAmount, payment.receivedCurrency)} taken from ${payment.customerName}`);
      setAmount("");
      setNote("");
      setCustomer(null);
    },
  );

  const typed = amount.trim() === "" ? null : parseAmount(amount, currency);
  const bad = amount.trim() !== "" && typed === null;
  const todayRate = rate.data?.rate?.iqdPer100Usd ?? null;
  const cents = typed === null ? null : currency === "USD" ? typed : todayRate === null ? null : iqdToUsdCents(typed, todayRate);
  const needsRate = currency === "IQD" && todayRate === null;

  return (
    <form
      className="flex flex-col gap-4 p-5"
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void pay.save({ customerId: customer?.id, received: { amount: typed, currency }, method, ...(note.trim() === "" ? {} : { note }) });
      }}
    >
      <Field label="Customer" hint={customer ? (customer.balanceUsdCents > 0 ? <>He owes <b className="num">{formatMoney(customer.balanceUsdCents, "USD")}</b>. It pays his oldest unpaid file first.</> : "He owes nothing. The money will stay on his account as credit.") : undefined} problem={pay.fieldProblem("customerId")}>
        {(id) => <CustomerPicker id={id} value={customer} onChange={setCustomer} />}
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Amount received"
          problem={bad ? (currency === "IQD" ? "Dinars are whole numbers" : "That is not an amount") : needsRate ? "Set today's rate first" : pay.fieldProblem("received.amount")}
          hint={currency === "IQD" && cents !== null && todayRate !== null ? <>→ <b className="num">{formatMoney(cents, "USD")}</b> on his account at {formatRatePerDollar(todayRate)}</> : undefined}
        >
          {(id) => <AmountBox id={id} amount={amount} currency={currency} onAmount={setAmount} onCurrency={setCurrency} problem={bad ? "bad" : undefined} />}
        </Field>
        <Field label="How it was paid">
          {(id) => (
            <Select id={id} value={method} onChange={(e) => setMethod(e.target.value as OfficeMethod)}>
              {(["office_cash", "fib", "fastpay", "zaincash"] as const).map((m) => (
                <option key={m} value={m}>
                  {METHOD[m]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field label="Note" hint="Optional: a receipt number, who brought it">
        {(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      <Problem of={pay.problem} />
      <div>
        <Button type="submit" tone="primary" busy={pay.saving} disabled={customer === null || typed === null || typed === 0 || needsRate}>
          Take the payment
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

// ---------------------------------------------------------------------------

type Tab = "payment" | "cash_out" | "exchange";
const TABS: { value: Tab; label: string }[] = [
  { value: "payment", label: "A customer pays" },
  { value: "cash_out", label: "Cash out" },
  { value: "exchange", label: "Exchange" },
];

function MoneyScreen() {
  const canEnter = useCan("enter_money");
  const canReverse = useCan("reverse");
  const customerId = useSearchParams().get("customer");
  const preset = useGet<CustomerDetail>(customerId === null ? null : `/v1/customers/${customerId}`);
  const [tab, setTab] = useState<Tab>("payment");
  const [reversing, setReversing] = useState<{ entryId: string; what: string } | null>(null);
  const payments = useGet<Page<Payment>>("/v1/payments?limit=12");
  const cashOuts = useGet<Page<CashOut>>("/v1/cash-outs?limit=8");

  return (
    <>
      <PageHead title="Money" hint="What comes in at the office and what goes out of the vault. Money collected on a round is entered on the round." />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="flex flex-col gap-5">
          <RateCard canSet={canEnter} />
          {canEnter ? (
            <Card>
              <div className="border-b border-rule px-5 py-3.5">
                <Segmented label="What is being entered" value={tab} onChange={setTab} options={TABS} />
              </div>
              {tab === "payment" ? <PaymentForm initial={preset.data ?? null} /> : tab === "cash_out" ? <CashOutForm /> : <ExchangeForm />}
            </Card>
          ) : null}
          <WalletsCard canCheck={canEnter} />
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
                        ) : canReverse ? (
                          <button type="button" className="text-[13px] text-muted hover:text-red hover:underline" onClick={() => setReversing({ entryId: p.entryId, what: `${p.customerName}'s payment` })}>
                            Reverse
                          </button>
                        ) : null}
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
                        ) : canReverse ? (
                          <button type="button" className="text-[13px] text-muted hover:text-red hover:underline" onClick={() => setReversing({ entryId: c.entryId, what: `this cash out` })}>
                            Reverse
                          </button>
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
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
