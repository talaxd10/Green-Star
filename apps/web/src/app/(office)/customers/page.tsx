"use client";

import type { CustomerDetail, CustomerSummary } from "@green-star/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { DriverAccountsCard } from "@/components/drivers";
import { Button, Card, Chip, Dialog, Empty, Field, FormActions, Input, LimitBar, Loading, Money, PageHead, Problem, ReadProblem, Segmented, Select, Table, Td, Th } from "@/components/ui";
import { api, withQuery } from "@/lib/api";
import { useDebounced, usePages, useSave } from "@/lib/hooks";
import { phone, TRUST } from "@/lib/labels";

type Show = "all" | "trusted" | "over_limit" | "owing";

const SHOW: { value: Show; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "owing", label: "Owing" },
  { value: "trusted", label: "Trusted" },
  { value: "over_limit", label: "Over limit" },
];

function NewCustomer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"person" | "agent_company">("person");
  const [phoneText, setPhoneText] = useState("");
  const [mark, setMark] = useState("");
  const create = useSave(
    (body: unknown, key: string) => api.post<CustomerDetail>("/v1/customers", body, key),
    (made) => router.push(`/customers/${made.id}`),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void create.save({
      name,
      kind,
      phones: phoneText.trim() === "" ? [] : [phoneText],
      // An agent company's mark changes on every file, so it is matched as a prefix.
      marks: mark.trim() === "" ? [] : [{ mark, match: kind === "agent_company" ? "prefix" : "exact" }],
    });
  };

  return (
    <Dialog open={open} onClose={onClose} title="New customer" hint="He starts as pay first. Trust is the China office's call, and is set on his page.">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Name" problem={create.fieldProblem("name")}>
          {(id) => <Input id={id} dir="auto" autoFocus value={name} onChange={(e) => setName(e.target.value)} problem={create.fieldProblem("name")} />}
        </Field>
        <Field label="Kind">
          {(id) => (
            <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="person">A person</option>
              <option value="agent_company">An agent company</option>
            </Select>
          )}
        </Field>
        <Field label="Phone" hint="Typed any way: 0770 123 4567" problem={create.fieldProblem("phones.0")}>
          {(id) => <Input id={id} inputMode="tel" value={phoneText} onChange={(e) => setPhoneText(e.target.value)} problem={create.fieldProblem("phones.0")} />}
        </Field>
        <Field
          label={kind === "agent_company" ? "Mark prefix" : "Shipping mark"}
          hint={kind === "agent_company" ? "YARO will match YARO MHAMAD and YARO OSMAN." : "As China writes it on the file."}
          problem={create.fieldProblem("marks.0.mark")}
        >
          {(id) => <Input id={id} className="num uppercase" value={mark} onChange={(e) => setMark(e.target.value)} problem={create.fieldProblem("marks.0.mark")} />}
        </Field>
        <Problem of={create.problem} />
        <FormActions onCancel={onClose} saving={create.saving} save="Add customer" disabled={name.trim() === ""} />
      </form>
    </Dialog>
  );
}

export default function CustomersPage() {
  const [text, setText] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [adding, setAdding] = useState(false);
  const q = useDebounced(text.trim());

  const list = usePages<CustomerSummary>(
    withQuery("/v1/customers", {
      q,
      trust: show === "trusted" ? "trusted" : undefined,
      filter: show === "over_limit" || show === "owing" ? show : undefined,
    }),
  );

  return (
    <>
      <PageHead title="Customers" hint="Everyone who ships with Green Star. Search by phone, shipping mark or any part of a name.">
        <Button tone="primary" onClick={() => setAdding(true)}>
          New customer
        </Button>
      </PageHead>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input className="max-w-sm" type="search" placeholder="Phone, mark or name" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search customers" />
        <Segmented label="Which customers" value={show} onChange={setShow} options={SHOW} />
      </div>

      {show === "trusted" ? <DriverAccountsCard /> : null}

      <Card>
        {list.error ? (
          <ReadProblem of={list.error} />
        ) : list.loading ? (
          <Loading what="Finding customers" />
        ) : list.items.length === 0 ? (
          <Empty title={q === "" && show === "all" ? "No customers yet" : "Nobody matches"}>
            {q === "" && show === "all" ? "Add the first one, or they will be added as files are imported." : "Try a phone number, a mark, or fewer letters of the name."}
          </Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th>Phone</Th>
                <Th>Marks</Th>
                <Th>Trust</Th>
                <Th right>Unpaid files</Th>
                <Th right>Owes</Th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((c) => (
                <tr key={c.id} className="group hover:bg-sunken/50">
                  <Td>
                    <Link href={`/customers/${c.id}`} className="font-semibold text-ink group-hover:text-green" dir="auto">
                      {c.name}
                    </Link>
                    {c.kind === "agent_company" ? <span className="ml-2 text-[12px] text-muted">agent company</span> : null}
                  </Td>
                  <Td className="num text-[13px] text-muted">{phone(c.phone)}</Td>
                  <Td className="num text-[13px] text-muted">{c.marks.slice(0, 3).join(", ")}</Td>
                  <Td>
                    <div className="flex items-center gap-3">
                      <Chip tone={TRUST[c.trust].tone}>{TRUST[c.trust].label}</Chip>
                      {c.creditLimitUsdCents !== null ? <LimitBar balance={c.balanceUsdCents} limit={c.creditLimitUsdCents} /> : null}
                    </div>
                  </Td>
                  <Td right className="num text-muted">
                    {c.unpaidConsignments === 0 ? "" : c.unpaidConsignments}
                  </Td>
                  <Td right>
                    {c.balanceUsdCents < 0 ? (
                      <span className="text-[13px] text-muted">
                        credit <Money amount={-c.balanceUsdCents} tone="green" />
                      </span>
                    ) : (
                      <Money amount={c.balanceUsdCents} tone={c.overLimit ? "red" : c.balanceUsdCents === 0 ? "muted" : undefined} className="font-medium" />
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {list.hasMore ? (
          <div className="flex justify-center border-t border-rule p-3">
            <Button small tone="quiet" onClick={list.more} busy={list.loadingMore}>
              Show more
            </Button>
          </div>
        ) : null}
      </Card>

      <NewCustomer open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
