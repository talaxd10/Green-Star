"use client";

import type { Consignment, Currency, RoundDetail, RoundMethod, RoundOutcome, RoundStop, Settings, Vault } from "@green-star/contracts";
import { checkRoundResult } from "@green-star/domain";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { NoteCounter } from "@/components/note-counter";
import { Button, Card, CardHead, Chip, Dialog, Empty, Field, FormActions, Input, Loading, Money, PageHead, Problem, ReadProblem, Select, Stat, Table, Td, Textarea, Th } from "@/components/ui";
import { api } from "@/lib/api";
import { useGet, useRateToday, useSave } from "@/lib/hooks";
import { CONSIGNMENT, dayTime, METHOD, OUTCOME, ROUND, TRUST } from "@/lib/labels";
import { amountForInput, countNotes, formatMoney, formatRatePerDollar, parseAmount, planParts } from "@/lib/money";

/** One way he paid at the door: an amount, its currency, and how. */
interface PartDraft {
  amount: string;
  currency: Currency;
  method: RoundMethod;
}

/** What is typed on one row before it is saved. A customer can pay in more than one way, so the money is a list. */
interface Draft {
  outcome: RoundOutcome | "";
  parts: PartDraft[];
}

const MAX_PARTS = 4;
const emptyPart = (currency: Currency = "USD"): PartDraft => ({ amount: "", currency, method: "driver_cash" });

const PROBLEMS: Record<string, string> = {
  payment_incomplete: "Enter the amount and how it was paid",
  amount_invalid: "The amount must be more than zero",
  outcome_invalid: "That outcome does not fit this customer",
  not_trusted: "He is pay first and cannot take goods on account",
  payment_missing: "Paid needs the amount received",
  payment_invalid: "Two payments in the same currency and the same way are one payment",
};

function fromStop(stop: RoundStop): Draft {
  return {
    outcome: stop.outcome ?? "",
    parts:
      stop.payments.length === 0
        ? [emptyPart()]
        : stop.payments.map((part) => ({ amount: amountForInput(part.receivedAmount, part.receivedCurrency), currency: part.receivedCurrency, method: part.method })),
  };
}

/** What this stop's own payments were worth on his account, all parts together. */
const creditedAt = (stop: RoundStop) => stop.payments.reduce((sum, part) => sum + part.creditedUsdCents, 0);

/** The parts of a row that have an amount typed, as numbers. Null amounts are ones that could not be read. */
const typedParts = (draft: Draft) =>
  draft.parts.flatMap((part) => (part.amount.trim() === "" ? [] : [{ amount: parseAmount(part.amount, part.currency), currency: part.currency, method: part.method }]));

/** The outcomes that make sense for this customer and these goods. */
function outcomesFor(stop: RoundStop): RoundOutcome[] {
  if (stop.amountDueUsdCents === 0) return ["prepaid", "held"];
  return stop.trust === "trusted" ? ["paid", "on_account", "held"] : ["paid", "unpaid", "held"];
}

const takesMoney = (outcome: RoundOutcome | "") => outcome === "paid" || outcome === "on_account" || outcome === "unpaid";

/** For a date-and-time box: now, in the computer's own time. */
function nowLocal(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function AllowException({ stop, onClose }: { stop: RoundStop; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const allow = useSave((body: unknown, key: string) => api.post("/v1/exceptions", body, key), onClose);
  return (
    <Dialog open onClose={onClose} title={`Allow ${stop.customerName} to pay later`} hint="He is pay first and has the goods without paying in full. This takes him off the forgot-to-collect list and puts him on the chase list until he pays.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void allow.save({ consignmentId: stop.consignmentId, reason });
        }}
      >
        <Field label="Why it was allowed" problem={allow.fieldProblem("reason")}>
          {(id) => <Textarea id={id} rows={2} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Pays on Thursday, agreed by phone" />}
        </Field>
        <Problem of={allow.problem} />
        <FormActions onCancel={onClose} saving={allow.saving} save="Allow it" disabled={reason.trim() === ""} />
      </form>
    </Dialog>
  );
}

function TakeBack({ title, hint, url, onClose }: { title: string; hint: string; url: string; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const take = useSave((body: unknown, key: string) => api.post(url, body, key), onClose);
  return (
    <Dialog open onClose={onClose} title={title} hint={hint}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void take.save({ reason });
        }}
      >
        <Field label="Why">{(id) => <Textarea id={id} rows={2} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <Problem of={take.problem} />
        <FormActions onCancel={onClose} saving={take.saving} save="Take it back" danger disabled={reason.trim() === ""} />
      </form>
    </Dialog>
  );
}

function AddGoods({ round, onClose }: { round: RoundDetail; onClose: () => void }) {
  const ready = useGet<{ items: Consignment[] }>("/v1/consignments?filter=ready");
  const add = useSave((consignmentId: string, key: string) => api.post(`/v1/rounds/${round.id}/stops`, { consignmentId }, key));
  return (
    <Dialog open onClose={onClose} title={`Add goods to round ${round.number}`} wide>
      {ready.data === undefined ? (
        <Loading />
      ) : ready.data.items.length === 0 ? (
        <Empty title="Nothing else is waiting" />
      ) : (
        <ul className="-mx-6 divide-y divide-rule border-y border-rule">
          {ready.data.items.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-4 px-6 py-2.5 text-sm">
              <span className="min-w-0">
                <b className="font-semibold" dir="auto">{row.customerName}</b>
                <span className="num ml-2 text-[12px] text-muted">{row.shipmentCode}{row.city ? ` · ${row.city}` : ""}</span>
              </span>
              <span className="flex items-center gap-4">
                <Money amount={row.remainingUsdCents} />
                <Button small busy={add.saving} onClick={() => void add.save(row.id)}>
                  Add
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4"><Problem of={add.problem} /></div>
    </Dialog>
  );
}

function HandIn({ round }: { round: RoundDetail }) {
  const vault = useGet<Vault>("/v1/vault");
  const [usdNotes, setUsdNotes] = useState<Record<string, number>>({});
  const [iqdNotes, setIqdNotes] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const [id, setId] = useState(() => crypto.randomUUID());
  const handIn = useSave(
    (body: unknown, key: string) => api.post<RoundDetail>(`/v1/rounds/${round.id}/hand-in`, body, key),
    () => {
      setUsdNotes({});
      setIqdNotes({});
      setNote("");
      setId(crypto.randomUUID());
    },
  );
  const expected = (currency: Currency) => round.cash.find((c) => c.currency === currency)?.gap ?? 0;
  const gap = countNotes(usdNotes) !== expected("USD") || countNotes(iqdNotes) !== expected("IQD");
  const nothing = countNotes(usdNotes) === 0 && countNotes(iqdNotes) === 0;
  const missing = round.stops - round.results;

  if (vault.data === undefined) return <Loading />;
  if (missing > 0) {
    return <p className="px-5 py-4 text-sm text-muted">Enter what happened at the last {missing === 1 ? "stop" : `${missing} stops`} first. The cash is counted once every stop has its result.</p>;
  }
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void handIn.save({ id, happenedAt: new Date().toISOString(), usdNotes, iqdNotes, ...(note.trim() === "" ? {} : { note }) });
      }}
    >
      <div className="grid grid-cols-1 divide-y divide-rule md:grid-cols-2 md:divide-x md:divide-y-0">
        <NoteCounter currency="USD" denominations={vault.data.denominations} notes={usdNotes} onChange={setUsdNotes} expected={expected("USD")} />
        <NoteCounter currency="IQD" denominations={vault.data.denominations} notes={iqdNotes} onChange={setIqdNotes} expected={expected("IQD")} />
      </div>
      <div className="flex flex-col gap-3 border-t border-rule p-5">
        {gap ? (
          <Field label="Why the cash and the receipts differ" hint="Only what was counted goes into the vault. The gap stays on this round.">
            {(fieldId) => <Textarea id={fieldId} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="He says $20 is at home and he brings it tomorrow" />}
          </Field>
        ) : null}
        <Problem of={handIn.problem} />
        <div>
          <Button type="submit" tone="primary" busy={handIn.saving} disabled={(gap && note.trim() === "") || (round.status === "handed_in" && nothing)}>
            Count it into the vault
          </Button>
        </div>
      </div>
    </form>
  );
}

export default function RoundPage() {
  const { id } = useParams<{ id: string }>();
  const round = useGet<RoundDetail>(`/v1/rounds/${id}`);
  const rate = useRateToday();
  const settings = useGet<Settings>("/v1/settings");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [when, setWhen] = useState(nowLocal);
  const [doing, setDoing] = useState<{ kind: "exception" | "void"; stop: RoundStop } | { kind: "voidHandIn"; handInId: string } | { kind: "add" } | null>(null);

  const saveResults = useSave((body: unknown, key: string) => api.put<RoundDetail>(`/v1/rounds/${id}/results`, body, key), () => setDrafts({}));
  const depart = useSave((_: null, key: string) => api.post<RoundDetail>(`/v1/rounds/${id}/depart`, {}, key));
  const removeStop = useSave((consignmentId: string, key: string) => api.del<RoundDetail>(`/v1/rounds/${id}/stops/${consignmentId}`, key));

  if (round.error) return <ReadProblem of={round.error} />;
  if (round.data === undefined) return <Loading what="Opening the round" />;
  const r = round.data;
  const planned = r.status === "planned";
  const editable = !planned;
  const todayRate = rate.data?.rate?.iqdPer100Usd ?? null;
  const step = settings.data?.dinarRoundingIqd ?? 1000;
  const errorLimit = settings.data?.errorMaxUsdCents ?? 0;
  const files = [...new Set(r.stopList.map((stop) => stop.shipmentCode))];

  const draftOf = (stop: RoundStop): Draft => drafts[stop.consignmentId] ?? fromStop(stop);
  const edit = (stop: RoundStop, change: Partial<Draft>) =>
    setDrafts((current) => {
      const next = { ...(current[stop.consignmentId] ?? fromStop(stop)), ...change };
      if (!takesMoney(next.outcome)) next.parts = [emptyPart()];
      return { ...current, [stop.consignmentId]: next };
    });
  const editPart = (stop: RoundStop, index: number, change: Partial<PartDraft>) =>
    edit(stop, { parts: draftOf(stop).parts.map((part, i) => (i === index ? { ...part, ...change } : part)) });
  const addPart = (stop: RoundStop) => {
    const parts = draftOf(stop).parts;
    // The usual second part is the other currency.
    edit(stop, { parts: [...parts, emptyPart(parts.some((part) => part.currency === "IQD") ? "USD" : "IQD")] });
  };
  const removePart = (stop: RoundStop, index: number) => edit(stop, { parts: draftOf(stop).parts.filter((_, i) => i !== index) });

  /** What was owed on these goods before this stop's own payments. */
  const dueAt = (stop: RoundStop) => Math.min(stop.amountDueUsdCents, stop.remainingUsdCents + creditedAt(stop));

  /** What is wrong with a row as typed, or null. The database checks the same rules again. */
  const problemOf = (stop: RoundStop, draft: Draft): string | null => {
    if (draft.outcome === "") return null;
    const typed = typedParts(draft);
    const unread = typed.find((part) => part.amount === null);
    if (unread !== undefined) return unread.currency === "IQD" ? "Dinars are whole numbers" : "That is not an amount";
    if (typed.some((part) => part.currency === "IQD") && todayRate === null) return "Set today's dinar rate first";
    if (new Set(typed.map((part) => `${part.currency} ${part.method}`)).size < typed.length) return PROBLEMS.payment_invalid as string;
    const first = typed[0];
    const problem = checkRoundResult({
      outcome: draft.outcome,
      trust: stop.trust,
      amountDueUsdCents: BigInt(stop.amountDueUsdCents),
      // What was owed before this stop's own payments, if it already has some.
      remainingUsdCents: BigInt(stop.remainingUsdCents + creditedAt(stop)),
      ...(first === undefined ? {} : { received: { amount: BigInt(first.amount as number), currency: first.currency }, method: first.method }),
    });
    return problem === null ? null : (PROBLEMS[problem] ?? problem);
  };

  /** True while a row added for another payment has no amount yet: not a mistake, but not ready to save. */
  const waitingOn = (draft: Draft) => draft.parts.length > 1 && draft.parts.some((part) => part.amount.trim() === "");

  const changed = r.stopList.filter((stop) => stop.consignmentId in drafts && draftOf(stop).outcome !== "");
  const anyProblem = changed.some((stop) => problemOf(stop, draftOf(stop)) !== null || waitingOn(draftOf(stop)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const happenedAt = new Date(when).toISOString();
    void saveResults.save({
      results: changed.map((stop) => {
        const [first, ...more] = typedParts(draftOf(stop)).map((part) => ({ received: { amount: part.amount, currency: part.currency }, method: part.method }));
        return {
          id: crypto.randomUUID(),
          consignmentId: stop.consignmentId,
          outcome: draftOf(stop).outcome,
          happenedAt,
          ...(first === undefined ? {} : first),
          ...(more.length === 0 ? {} : { more }),
        };
      }),
    });
  };

  const cash = (currency: Currency) => r.cash.find((c) => c.currency === currency) ?? { currency, collected: 0, handedIn: 0, gap: 0 };
  const missed = r.stopList.filter((stop) => stop.missedCollection);

  return (
    <>
      <PageHead
        eyebrow="Round"
        title={
          <>
            Round <span className="num">{r.number}</span>
          </>
        }
        hint={
          <span className="flex flex-wrap items-center gap-3">
            <Chip tone={ROUND[r.status].tone}>{ROUND[r.status].label}</Chip>
            <span>{r.driverName ? `Driver ${r.driverName}` : r.carrierName}</span>
            {files.length > 0 ? <span className="num">{files.join(", ")}</span> : null}
            {r.leftAt ? <span>Left {dayTime(r.leftAt)}</span> : null}
            {r.note ? <span>· {r.note}</span> : null}
          </span>
        }
      >
        {planned ? (
          <>
            <Button onClick={() => setDoing({ kind: "add" })}>Add goods</Button>
            <Button tone="primary" busy={depart.saving} disabled={r.stops === 0} onClick={() => void depart.save(null)}>
              He has left
            </Button>
          </>
        ) : null}
      </PageHead>
      <Problem of={depart.problem ?? removeStop.problem} />

      {missed.length > 0 ? (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red bg-red-soft px-5 py-3.5 text-red" role="alert">
          <p className="text-sm">
            <b className="font-semibold">The driver forgot to collect.</b> {missed.map((stop) => stop.customerName).join(", ")} {missed.length === 1 ? "has" : "have"} the goods without paying in full, and nobody allowed it.
          </p>
        </div>
      ) : null}

      <form onSubmit={submit}>
        <Card className="mb-5">
          <CardHead
            title={planned ? "Goods on this round" : "What happened at each stop"}
            hint={planned ? undefined : "From the receipts and photos he brought back. Dinars convert at the day's rate."}
            action={
              editable ? (
                <label className="flex items-center gap-2 text-[13px] text-muted">
                  When
                  <Input type="datetime-local" className="h-8 w-auto text-[13px]" value={when} max={nowLocal()} onChange={(e) => setWhen(e.target.value)} />
                </label>
              ) : null
            }
          />
          {r.stopList.length === 0 ? (
            <Empty title="Nothing on this round yet">Add the goods he is taking before he leaves.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Customer</Th>
                  <Th right>Cartons</Th>
                  <Th right>Due</Th>
                  <Th>Outcome</Th>
                  <Th>Received</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {r.stopList.map((stop) => {
                  const draft = draftOf(stop);
                  const dirty = stop.consignmentId in drafts;
                  const problem = dirty ? problemOf(stop, draft) : null;
                  const typed = typedParts(draft);
                  // What each part will be worth, worked out the way it will be saved: dollars first, then the dinars.
                  const plan =
                    dirty && !waitingOn(draft) && typed.length > 0 && typed.every((part) => part.amount !== null && part.amount > 0)
                      ? planParts(
                          typed.map((part) => ({ amount: part.amount as number, currency: part.currency })),
                          { iqdPer100Usd: todayRate, owedUsdCents: dueAt(stop), owedForConsignmentUsdCents: dueAt(stop), stepIqd: step },
                        )
                      : null;
                  const cartonsOff = stop.cartonsExpected !== null && stop.cartonsReceived !== null && stop.cartonsExpected !== stop.cartonsReceived;
                  const due = dueAt(stop);
                  return (
                    <tr key={stop.consignmentId} className={stop.missedCollection ? "bg-red-soft/40" : dirty ? "bg-amber-soft/40" : undefined}>
                      <Td className="min-w-[210px]">
                        <Link href={`/customers/${stop.customerId}`} className="font-semibold hover:text-green" dir="auto">
                          {stop.customerName}
                        </Link>
                        <span className="block whitespace-nowrap text-[12px] text-muted">
                          {TRUST[stop.trust].label.toLowerCase()}
                          {stop.city ? ` · ${stop.city}` : ""} · <span className="num">{stop.shipmentCode}</span>
                        </span>
                      </Td>
                      <Td right className={`num text-[13px] ${cartonsOff ? "font-semibold text-amber-ink" : "text-muted"}`}>
                        {stop.cartonsReceived !== null ? `${stop.cartonsReceived} of ${stop.cartonsExpected ?? "?"}` : (stop.cartonsExpected ?? "")}
                      </Td>
                      <Td right>{stop.amountDueUsdCents === 0 ? <span className="text-[13px] text-muted">prepaid</span> : <Money amount={due} />}</Td>
                      <Td>
                        {editable ? (
                          <Select aria-label={`Outcome for ${stop.customerName}`} className="h-9 w-48" value={draft.outcome} onChange={(e) => edit(stop, { outcome: e.target.value as RoundOutcome })} problem={problem ?? undefined}>
                            <option value="">Not entered</option>
                            {outcomesFor(stop).map((outcome) => (
                              <option key={outcome} value={outcome}>
                                {OUTCOME[outcome].label}
                              </option>
                            ))}
                          </Select>
                        ) : stop.outcome ? (
                          <Chip tone={OUTCOME[stop.outcome].tone}>{OUTCOME[stop.outcome].label}</Chip>
                        ) : planned ? (
                          <Chip tone={CONSIGNMENT[stop.consignmentStatus].tone}>{CONSIGNMENT[stop.consignmentStatus].label}</Chip>
                        ) : (
                          <span className="text-[13px] text-muted">Not entered</span>
                        )}
                      </Td>
                      <Td>
                        {editable && takesMoney(draft.outcome) ? (
                          <div className="flex flex-col gap-1">
                            {draft.parts.map((part, index) => (
                              <div key={index} className="flex items-center gap-1.5" data-part={index + 1}>
                                <Input
                                  aria-label={index === 0 ? `Amount received from ${stop.customerName}` : `Payment ${index + 1} from ${stop.customerName}`}
                                  className="num h-9 w-28 text-right"
                                  inputMode="decimal"
                                  placeholder={index > 0 ? "and" : draft.outcome === "paid" ? "amount" : "if any"}
                                  value={part.amount}
                                  onChange={(e) => editPart(stop, index, { amount: e.target.value })}
                                  problem={problem ?? undefined}
                                />
                                <Select aria-label={index === 0 ? "Currency" : `Currency of payment ${index + 1}`} className="h-9 w-[76px]" value={part.currency} onChange={(e) => editPart(stop, index, { currency: e.target.value as Currency })}>
                                  <option value="USD">$</option>
                                  <option value="IQD">IQD</option>
                                </Select>
                                <Select aria-label={index === 0 ? "How it was paid" : `How payment ${index + 1} was paid`} className="h-9 w-[168px]" value={part.method} onChange={(e) => editPart(stop, index, { method: e.target.value as RoundMethod })}>
                                  {(["driver_cash", "fib", "fastpay", "zaincash"] as const).map((method) => (
                                    <option key={method} value={method}>
                                      {METHOD[method]}
                                    </option>
                                  ))}
                                </Select>
                                {index > 0 ? (
                                  <button type="button" className="px-1 text-[13px] text-muted hover:text-red" aria-label={`Remove ${stop.customerName}'s payment ${index + 1}`} onClick={() => removePart(stop, index)}>
                                    ✕
                                  </button>
                                ) : null}
                              </div>
                            ))}
                            {problem ? (
                              <span className="text-[12px] text-red">{problem}</span>
                            ) : waitingOn(draft) ? (
                              <span className="text-[12px] text-muted">Enter the other amount, or remove the empty row.</span>
                            ) : !dirty ? (
                              stop.payments.map((paid, index) =>
                                paid.receivedCurrency === "IQD" && paid.iqdPer100Usd !== null ? (
                                  <span key={index} className="num text-[12px] text-muted">
                                    {formatMoney(paid.receivedAmount, "IQD")} → {formatMoney(paid.creditedUsdCents, "USD")} at {formatRatePerDollar(paid.iqdPer100Usd)}
                                  </span>
                                ) : null,
                              )
                            ) : plan !== null && todayRate !== null ? (
                              <>
                                {typed.map((part, index) =>
                                  part.currency !== "IQD" ? null : plan.credited[index] === plan.exact[index] ? (
                                    <span key={index} className="num text-[12px] text-muted">
                                      {formatMoney(part.amount as number, "IQD")} → about {formatMoney(plan.exact[index] as number, "USD")} at today&apos;s {formatRatePerDollar(todayRate)}
                                    </span>
                                  ) : (
                                    <span key={index} className="num text-[12px] text-green">
                                      {formatMoney(part.amount as number, "IQD")} → counts as {formatMoney(plan.credited[index] as number, "USD")}: it settles what is left
                                    </span>
                                  ),
                                )}
                                {typed.length > 1 ? (
                                  <span className="num text-[12px] text-muted">
                                    Together {formatMoney(plan.total, "USD")}
                                    {plan.left > 0 ? `, ${formatMoney(plan.left, "USD")} still owed` : plan.left < 0 ? `, ${formatMoney(-plan.left, "USD")} over` : ", paid in full"}
                                  </span>
                                ) : null}
                              </>
                            ) : null}
                            {draft.parts.length < MAX_PARTS ? (
                              <button type="button" className="self-start text-[12px] font-semibold text-green hover:underline" aria-label={`${stop.customerName} also paid another way`} onClick={() => addPart(stop)}>
                                + also paid another way
                              </button>
                            ) : null}
                          </div>
                        ) : stop.payments.length > 0 ? (
                          <span className="num flex flex-col text-sm">
                            {stop.payments.map((paid, index) => (
                              <span key={index}>
                                {formatMoney(paid.receivedAmount, paid.receivedCurrency)}
                                {paid.receivedCurrency === "IQD" ? <span className="text-muted"> → {formatMoney(paid.creditedUsdCents, "USD")}</span> : null}
                                {paid.method !== "driver_cash" ? <span className="ml-2 text-[12px] text-muted">{METHOD[paid.method]}</span> : null}
                              </span>
                            ))}
                          </span>
                        ) : editable && problem ? (
                          <span className="text-[12px] text-red">{problem}</span>
                        ) : (
                          <span className="text-[13px] text-faint">none</span>
                        )}
                      </Td>
                      <Td right className="whitespace-nowrap">
                        {planned ? (
                          <button type="button" className="text-[13px] font-semibold text-red hover:underline" onClick={() => void removeStop.save(stop.consignmentId)}>
                            Take off
                          </button>
                        ) : null}
                        {stop.hasException ? <Chip tone="amber">Allowed, chase him</Chip> : null}
                        {stop.missedCollection ? (
                          <button type="button" className="text-[13px] font-semibold text-red hover:underline" onClick={() => setDoing({ kind: "exception", stop })}>
                            Allow it
                          </button>
                        ) : null}
                        {/* A few cents or dollars short, inside the Error limit: one click to the Error entry, filled in. */}
                        {stop.missedCollection && !dirty && stop.remainingUsdCents > 0 && stop.remainingUsdCents <= errorLimit ? (
                          <Link href={`/money?customer=${stop.customerId}&error=${stop.remainingUsdCents}`} className="ml-3 text-[13px] font-semibold text-green hover:underline">
                            {formatMoney(stop.remainingUsdCents, "USD")} short: enter as Error
                          </Link>
                        ) : null}
                        {editable && stop.resultId && !dirty ? (
                          <button type="button" className="ml-3 text-[13px] text-muted hover:text-red hover:underline" onClick={() => setDoing({ kind: "void", stop })}>
                            Take back
                          </button>
                        ) : null}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          {!planned ? (
            <footer className="flex flex-wrap items-center justify-between gap-x-8 gap-y-2 border-t border-rule bg-paper px-5 py-3.5 text-sm">
              <span>
                Cash on the receipts: <b className="num">{formatMoney(cash("USD").collected, "USD")}</b> · <b className="num">{formatMoney(cash("IQD").collected, "IQD")}</b>
              </span>
              <span>
                Counted in: <b className="num">{formatMoney(cash("USD").handedIn, "USD")}</b> · <b className="num">{formatMoney(cash("IQD").handedIn, "IQD")}</b>
              </span>
              {editable ? (
                <span className="flex items-center gap-3">
                  {changed.length > 0 ? <span className="text-[13px] text-amber-ink">{changed.length} not saved</span> : null}
                  <Button type="submit" tone="primary" busy={saveResults.saving} disabled={changed.length === 0 || anyProblem}>
                    Save the results
                  </Button>
                </span>
              ) : null}
            </footer>
          ) : null}
        </Card>
        <div className="mb-5">
          <Problem of={saveResults.problem} />
        </div>
      </form>

      {!planned ? (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card>
            <CardHead
              title="Count the driver's cash"
              hint={
                r.status === "handed_in" && cash("USD").gap === 0 && cash("IQD").gap === 0
                  ? "All the cash on the receipts is counted in."
                  : "Note by note, per currency. It is checked against the receipts entered above."
              }
            />
            <HandIn round={r} />
          </Card>

          <div className="flex flex-col gap-5">
            <Card className="grid grid-cols-2 gap-5 p-5">
              <Stat label="Still on the round, $" tone={r.status === "handed_in" && cash("USD").gap !== 0 ? "red" : undefined}>
                {formatMoney(cash("USD").gap, "USD")}
              </Stat>
              <Stat label="Still on the round, IQD" tone={r.status === "handed_in" && cash("IQD").gap !== 0 ? "red" : undefined}>
                {formatMoney(cash("IQD").gap, "IQD")}
              </Stat>
            </Card>
            <Card>
              <CardHead title="Hand-ins" />
              {r.handIns.length === 0 ? (
                <Empty title="Nothing counted in yet" />
              ) : (
                <ul className="divide-y divide-rule">
                  {r.handIns.map((handIn) => (
                    <li key={handIn.id} className={`px-5 py-3 text-sm ${handIn.voided ? "text-faint line-through" : ""}`}>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[13px] text-muted">{dayTime(handIn.happenedAt)}</span>
                        {!handIn.voided ? (
                          <button type="button" className="text-[13px] text-muted hover:text-red hover:underline" onClick={() => setDoing({ kind: "voidHandIn", handInId: handIn.id })}>
                            Take back
                          </button>
                        ) : null}
                      </div>
                      {handIn.counts.map((count) => (
                        <p key={count.currency} className="num">
                          {formatMoney(count.counted, count.currency)}
                          {count.difference !== 0 ? <span className="text-red"> ({count.difference < 0 ? "short" : "over"} {formatMoney(Math.abs(count.difference), count.currency)})</span> : null}
                        </p>
                      ))}
                      {handIn.note ? <p className="mt-1 text-[13px] text-muted">{handIn.note}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      ) : null}

      {doing?.kind === "exception" ? <AllowException stop={doing.stop} onClose={() => setDoing(null)} /> : null}
      {doing?.kind === "void" ? (
        <TakeBack title={`Take back ${doing.stop.customerName}'s result`} hint="The stop is open again and any money it posted is reversed." url={`/v1/round-results/${doing.stop.resultId}/void`} onClose={() => setDoing(null)} />
      ) : null}
      {doing?.kind === "voidHandIn" ? <TakeBack title="Take back this hand-in" hint="The cash goes back onto the round, to be counted again." url={`/v1/hand-ins/${doing.handInId}/void`} onClose={() => setDoing(null)} /> : null}
      {doing?.kind === "add" ? <AddGoods round={r} onClose={() => setDoing(null)} /> : null}
    </>
  );
}
