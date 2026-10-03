"use client";

import type { CustomerSummary, ShipmentDetail } from "@green-star/contracts";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { CustomerPicker } from "@/components/customer-picker";
import { Button, Card, Field, Input, LinkButton, Loading, Money, PageHead, Problem } from "@/components/ui";
import { api } from "@/lib/api";
import { useGet, useSave } from "@/lib/hooks";
import { amountForInput, parseAmount } from "@/lib/money";

interface Row {
  key: number;
  customer: CustomerSummary | null;
  amount: string;
  cartons: string;
  city: string;
}

let nextRow = 1;
const blank = (): Row => ({ key: nextRow++, customer: null, amount: "", cartons: "", city: "" });

function FileForm() {
  const router = useRouter();
  const draftId = useSearchParams().get("draft");
  const draft = useGet<ShipmentDetail>(draftId === null ? null : `/v1/shipments/${draftId}`);
  const [code, setCode] = useState("");
  const [arrivedOn, setArrivedOn] = useState("");
  const [rows, setRows] = useState<Row[]>(() => [blank(), blank(), blank()]);
  const [loaded, setLoaded] = useState(false);

  // Editing a draft: its rows are put back in their boxes, once.
  useEffect(() => {
    if (draft.data === undefined || loaded) return;
    setCode(draft.data.code);
    setArrivedOn(draft.data.arrivedOn ?? "");
    setRows(
      draft.data.consignmentList.map((c) => ({
        key: nextRow++,
        customer: { id: c.customerId, name: c.customerName, trust: c.trust, phone: null, marks: [], balanceUsdCents: 0 } as unknown as CustomerSummary,
        amount: amountForInput(c.amountDueUsdCents, "USD"),
        cartons: c.cartonsExpected === null ? "" : String(c.cartonsExpected),
        city: c.city ?? "",
      })),
    );
    setLoaded(true);
  }, [draft.data, loaded]);

  const save = useSave(
    (body: unknown, key: string) => (draftId === null ? api.post<ShipmentDetail>("/v1/shipments", body, key) : api.put<ShipmentDetail>(`/v1/shipments/${draftId}`, body, key)),
    (file) => router.push(`/files/${file.id}`),
  );

  const filled = rows.filter((row) => row.customer !== null || row.amount.trim() !== "");
  const cents = (row: Row) => parseAmount(row.amount, "USD");
  const total = filled.reduce((sum, row) => sum + (cents(row) ?? 0), 0);
  const ready = code.trim() !== "" && filled.length > 0 && filled.every((row) => row.customer !== null && cents(row) !== null);
  const set = (key: number, change: Partial<Row>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save.save({
      code: code.trim().toUpperCase(),
      ...(arrivedOn === "" ? {} : { arrivedOn }),
      consignments: filled.map((row) => ({
        customerId: row.customer?.id,
        amountDueUsdCents: cents(row),
        ...(row.cartons.trim() === "" ? {} : { cartonsExpected: Number(row.cartons) }),
        ...(row.city.trim() === "" ? {} : { city: row.city.trim() }),
      })),
    });
  };

  if (draftId !== null && !loaded) return <Loading what="Opening the draft" />;

  return (
    <form onSubmit={submit} noValidate>
      <PageHead
        eyebrow="Files"
        title={draftId === null ? "Type a file in" : `Change ${code}`}
        hint="One row per customer, with the money to collect exactly as the file says. $0 means prepaid in China. It stays a draft and charges nobody until you confirm it."
      >
        <LinkButton tone="quiet" href={draftId === null ? "/files" : `/files/${draftId}`}>
          Cancel
        </LinkButton>
        <Button type="submit" tone="primary" busy={save.saving} disabled={!ready}>
          Save as a draft
        </Button>
      </PageHead>

      <Card className="mb-5 grid max-w-xl grid-cols-2 gap-4 p-5">
        <Field label="File code" hint="As on the file: GSSK6926" problem={save.fieldProblem("code") ?? (save.problem?.code === "file_code_taken" ? save.problem.message : undefined)}>
          {(id) => <Input id={id} className="num uppercase" autoFocus={draftId === null} value={code} onChange={(e) => setCode(e.target.value)} />}
        </Field>
        <Field label="Arrived on" hint="Optional" problem={save.fieldProblem("arrivedOn")}>
          {(id) => <Input id={id} type="date" value={arrivedOn} onChange={(e) => setArrivedOn(e.target.value)} />}
        </Field>
      </Card>

      <Card>
        <div className="grid grid-cols-[minmax(0,1fr)_150px_100px_150px_40px] items-center gap-3 border-b border-rule bg-sunken/60 px-5 py-2.5">
          <span className="eyebrow">Customer</span>
          <span className="eyebrow text-right">To collect, $</span>
          <span className="eyebrow text-right">Cartons</span>
          <span className="eyebrow">City</span>
          <span />
        </div>
        {rows.map((row, index) => {
          const amountProblem = row.amount.trim() !== "" && cents(row) === null ? "Not an amount" : save.fieldProblem(`consignments.${index}.amountDueUsdCents`);
          return (
            <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_150px_100px_150px_40px] items-start gap-3 border-b border-rule px-5 py-2.5">
              <CustomerPicker id={`customer-${row.key}`} value={row.customer} onChange={(customer) => set(row.key, { customer })} problem={save.fieldProblem(`consignments.${index}.customerId`)} />
              <Input aria-label="Amount to collect" className="num text-right" inputMode="decimal" placeholder="0.00" value={row.amount} onChange={(e) => set(row.key, { amount: e.target.value })} problem={amountProblem} title={amountProblem} />
              <Input aria-label="Cartons" className="num text-right" inputMode="numeric" value={row.cartons} onChange={(e) => set(row.key, { cartons: e.target.value.replace(/\D/g, "") })} />
              <Input aria-label="City" value={row.city} onChange={(e) => set(row.key, { city: e.target.value })} />
              <button
                type="button"
                aria-label="Remove this row"
                className="grid h-10 place-items-center rounded-md text-muted hover:bg-sunken hover:text-red"
                onClick={() => setRows((current) => (current.length === 1 ? [blank()] : current.filter((r) => r.key !== row.key)))}
              >
                <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
                  <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          );
        })}
        <div className="flex items-center justify-between px-5 py-3.5">
          <Button small onClick={() => setRows((current) => [...current, blank()])}>
            Add a row
          </Button>
          <p className="text-sm text-muted">
            {filled.length} {filled.length === 1 ? "customer" : "customers"} · to collect <Money amount={total} className="font-semibold text-ink" />
          </p>
        </div>
      </Card>
      <div className="mt-4 max-w-xl">
        <Problem of={save.problem} />
      </div>
    </form>
  );
}

export default function NewFilePage() {
  return (
    <Suspense>
      <FileForm />
    </Suspense>
  );
}
