"use client";

import type { Currency, DriverAccountDetail, DriverMoneyKind, ExpenseCategory, Page, RoundSummary } from "@green-star/contracts";
import { EXPENSE_CATEGORIES } from "@green-star/contracts";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { AmountBox, EXPENSE, holdsText } from "@/components/drivers";
import { useToast } from "@/components/toast";
import { Button, Card, CardHead, Empty, Field, Input, Loading, PageHead, Problem, ReadProblem, Segmented, Select, Stat, Table, Td, Th } from "@/components/ui";
import { api, withQuery } from "@/lib/api";
import { useGet, useSave } from "@/lib/hooks";
import { dayTime, phone } from "@/lib/labels";
import { formatMoney, parseAmount } from "@/lib/money";

const WHAT: { value: DriverMoneyKind; label: string }[] = [
  { value: "advance", label: "Give him money" },
  { value: "expense", label: "A receipt he brought" },
  { value: "return", label: "He gave money back" },
];

const LINE: Record<string, string> = { advance: "Given to him", expense: "Receipt", return: "Gave back", change: "Change at a door" };

function MoneyForm({ account, initialRound, initialWhat }: { account: DriverAccountDetail; initialRound: string | null; initialWhat: DriverMoneyKind | null }) {
  const toast = useToast();
  const [what, setWhat] = useState<DriverMoneyKind>(initialWhat ?? (initialRound === null ? "expense" : "advance"));
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("IQD");
  const [category, setCategory] = useState<ExpenseCategory>("fuel_car");
  const [roundId, setRoundId] = useState(initialRound ?? "");
  const [city, setCity] = useState("");
  const [note, setNote] = useState("");
  const rounds = useGet<Page<RoundSummary>>(withQuery("/v1/rounds", { limit: 30 }));
  const mine = (rounds.data?.items ?? []).filter((r) => r.driverId === account.driverId);

  const save = useSave(
    (body: unknown, key: string) => api.post<DriverAccountDetail>(`/v1/drivers/${account.driverId}/money`, body, key),
    () => {
      toast(what === "advance" ? `${formatMoney(typed ?? 0, currency)} given to ${account.name}` : what === "return" ? `${formatMoney(typed ?? 0, currency)} back from ${account.name}` : `Receipt for ${formatMoney(typed ?? 0, currency)} entered`);
      setAmount("");
      setNote("");
      setCity("");
    },
  );
  const typed = amount.trim() === "" ? null : parseAmount(amount, currency);
  const bad = amount.trim() !== "" && typed === null;

  return (
    <form
      className="flex flex-col gap-4 p-5"
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void save.save({
          what,
          amount: { amount: typed, currency },
          ...(what === "expense" ? { category } : {}),
          ...(roundId === "" ? {} : { roundId }),
          ...(what === "expense" && city.trim() !== "" ? { city: city.trim() } : {}),
          ...(note.trim() === "" ? {} : { note }),
        });
      }}
    >
      <Segmented label="What happened" value={what} onChange={(v) => { setWhat(v); save.clear(); }} options={WHAT} />
      <p className="rounded-md bg-sunken px-3 py-2 text-[13px] text-muted">
        {what === "advance"
          ? "Money out of the vault, for the road: fuel, workers, a transport company, change at doors."
          : what === "expense"
            ? "One receipt at a time. What kind it was, and the city, is what makes the delivery costs exact."
            : "What he did not spend, back into the vault. What he keeps stays on his account for the next round."}
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Amount" problem={bad ? "That is not an amount" : save.fieldProblem("amount.amount")}>
          {(id) => <AmountBox id={id} amount={amount} currency={currency} onAmount={setAmount} onCurrency={setCurrency} problem={bad ? "bad" : undefined} />}
        </Field>
        {what === "expense" ? (
          <Field label="What for" problem={save.fieldProblem("category")}>
            {(id) => (
              <Select id={id} value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory)}>
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {EXPENSE[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field label="Round" hint="Optional: the round it was for">
          {(id) => (
            <Select id={id} value={roundId} onChange={(e) => setRoundId(e.target.value)}>
              <option value="">No round</option>
              {mine.map((r) => (
                <option key={r.id} value={r.id}>
                  Round {r.number}
                  {r.leftAt ? `, left ${dayTime(r.leftAt)}` : ", not left yet"}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {what === "expense" ? (
          <Field label="City" hint="Optional: Erbil, Duhok, Kirkuk…" problem={save.fieldProblem("city")}>
            {(id) => <Input id={id} value={city} onChange={(e) => setCity(e.target.value)} />}
          </Field>
        ) : null}
        <Field label="Note" hint="Optional">
          {(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
      <Problem of={save.problem} />
      <div>
        <Button type="submit" tone="primary" busy={save.saving} disabled={typed === null || typed === 0}>
          {what === "advance" ? "Give it to him" : what === "expense" ? "Enter the receipt" : "Take it back"}
        </Button>
      </div>
    </form>
  );
}

function DriverScreen() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const initialRound = search.get("round");
  const asked = search.get("what");
  const initialWhat = asked === "advance" || asked === "expense" || asked === "return" ? asked : null;
  const account = useGet<DriverAccountDetail>(`/v1/drivers/${id}/account`);
  if (account.error) return <ReadProblem of={account.error} />;
  if (account.data === undefined) return <Loading what="Opening his account" />;
  const a = account.data;

  return (
    <>
      <PageHead eyebrow="Driver's account" title={<span dir="auto">{a.name}</span>} hint={a.phone ? phone(a.phone) : undefined} />
      <Card className="mb-5 grid grid-cols-1 gap-6 p-5 sm:grid-cols-3">
        <Stat label="He holds, dinars" tone={a.holdsIqd < 0 ? "amber" : undefined} hint={a.holdsIqd < 0 ? "He spent his own: the office owes him." : undefined}>
          {formatMoney(a.holdsIqd, "IQD")}
        </Stat>
        <Stat label="He holds, dollars" tone={a.holdsUsdCents < 0 ? "amber" : undefined}>
          {formatMoney(a.holdsUsdCents, "USD")}
        </Stat>
        <div className="flex flex-col gap-1 text-[13px] text-muted">
          <span className="eyebrow">In words</span>
          <span className="text-sm text-ink">{holdsText(a)}</span>
          <span>Given when he leaves, less his receipts, the change he gave at doors, and what he gave back.</span>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <Card>
          <MoneyForm account={a} initialRound={initialRound} initialWhat={initialWhat} />
        </Card>
        <Card>
          <CardHead title="His account, line by line" hint="Newest first. A wrong line is reversed on the Money screen and entered again." />
          {a.lines.length === 0 ? (
            <Empty title="Nothing yet">Give him money before he leaves, then enter his receipts when he is back.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>What</Th>
                  <Th right>Amount</Th>
                  <Th right>After</Th>
                </tr>
              </thead>
              <tbody>
                {a.lines.map((line) => (
                  <tr key={`${line.entryId}-${line.currency}`} className={line.reversed || line.isReversal ? "text-faint" : undefined}>
                    <Td className="whitespace-nowrap text-[13px] text-muted">{dayTime(line.happenedAt)}</Td>
                    <Td>
                      <span className="font-medium">{line.isReversal ? "Reversed" : LINE[line.kind]}</span>
                      {line.category ? <span className="ml-1.5 text-[13px]">· {EXPENSE[line.category]}</span> : null}
                      {line.customerName ? <span className="ml-1.5 text-[13px]" dir="auto">· {line.customerName}</span> : null}
                      <span className="block text-[12px] text-muted">
                        {[line.city, line.roundNumber === null ? null : `Round ${line.roundNumber}`, line.note].filter(Boolean).join(" · ")}
                        {line.roundId !== null ? (
                          <Link href={`/rounds/${line.roundId}`} className="ml-1.5 hover:text-green hover:underline">
                            open
                          </Link>
                        ) : null}
                      </span>
                    </Td>
                    <Td right className={`num ${line.amount < 0 ? "" : "text-green"}`}>
                      {line.amount > 0 ? "+" : "−"}
                      {formatMoney(Math.abs(line.amount), line.currency)}
                    </Td>
                    <Td right className="num text-[13px] text-muted">
                      {formatMoney(line.balanceAfter, line.currency)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

export default function DriverPage() {
  return (
    <Suspense>
      <DriverScreen />
    </Suspense>
  );
}
