"use client";

import type { Consignment, CustomerDetail, CustomerSummary, Page, Payment } from "@green-star/contracts";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { CustomerPicker } from "@/components/customer-picker";
import {
  Button,
  Card,
  CardHead,
  Chip,
  Dialog,
  Empty,
  Field,
  FormActions,
  Input,
  LimitBar,
  LinkButton,
  Loading,
  Money,
  PageHead,
  Problem,
  ReadProblem,
  Select,
  Stat,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useGet, useSave } from "@/lib/hooks";
import { CONSIGNMENT, day, dayTime, METHOD, phone, TRUST } from "@/lib/labels";
import { amountForInput, formatMoney, parseAmount } from "@/lib/money";

function ChangeTrust({ customer, open, onClose }: { customer: CustomerDetail; open: boolean; onClose: () => void }) {
  const [trust, setTrust] = useState(customer.trust);
  const [limit, setLimit] = useState(customer.creditLimitUsdCents === null ? "" : amountForInput(customer.creditLimitUsdCents, "USD"));
  const [askedBy, setAskedBy] = useState("China office");
  const [note, setNote] = useState("");
  const change = useSave((body: unknown, key: string) => api.patch<CustomerDetail>(`/v1/customers/${customer.id}`, body, key), onClose);

  const cents = limit.trim() === "" ? null : parseAmount(limit, "USD");
  const badLimit = limit.trim() !== "" && cents === null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void change.save({ trust: { trust, creditLimitUsdCents: trust === "trusted" ? cents : null, askedBy, ...(note.trim() === "" ? {} : { note }) } });
  };

  return (
    <Dialog open={open} onClose={onClose} title="Trust and limit" hint="The China office decides this. The change is kept with who asked for it.">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="This customer">
          {(id) => (
            <Select id={id} value={trust} onChange={(e) => setTrust(e.target.value as typeof trust)}>
              <option value="pay_first">Pays first: full amount or no goods</option>
              <option value="trusted">Is trusted: goods go on his account</option>
            </Select>
          )}
        </Field>
        {trust === "trusted" ? (
          <Field label="His limit, in dollars" hint="Leave empty for no limit. Above it, he shows as over limit." problem={badLimit ? "That is not an amount" : change.fieldProblem("trust.creditLimitUsdCents")}>
            {(id) => <Input id={id} className="num" inputMode="decimal" placeholder="5,000.00" value={limit} onChange={(e) => setLimit(e.target.value)} problem={badLimit ? "bad" : undefined} />}
          </Field>
        ) : null}
        <Field label="Who asked for this" problem={change.fieldProblem("trust.askedBy")}>
          {(id) => <Input id={id} value={askedBy} onChange={(e) => setAskedBy(e.target.value)} problem={change.fieldProblem("trust.askedBy")} />}
        </Field>
        <Field label="Note" hint="Optional">
          {(id) => <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <Problem of={change.problem} />
        <FormActions onCancel={onClose} saving={change.saving} disabled={badLimit || askedBy.trim() === ""} />
      </form>
    </Dialog>
  );
}

function Details({ customer, open, onClose }: { customer: CustomerDetail; open: boolean; onClose: () => void }) {
  const [name, setName] = useState(customer.name);
  const [kind, setKind] = useState(customer.kind);
  const [phoneText, setPhoneText] = useState("");
  const [mark, setMark] = useState("");
  const [prefix, setPrefix] = useState(customer.kind === "agent_company");

  const rename = useSave((body: unknown, key: string) => api.patch<CustomerDetail>(`/v1/customers/${customer.id}`, body, key));
  const addPhone = useSave((body: unknown, key: string) => api.post<CustomerDetail>(`/v1/customers/${customer.id}/phones`, body, key), () => setPhoneText(""));
  const addMark = useSave((body: unknown, key: string) => api.post<CustomerDetail>(`/v1/customers/${customer.id}/marks`, body, key), () => setMark(""));
  const remove = useSave((url: string, key: string) => api.del<CustomerDetail>(url, key));

  return (
    <Dialog open={open} onClose={onClose} title="Name, phones and marks" hint="A file's row is matched by phone first, then by mark.">
      <div className="flex flex-col gap-6">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void rename.save({ name, kind });
          }}
        >
          <div className="grid grid-cols-[1fr_180px] gap-3">
            <Field label="Name" problem={rename.fieldProblem("name")}>
              {(id) => <Input id={id} dir="auto" value={name} onChange={(e) => setName(e.target.value)} problem={rename.fieldProblem("name")} />}
            </Field>
            <Field label="Kind">
              {(id) => (
                <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                  <option value="person">A person</option>
                  <option value="agent_company">An agent company</option>
                </Select>
              )}
            </Field>
          </div>
          <Problem of={rename.problem} />
          <div>
            <Button type="submit" small busy={rename.saving} disabled={name.trim() === "" || (name === customer.name && kind === customer.kind)}>
              Save name
            </Button>
          </div>
        </form>

        <section className="flex flex-col gap-2">
          <h3 className="eyebrow">Phones</h3>
          <ul className="flex flex-col divide-y divide-rule rounded-md border border-rule">
            {customer.phoneList.length === 0 ? <li className="px-3 py-2 text-sm text-muted">No phone yet.</li> : null}
            {customer.phoneList.map((p) => (
              <li key={p.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="num">
                  {phone(p.phone)} {p.primary ? <span className="ml-2 text-[11px] text-muted">main</span> : null}
                </span>
                <button type="button" className="text-[13px] text-red hover:underline" onClick={() => void remove.save(`/v1/customers/${customer.id}/phones/${p.id}`)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <form
            className="flex items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void addPhone.save({ phone: phoneText, primary: customer.phoneList.length === 0 });
            }}
          >
            <Input aria-label="New phone" inputMode="tel" placeholder="0770 123 4567" value={phoneText} onChange={(e) => setPhoneText(e.target.value)} problem={addPhone.problem ? "bad" : undefined} />
            <Button type="submit" busy={addPhone.saving} disabled={phoneText.trim() === ""}>
              Add
            </Button>
          </form>
          <Problem of={addPhone.problem} />
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="eyebrow">Shipping marks</h3>
          <ul className="flex flex-col divide-y divide-rule rounded-md border border-rule">
            {customer.markList.length === 0 ? <li className="px-3 py-2 text-sm text-muted">No mark yet.</li> : null}
            {customer.markList.map((m) => (
              <li key={m.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="num">
                  {m.mark} {m.match === "prefix" ? <span className="ml-2 text-[11px] text-muted">prefix</span> : null}
                </span>
                <button type="button" className="text-[13px] text-red hover:underline" onClick={() => void remove.save(`/v1/customers/${customer.id}/marks/${m.id}`)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <form
            className="flex items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void addMark.save({ mark, match: prefix ? "prefix" : "exact" });
            }}
          >
            <Input aria-label="New mark" className="num uppercase" placeholder="As China writes it" value={mark} onChange={(e) => setMark(e.target.value)} problem={addMark.problem ? "bad" : undefined} />
            <label className="flex h-10 shrink-0 items-center gap-2 text-[13px] text-muted">
              <input type="checkbox" checked={prefix} onChange={(e) => setPrefix(e.target.checked)} className="size-4 accent-green" /> prefix
            </label>
            <Button type="submit" busy={addMark.saving} disabled={mark.trim() === ""}>
              Add
            </Button>
          </form>
          <Problem of={addMark.problem ?? remove.problem} />
        </section>
      </div>
    </Dialog>
  );
}

function Merge({ customer, open, onClose }: { customer: CustomerDetail; open: boolean; onClose: () => void }) {
  const [duplicate, setDuplicate] = useState<CustomerSummary | null>(null);
  const merge = useSave((body: unknown, key: string) => api.post<CustomerDetail>(`/v1/customers/${customer.id}/merge`, body, key), onClose);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Merge a duplicate into this customer"
      hint={`The duplicate's phones, marks and names move to ${customer.name}. It works while the duplicate has nothing on the books yet.`}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (duplicate !== null) void merge.save({ duplicateId: duplicate.id });
        }}
      >
        <Field label="The duplicate">{(id) => <CustomerPicker id={id} value={duplicate} onChange={setDuplicate} autoFocus />}</Field>
        <Problem of={merge.problem} />
        <FormActions onCancel={onClose} saving={merge.saving} save="Merge" disabled={duplicate === null || duplicate.id === customer.id} />
      </form>
    </Dialog>
  );
}

export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [dialog, setDialog] = useState<"trust" | "details" | "merge" | null>(null);

  const customer = useGet<CustomerDetail>(`/v1/customers/${id}`);
  const consignments = useGet<{ items: Consignment[] }>(`/v1/consignments?customerId=${id}`);
  const payments = useGet<Page<Payment>>(`/v1/payments?customerId=${id}&limit=20`);

  if (customer.error) {
    // A duplicate that was merged away sends the reader to where it went.
    const mergedInto = customer.error.code === "customer_merged" ? customer.error.fields.mergedInto : undefined;
    if (mergedInto) router.replace(`/customers/${mergedInto}`);
    return <ReadProblem of={customer.error} />;
  }
  if (customer.data === undefined) return <Loading what="Opening the customer" />;
  const c = customer.data;
  const open = (consignments.data?.items ?? []).filter((row) => row.remainingUsdCents > 0);
  const done = (consignments.data?.items ?? []).filter((row) => row.remainingUsdCents === 0);

  return (
    <>
      <PageHead
        eyebrow="Customer"
        title={c.name}
        hint={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Chip tone={TRUST[c.trust].tone}>{TRUST[c.trust].label}</Chip>
            {c.kind === "agent_company" ? <span>Agent company</span> : null}
            <span className="num">{c.phones.map(phone).join(" · ") || "no phone"}</span>
            {c.marks.length > 0 ? <span className="num">{c.marks.join(" · ")}</span> : null}
          </span>
        }
      >
        <LinkButton href={`/customers/${c.id}/statement`}>Statement</LinkButton>
        <>
          <Button tone="quiet" onClick={() => setDialog("merge")}>
            Merge a duplicate
          </Button>
          <Button onClick={() => setDialog("details")}>Name, phones, marks</Button>
          <Button onClick={() => setDialog("trust")}>Trust and limit</Button>
          <LinkButton tone="primary" href={`/money?customer=${c.id}`}>
            Take a payment
          </LinkButton>
        </>
      </PageHead>

      <Card className="mb-5 grid grid-cols-2 gap-6 p-5 md:grid-cols-4">
        {c.balanceUsdCents < 0 ? (
          <Stat label="Credit" tone="green" hint="Paid more than he owes. It pays toward his next file.">
            {formatMoney(-c.balanceUsdCents, "USD")}
          </Stat>
        ) : (
          <Stat label="Owes now" tone={c.overLimit ? "red" : undefined} hint={c.overLimit ? "Over his limit" : undefined}>
            {formatMoney(c.balanceUsdCents, "USD")}
          </Stat>
        )}
        <Stat label="His limit">
          {c.trust === "pay_first" ? <span className="text-base font-normal text-muted">Pays first</span> : c.creditLimitUsdCents === null ? <span className="text-base font-normal text-muted">No limit</span> : formatMoney(c.creditLimitUsdCents, "USD")}
        </Stat>
        <Stat label="Unpaid files">{c.unpaidConsignments}</Stat>
        <div className="flex flex-col justify-center">{c.creditLimitUsdCents !== null ? <LimitBar balance={c.balanceUsdCents} limit={c.creditLimitUsdCents} /> : null}</div>
      </Card>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-5">
          <Card>
            <CardHead title="Owes on" hint="Oldest first: the order his payments are applied in." />
            {consignments.data === undefined ? (
              <Loading />
            ) : open.length === 0 ? (
              <Empty title="Nothing owed" />
            ) : (
              <ConsignmentTable rows={open} />
            )}
          </Card>
          {done.length > 0 ? (
            <Card>
              <CardHead title="Paid in full" />
              <ConsignmentTable rows={done} />
            </Card>
          ) : null}
        </div>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHead title="Payments" />
            {payments.data === undefined ? (
              <Loading />
            ) : payments.data.items.length === 0 ? (
              <Empty title="No payments yet" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>How</Th>
                    <Th right>Received</Th>
                    <Th right>On his account</Th>
                  </tr>
                </thead>
                <tbody>
                  {payments.data.items.map((p) => (
                    <tr key={p.entryId} className={p.reversed ? "text-faint line-through" : undefined}>
                      <Td className="whitespace-nowrap text-[13px] text-muted">{dayTime(p.happenedAt)}</Td>
                      <Td className="text-[13px]">{METHOD[p.method]}</Td>
                      <Td right>
                        <Money amount={p.receivedAmount} currency={p.receivedCurrency} />
                      </Td>
                      <Td right>
                        <Money amount={p.creditedUsdCents} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHead title="Trust history" />
            {c.trustChanges.length === 0 ? (
              <Empty title="Never changed">He has been pay first since he was added.</Empty>
            ) : (
              <ul className="divide-y divide-rule">
                {c.trustChanges.map((t, index) => (
                  <li key={index} className="px-5 py-3 text-sm">
                    <p>
                      <b className="font-semibold">{TRUST[t.trustAfter].label}</b>
                      {t.limitAfterUsdCents !== null ? <>, limit <Money amount={t.limitAfterUsdCents} /></> : null}
                      <span className="text-muted"> · asked by {t.askedBy}</span>
                    </p>
                    <p className="text-[13px] text-muted">
                      {dayTime(t.changedAt)} by {t.changedBy}
                      {t.note ? ` · ${t.note}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {c.aliases.length > 0 ? (
            <Card>
              <CardHead title="Names as files wrote them" />
              <p className="px-5 py-4 text-sm" dir="auto">
                {c.aliases.join(" · ")}
              </p>
            </Card>
          ) : null}
        </div>
      </div>

      {dialog === "trust" ? <ChangeTrust customer={c} open onClose={() => setDialog(null)} /> : null}
      {dialog === "details" ? <Details customer={c} open onClose={() => setDialog(null)} /> : null}
      {dialog === "merge" ? <Merge customer={c} open onClose={() => setDialog(null)} /> : null}
    </>
  );
}

function ConsignmentTable({ rows }: { rows: Consignment[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>File</Th>
          <Th>Confirmed</Th>
          <Th>Goods</Th>
          <Th right>Amount</Th>
          <Th right>Paid</Th>
          <Th right>Still owed</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <Td>
              <Link href={`/files/${row.shipmentId}`} className="num font-medium hover:text-green">
                {row.shipmentCode}
              </Link>
            </Td>
            <Td className="whitespace-nowrap text-[13px] text-muted">{day(row.confirmedAt)}</Td>
            <Td>
              <Chip tone={CONSIGNMENT[row.status].tone}>{CONSIGNMENT[row.status].label}</Chip>
            </Td>
            <Td right>{row.amountDueUsdCents === 0 ? <span className="text-[13px] text-muted">prepaid</span> : <Money amount={row.amountDueUsdCents} />}</Td>
            <Td right>
              <Money amount={row.paidUsdCents} tone="muted" />
            </Td>
            <Td right>
              <Money amount={row.remainingUsdCents} tone={row.status === "delivered_not_paid" ? "red" : row.remainingUsdCents === 0 ? "muted" : undefined} className="font-medium" />
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
