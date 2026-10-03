"use client";

import type { Consignment, Dispute, ShipmentDetail } from "@green-star/contracts";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Card, CardHead, Chip, Dialog, Empty, Field, FormActions, Input, LinkButton, Loading, Money, PageHead, Problem, ReadProblem, Select, Stat, Table, Td, Textarea, Th } from "@/components/ui";
import { api } from "@/lib/api";
import { useCan, useGet, useSave } from "@/lib/hooks";
import { CONSIGNMENT, day, dayTime, DISPUTE, DISPUTE_KIND, SHIPMENT, TRUST } from "@/lib/labels";
import { amountForInput, formatMoney, parseAmount } from "@/lib/money";
import { blockers } from "../page";

type Doing = { kind: "confirm" } | { kind: "correct" | "cancel" | "dispute"; row: Consignment } | { kind: "answer"; dispute: Dispute } | null;

function Confirm({ file, onClose }: { file: ShipmentDetail; onClose: () => void }) {
  const confirm = useSave((_: null, key: string) => api.post<ShipmentDetail>(`/v1/shipments/${file.id}/confirm`, {}, key), onClose);
  const total = file.consignmentList.reduce((sum, row) => sum + row.amountDueUsdCents, 0);
  const charged = file.consignmentList.filter((row) => row.amountDueUsdCents > 0).length;
  return (
    <Dialog open onClose={onClose} title={`Confirm ${file.code}`}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void confirm.save(null);
        }}
      >
        <p className="text-sm">
          This charges <b>{charged}</b> {charged === 1 ? "customer" : "customers"} <b className="num">{formatMoney(total, "USD")}</b> in all, and the same amount becomes owed to the China office.
        </p>
        <p className="text-sm text-muted">After this the rows cannot be edited. A wrong amount is corrected, and a wrong row cancelled, each with a reason.</p>
        <Problem of={confirm.problem} />
        <FormActions onCancel={onClose} saving={confirm.saving} save="Confirm the file" />
      </form>
    </Dialog>
  );
}

function Correct({ row, onClose }: { row: Consignment; onClose: () => void }) {
  const [amount, setAmount] = useState(amountForInput(row.amountDueUsdCents, "USD"));
  const [reason, setReason] = useState("");
  const correct = useSave((body: unknown, key: string) => api.post(`/v1/consignments/${row.id}/correct`, body, key), onClose);
  const cents = parseAmount(amount, "USD");
  return (
    <Dialog open onClose={onClose} title={`Correct the amount for ${row.customerName}`} hint="The old charge is reversed and the right one posted. What he already paid stays on these goods.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void correct.save({ amountDueUsdCents: cents, reason });
        }}
      >
        <Field label="The right amount to collect, in dollars" hint={`It was ${formatMoney(row.amountDueUsdCents, "USD")}.`} problem={cents === null ? "That is not an amount" : correct.fieldProblem("amountDueUsdCents")}>
          {(id) => <Input id={id} className="num" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label="Why" problem={correct.fieldProblem("reason")}>
          {(id) => <Textarea id={id} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The file said 62, it was typed as 50" />}
        </Field>
        <Problem of={correct.problem} />
        <FormActions onCancel={onClose} saving={correct.saving} save="Correct it" disabled={cents === null || cents === row.amountDueUsdCents || reason.trim() === ""} />
      </form>
    </Dialog>
  );
}

function Cancel({ row, onClose }: { row: Consignment; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const cancel = useSave((body: unknown, key: string) => api.post(`/v1/consignments/${row.id}/cancel`, body, key), onClose);
  return (
    <Dialog open onClose={onClose} title={`Take ${row.customerName} off this file`} hint="His charge is reversed. Money he paid for these goods goes to his other unpaid files, or stays as credit.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void cancel.save({ reason });
        }}
      >
        <Field label="Why" problem={cancel.fieldProblem("reason")}>
          {(id) => <Textarea id={id} rows={2} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The goods belong to another customer" />}
        </Field>
        <Problem of={cancel.problem} />
        <FormActions onCancel={onClose} saving={cancel.saving} save="Take him off" danger disabled={reason.trim() === ""} />
      </form>
    </Dialog>
  );
}

function OpenDispute({ row, onClose }: { row: Consignment; onClose: () => void }) {
  const [kind, setKind] = useState("damaged");
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(true);
  const open = useSave((body: unknown, key: string) => api.post("/v1/disputes", body, key), onClose);
  return (
    <Dialog open onClose={onClose} title={`A problem with ${row.customerName}'s goods`} hint="The file stays open until China answers.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void open.save({ consignmentId: row.id, kind, sentToChina: sent, ...(note.trim() === "" ? {} : { note }) });
        }}
      >
        <Field label="What is wrong">
          {(id) => (
            <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="missing">Something is missing</option>
              <option value="damaged">Something is damaged</option>
              <option value="weight">The weight is wrong</option>
            </Select>
          )}
        </Field>
        <Field label="Note" hint="Optional">
          {(id) => <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Two cartons crushed at the corners" />}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-green" checked={sent} onChange={(e) => setSent(e.target.checked)} /> China has been told
        </label>
        <Problem of={open.problem} />
        <FormActions onCancel={onClose} saving={open.saving} save="Open the dispute" />
      </form>
    </Dialog>
  );
}

function Answer({ dispute, onClose }: { dispute: Dispute; onClose: () => void }) {
  const [answer, setAnswer] = useState(dispute.chinaAnswer ?? "");
  const [close, setClose] = useState(true);
  const save = useSave((body: unknown, key: string) => api.patch(`/v1/disputes/${dispute.id}`, body, key), onClose);
  return (
    <Dialog open onClose={onClose} title="What China said" hint={`${DISPUTE_KIND[dispute.kind]} · ${dispute.customerName}`}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save.save({ ...(answer.trim() === (dispute.chinaAnswer ?? "") ? {} : { chinaAnswer: answer }), ...(close ? { close: true } : {}) });
        }}
      >
        <Field label="China's answer" problem={save.fieldProblem("chinaAnswer")}>
          {(id) => <Textarea id={id} rows={3} autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="They will send two new cartons with the next file" />}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-green" checked={close} onChange={(e) => setClose(e.target.checked)} /> Nothing more to do: close the dispute
        </label>
        <Problem of={save.problem} />
        <FormActions onCancel={onClose} saving={save.saving} disabled={answer.trim() === ""} />
      </form>
    </Dialog>
  );
}

export default function FilePage() {
  const { id } = useParams<{ id: string }>();
  const canImport = useCan("import_files");
  const canFix = useCan("reverse");
  const [doing, setDoing] = useState<Doing>(null);
  const file = useGet<ShipmentDetail>(`/v1/shipments/${id}`);
  const markSent = useSave((dispute: Dispute, key: string) => api.patch(`/v1/disputes/${dispute.id}`, { sentToChina: true }, key));

  if (file.error) return <ReadProblem of={file.error} />;
  if (file.data === undefined) return <Loading what="Opening the file" />;
  const f = file.data;
  const draft = f.status === "draft";
  const stops = blockers(f);
  const draftTotal = f.consignmentList.reduce((sum, row) => sum + row.amountDueUsdCents, 0);

  return (
    <>
      <PageHead
        eyebrow="File"
        title={<span className="num">{f.code}</span>}
        hint={
          <span className="flex flex-wrap items-center gap-3">
            <Chip tone={SHIPMENT[f.status].tone}>{SHIPMENT[f.status].label}</Chip>
            {f.arrivedOn ? <span>Arrived {day(f.arrivedOn)}</span> : null}
            {f.confirmedAt ? <span>Confirmed {dayTime(f.confirmedAt)}</span> : null}
          </span>
        }
      >
        {draft && canImport ? (
          <>
            <LinkButton href={`/files/new?draft=${f.id}`}>Change the rows</LinkButton>
            <Button tone="primary" onClick={() => setDoing({ kind: "confirm" })}>
              Confirm the file
            </Button>
          </>
        ) : null}
      </PageHead>

      <Card className="mb-5 grid grid-cols-2 gap-6 p-5 md:grid-cols-4">
        <Stat label="To collect">{formatMoney(draft ? draftTotal : f.expectedUsdCents, "USD")}</Stat>
        <Stat label="Collected">{draft ? "–" : formatMoney(f.collectedUsdCents, "USD")}</Stat>
        <Stat label="Still out" tone={!draft && f.deliveredNotPaid > 0 ? "red" : undefined}>
          {draft ? "–" : formatMoney(f.remainingUsdCents, "USD")}
        </Stat>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="eyebrow">{f.status === "closed" ? "Closed" : "What stops it closing"}</span>
          {f.status === "closed" ? (
            <span className="text-sm text-muted">Everyone is paid or on account, the cash is counted in, and China has answered.</span>
          ) : (
            <ul className="text-sm">
              {stops.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card className="mb-5">
        <CardHead title="Customers on this file" hint={draft ? "A draft charges nobody. Check the rows against the file, then confirm." : undefined} />
        <Table>
          <thead>
            <tr>
              <Th>Customer</Th>
              <Th>City</Th>
              <Th right>Cartons</Th>
              <Th>Goods</Th>
              <Th right>To collect</Th>
              <Th right>Paid</Th>
              <Th right>Still owed</Th>
              {canFix && !draft ? <Th /> : null}
            </tr>
          </thead>
          <tbody>
            {f.consignmentList.map((row) => {
              const cartonsOff = row.cartonsExpected !== null && row.cartonsReceived !== null && row.cartonsExpected !== row.cartonsReceived;
              return (
                <tr key={row.id}>
                  <Td>
                    <Link href={`/customers/${row.customerId}`} className="font-semibold hover:text-green" dir="auto">
                      {row.customerName}
                    </Link>
                    <span className="ml-2 text-[12px] text-muted">{TRUST[row.trust].label.toLowerCase()}</span>
                  </Td>
                  <Td className="text-[13px] text-muted">{row.city}</Td>
                  <Td right className={`num text-[13px] ${cartonsOff ? "font-semibold text-amber-ink" : "text-muted"}`} >
                    {row.cartonsReceived !== null ? `${row.cartonsReceived} of ${row.cartonsExpected ?? "?"}` : (row.cartonsExpected ?? "")}
                  </Td>
                  <Td>{draft ? <span className="text-[13px] text-muted">Draft</span> : <Chip tone={CONSIGNMENT[row.status].tone}>{CONSIGNMENT[row.status].label}</Chip>}</Td>
                  <Td right>{row.amountDueUsdCents === 0 ? <span className="text-[13px] text-muted">prepaid</span> : <Money amount={row.amountDueUsdCents} />}</Td>
                  <Td right>{draft ? "" : <Money amount={row.paidUsdCents} tone="muted" />}</Td>
                  <Td right>{draft ? "" : <Money amount={row.remainingUsdCents} tone={row.status === "delivered_not_paid" ? "red" : row.remainingUsdCents === 0 ? "muted" : undefined} className="font-medium" />}</Td>
                  {canFix && !draft ? (
                    <Td right className="whitespace-nowrap">
                      <button type="button" className="text-[13px] font-semibold text-green hover:underline" onClick={() => setDoing({ kind: "dispute", row })}>
                        Problem
                      </button>
                      <button type="button" className="ml-3 text-[13px] font-semibold text-green hover:underline" onClick={() => setDoing({ kind: "correct", row })}>
                        Correct
                      </button>
                      <button type="button" className="ml-3 text-[13px] font-semibold text-red hover:underline" onClick={() => setDoing({ kind: "cancel", row })}>
                        Cancel
                      </button>
                    </Td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <Card>
        <CardHead title="Problems with the goods" hint="Sent to the China office and tracked until China answers." />
        {f.disputes.length === 0 ? (
          <Empty title="No problems reported" />
        ) : (
          <ul className="divide-y divide-rule">
            {f.disputes.map((d) => (
              <li key={d.id} className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
                <div className="min-w-0 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <b className="font-semibold">{DISPUTE_KIND[d.kind]}</b>
                    <span dir="auto">{d.customerName}</span>
                    <Chip tone={DISPUTE[d.status].tone}>{DISPUTE[d.status].label}</Chip>
                  </p>
                  {d.note ? <p className="mt-1 text-muted">{d.note}</p> : null}
                  {d.chinaAnswer ? <p className="mt-1">China: {d.chinaAnswer}</p> : null}
                  <p className="mt-1 text-[13px] text-faint">
                    Opened {dayTime(d.createdAt)}
                    {d.sentToChinaAt ? ` · sent ${dayTime(d.sentToChinaAt)}` : ""}
                    {d.answeredAt ? ` · answered ${dayTime(d.answeredAt)}` : ""}
                  </p>
                </div>
                {canFix && d.status !== "closed" ? (
                  <div className="flex gap-2">
                    {d.status === "open" ? (
                      <Button small busy={markSent.saving} onClick={() => void markSent.save(d)}>
                        China has been told
                      </Button>
                    ) : null}
                    <Button small onClick={() => setDoing({ kind: "answer", dispute: d })}>
                      {d.status === "answered" ? "Close it" : "Record China's answer"}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {doing?.kind === "confirm" ? <Confirm file={f} onClose={() => setDoing(null)} /> : null}
      {doing?.kind === "correct" ? <Correct row={doing.row} onClose={() => setDoing(null)} /> : null}
      {doing?.kind === "cancel" ? <Cancel row={doing.row} onClose={() => setDoing(null)} /> : null}
      {doing?.kind === "dispute" ? <OpenDispute row={doing.row} onClose={() => setDoing(null)} /> : null}
      {doing?.kind === "answer" ? <Answer dispute={doing.dispute} onClose={() => setDoing(null)} /> : null}
    </>
  );
}
