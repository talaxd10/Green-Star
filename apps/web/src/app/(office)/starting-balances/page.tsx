"use client";

// Starting balances: what stood on the day San started using the system.
// Each one is typed once; typing it again replaces it, and 0 clears it.

import type { CustomerStart, CustomerSummary, OfficeStart, StartingBalances } from "@green-star/contracts";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { CustomerPicker } from "@/components/customer-picker";
import { useToast } from "@/components/toast";
import { Button, Card, CardHead, Empty, Field, Input, Loading, Money, PageHead, Problem, Segmented, Table, Td, Th } from "@/components/ui";
import { api } from "@/lib/api";
import { useGet, useSave } from "@/lib/hooks";
import { dayTime } from "@/lib/labels";
import { amountForInput, formatMoney, parseAmount } from "@/lib/money";

const OFFICE: { what: OfficeStart; label: string; hint: string; currency: "USD" | "IQD" }[] = [
  { what: "vault_usd", label: "Vault, dollars", hint: "The dollars in the vault now.", currency: "USD" },
  { what: "vault_iqd", label: "Vault, dinars", hint: "The dinars in the vault now.", currency: "IQD" },
  { what: "china", label: "Owed to China", hint: "What Green Star owes the China office now, in dollars.", currency: "USD" },
];

function officeValue(data: StartingBalances, what: OfficeStart): number | null {
  return what === "vault_usd" ? data.vaultUsdCents : what === "vault_iqd" ? data.vaultIqd : data.chinaUsdCents;
}

function Office({ data }: { data: StartingBalances }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Partial<Record<OfficeStart, string>>>({});
  // One id per balance for this form: saving twice is one change.
  const newIds = () => ({ vault_usd: crypto.randomUUID(), vault_iqd: crypto.randomUUID(), china: crypto.randomUUID() });
  const [ids, setIds] = useState(newIds);
  const save = useSave(
    async (body: { what: OfficeStart; amount: number }[], key: string) => {
      let last: StartingBalances | null = null;
      for (const one of body) {
        last = await api.put<StartingBalances>("/v1/starting-balances/office", { id: ids[one.what], ...one }, `${key}:${one.what}`);
      }
      return last;
    },
    () => {
      toast("Starting balances saved");
      setDraft({});
      setIds(newIds());
    },
  );
  const rows = OFFICE.map((o) => {
    const saved = officeValue(data, o.what);
    const typed = draft[o.what] ?? (saved === null ? "" : amountForInput(saved, o.currency));
    const amount = typed.trim() === "" ? 0 : parseAmount(typed, o.currency);
    return { ...o, saved, typed, amount, changed: amount !== null && amount !== (saved ?? 0) };
  });
  const valid = rows.every((r) => r.amount !== null);
  const changes = rows.filter((r) => r.changed).map((r) => ({ what: r.what, amount: r.amount as number }));

  return (
    <Card>
      <CardHead title="The office" hint="The vault's cash and what is owed to China, on the day you start." />
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void save.save(changes);
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {rows.map((r) => (
            <Field key={r.what} label={r.label} hint={r.hint} problem={r.amount === null ? (r.currency === "IQD" ? "Dinars are whole numbers" : "That is not an amount") : undefined}>
              {(id) => <Input id={id} className="num" inputMode="decimal" placeholder="0" value={r.typed} onChange={(e) => setDraft({ ...draft, [r.what]: e.target.value })} />}
            </Field>
          ))}
        </div>
        <Problem of={save.problem} />
        <div>
          <Button type="submit" busy={save.saving} disabled={!valid || changes.length === 0}>
            Save the office's starting balances
          </Button>
        </div>
      </form>
    </Card>
  );
}

function CustomerForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  // One id for this form: saving twice is one change.
  const [id] = useState(() => crypto.randomUUID());
  const [customer, setCustomer] = useState<CustomerSummary | null>(null);
  const [way, setWay] = useState<"owes" | "credit">("owes");
  const [typed, setTyped] = useState("");
  const amount = parseAmount(typed, "USD");
  const save = useSave(
    (body: { customerId: string; usdCents: number }, key: string) =>
      api.put<StartingBalances>(`/v1/starting-balances/customers/${body.customerId}`, { id, usdCents: body.usdCents }, key),
    () => {
      toast(customer === null ? "Starting balance saved" : `Starting balance saved for ${customer.name}`);
      onDone();
    },
  );
  const ready = customer !== null && amount !== null;

  return (
    <form
      className="flex flex-col gap-4 border-b border-rule p-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!ready) return;
        void save.save({ customerId: customer.id, usdCents: way === "owes" ? amount : -amount });
      }}
    >
      <Field label="Customer">{(id) => <CustomerPicker id={id} value={customer} onChange={setCustomer} />}</Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="On the day you start" hint="0 clears it.">
          {() => <Segmented label="On the day you start" value={way} onChange={setWay} options={[{ value: "owes", label: "He owes" }, { value: "credit", label: "He has credit" }]} />}
        </Field>
        <Field label="Amount, in dollars" problem={typed.trim() !== "" && amount === null ? "That is not an amount" : undefined}>
          {(id) => <Input id={id} className="num" inputMode="decimal" placeholder="0.00" value={typed} onChange={(e) => setTyped(e.target.value)} />}
        </Field>
      </div>
      <Problem of={save.problem} />
      <div>
        <Button type="submit" busy={save.saving} disabled={!ready}>
          Save his starting balance
        </Button>
      </div>
    </form>
  );
}

function Customers({ data }: { data: StartingBalances }) {
  const [round, setRound] = useState(0);
  const total = data.customers.reduce((sum, c) => sum + c.usdCents, 0);
  return (
    <Card>
      <CardHead
        title="Customers"
        hint={
          <>
            What each customer owed, or the credit he had, on the day you start. What he owed is paid first, before any file.
            {data.customers.length > 0 ? (
              <>
                {" "}
                {data.customers.length} so far, <span className="num">{formatMoney(total, "USD")}</span> in all.
              </>
            ) : null}
          </>
        }
      />
      <CustomerForm key={round} onDone={() => setRound(round + 1)} />
      {data.customers.length === 0 ? (
        <Empty title="No customer has a starting balance yet" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Customer</Th>
              <Th right>Starting balance</Th>
              <Th right>Owes now</Th>
              <Th>Typed in</Th>
            </tr>
          </thead>
          <tbody>
            {data.customers.map((c: CustomerStart) => (
              <tr key={c.customerId}>
                <Td>
                  <Link className="font-semibold hover:underline" href={`/customers/${c.customerId}`} dir="auto">
                    {c.customerName}
                  </Link>
                </Td>
                <Td right>
                  {c.usdCents < 0 ? (
                    <span>
                      credit <Money amount={-c.usdCents} tone="green" />
                    </span>
                  ) : (
                    <Money amount={c.usdCents} />
                  )}
                </Td>
                <Td right>
                  <Money amount={c.balanceUsdCents} tone={c.balanceUsdCents > 0 ? "red" : "muted"} />
                </Td>
                <Td className="text-muted">{dayTime(c.setAt)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

export default function StartingBalancesPage() {
  const data = useGet<StartingBalances>("/v1/starting-balances");
  return (
    <>
      <PageHead
        title="Starting balances"
        hint="What stood on the day you start using the system: the vault, China, and what each customer owed. Type each one once. Typing it again replaces it."
      />
      {data.data === undefined ? (
        <Loading />
      ) : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <div className="flex flex-col gap-5">
            <Office data={data.data} />
          </div>
          <div className="flex flex-col gap-5">
            <Customers data={data.data} />
          </div>
        </div>
      )}
    </>
  );
}
