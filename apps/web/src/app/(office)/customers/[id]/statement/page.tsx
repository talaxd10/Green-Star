"use client";

import type { Statement, StatementLine, StatementRecord } from "@green-star/contracts";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/toast";
import { Button, Card, CardHead, Chip, Dialog, Empty, Field, Input, LinkButton, Loading, Money, PageHead, Problem, ReadProblem, Stat, Table, Td, Th } from "@/components/ui";
import { api, withQuery } from "@/lib/api";
import { useCan, useGet, useSave } from "@/lib/hooks";
import { CONSIGNMENT, day, dayTime, METHOD, phone, TRUST } from "@/lib/labels";
import { formatMoney, formatRatePerDollar } from "@/lib/money";

/** What a line was, in a few words. */
function what(line: StatementLine): string {
  const text = line.kind === "charge" ? `File ${line.shipmentCode ?? ""}`.trim() : line.method === null ? "Payment" : METHOD[line.method];
  return line.isReversal ? `${text}, taken back` : text;
}

/** The copy to send: the image, the PDF, the text, and "I sent it". */
function Copy({ record, canSend, onClose }: { record: StatementRecord; canSend: boolean; onClose: () => void }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const sent = useSave(
    (_: null, key: string) => api.post<StatementRecord>(`/v1/statements/${record.id}/sent`, {}, key),
    () => {
      toast("Marked as sent");
      onClose();
    },
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(record.text);
      setCopied(true);
    } catch {
      toast("Could not copy. Select the text and copy it by hand.", "problem");
    }
  };
  const name = `green-star-statement-${record.asOf.slice(0, 10)}`;

  return (
    <Dialog open onClose={onClose} wide title={`Statement for ${record.customerName}`} hint={`As of ${dayTime(record.asOf)}. Send the image or the PDF with the text below, from your own phone.`}>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        <div className="self-start overflow-hidden rounded-lg border border-rule bg-sunken">
          {/* Drawn by the API from the copy that was kept, so it is exactly what the PDF and the text say. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={record.imageUrl} alt={`Statement for ${record.customerName}`} className="block w-full" />
        </div>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <a href={record.imageUrl} download={`${name}.png`} className="inline-flex h-10 items-center rounded-md border border-rule-strong bg-surface px-4 text-sm font-semibold hover:border-ink">
              Download the image
            </a>
            <a href={record.pdfUrl} download={`${name}.pdf`} className="inline-flex h-10 items-center rounded-md border border-rule-strong bg-surface px-4 text-sm font-semibold hover:border-ink">
              Download the PDF
            </a>
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[13px] font-semibold">Text to paste into the message</span>
              <Button small tone="quiet" onClick={copy}>
                {copied ? "Copied" : "Copy the text"}
              </Button>
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-rule bg-sunken px-3 py-2.5 font-sans text-[13px] leading-relaxed" dir="auto" aria-label="Statement text">
              {record.text}
            </pre>
          </div>
          <Problem of={sent.problem} />
          <div className="mt-auto flex flex-wrap items-center justify-end gap-2">
            {record.sentAt !== null ? (
              <span className="mr-auto text-[13px] text-muted">
                Sent {dayTime(record.sentAt)} by {record.sentByName}
              </span>
            ) : null}
            <Button tone="quiet" onClick={onClose}>
              Close
            </Button>
            {canSend && record.sentAt === null ? (
              <Button tone="primary" busy={sent.saving} onClick={() => void sent.save(null)}>
                I sent it
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

export default function StatementPage() {
  const { id } = useParams<{ id: string }>();
  const canMake = useCan("enter_money");
  const [from, setFrom] = useState("");
  const [corrections, setCorrections] = useState(false);
  const [showing, setShowing] = useState<StatementRecord | null>(null);
  // One id per copy: a second click while the first is on its way makes the same copy.
  const [copyId, setCopyId] = useState(() => crypto.randomUUID());

  const validFrom = /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : undefined;
  const statement = useGet<Statement>(withQuery(`/v1/customers/${id}/statement`, { from: validFrom, corrections: corrections ? "true" : undefined }));
  const copies = useGet<{ items: StatementRecord[] }>(`/v1/customers/${id}/statements`);
  const make = useSave(
    (_: null, key: string) => api.post<StatementRecord>(`/v1/customers/${id}/statement/export`, { id: copyId, ...(validFrom === undefined ? {} : { from: validFrom }) }, key),
    (record) => {
      setCopyId(crypto.randomUUID());
      setShowing(record);
    },
  );

  if (statement.error) return <ReadProblem of={statement.error} />;
  if (statement.data === undefined) return <Loading what="Opening the statement" />;
  const s = statement.data;

  return (
    <>
      <PageHead
        eyebrow="Statement"
        title={s.customerName}
        hint={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Chip tone={TRUST[s.trust].tone}>{TRUST[s.trust].label}</Chip>
            {s.phone ? <span className="num">{phone(s.phone)}</span> : null}
            <span>Every charge and payment on his account, each with the balance after it.</span>
          </span>
        }
      >
        <LinkButton href={`/customers/${id}`}>His page</LinkButton>
        {canMake ? (
          <Button tone="primary" busy={make.saving} onClick={() => void make.save(null)}>
            Make a statement to send
          </Button>
        ) : null}
      </PageHead>
      <div className="mb-4">
        <Problem of={make.problem} />
      </div>

      <Card className="mb-5 grid grid-cols-2 gap-6 p-5 md:grid-cols-4">
        {s.balanceUsdCents < 0 ? (
          <Stat label="In credit" tone="green">
            {formatMoney(-s.balanceUsdCents, "USD")}
          </Stat>
        ) : (
          <Stat label="He owes" tone={s.balanceUsdCents > 0 ? "amber" : "green"}>
            {formatMoney(s.balanceUsdCents, "USD")}
          </Stat>
        )}
        <Stat label="Charged" hint="In the lines below">
          {formatMoney(s.chargedUsdCents, "USD")}
        </Stat>
        <Stat label="Paid" hint="In the lines below">
          {formatMoney(s.paidUsdCents, "USD")}
        </Stat>
        <Stat label="Last payment" hint={s.lastPayment === null ? undefined : day(s.lastPayment.day)}>
          {s.lastPayment === null ? "None yet" : formatMoney(s.lastPayment.amountUsdCents, "USD")}
        </Stat>
      </Card>

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]">
        <Card>
          <CardHead
            title="His account"
            hint="Oldest first. A payment that was taken back is left off, with what took it back."
            action={
              <div className="flex flex-wrap items-end gap-4">
                <Field label="From">{(inputId) => <Input id={inputId} type="date" className="num h-8 w-40 text-[13px]" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
                <label className="flex h-8 items-center gap-2 text-[13px]">
                  <input type="checkbox" className="size-4 accent-green" checked={corrections} onChange={(e) => setCorrections(e.target.checked)} />
                  Show corrections
                </label>
              </div>
            }
          />
          {s.lines.length === 0 && s.openingBalanceUsdCents === 0 ? (
            <Empty title="Nothing on his account yet">A charge appears when a file with his goods is confirmed, and a payment when he pays.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>What</Th>
                  <Th right>Charged</Th>
                  <Th right>Paid</Th>
                  <Th right>Balance</Th>
                </tr>
              </thead>
              <tbody>
                {s.from !== null || s.openingBalanceUsdCents !== 0 ? (
                  <tr className="text-muted">
                    <Td />
                    <Td className="italic">Balance before {s.from === null ? "" : day(s.from)}</Td>
                    <Td />
                    <Td />
                    <Td right>
                      <Money amount={s.openingBalanceUsdCents} />
                    </Td>
                  </tr>
                ) : null}
                {s.lines.map((line) => (
                  <tr key={`${line.entryId}`} className={line.isCorrection ? "text-faint" : undefined}>
                    <Td className="whitespace-nowrap text-[13px] text-muted">{day(line.day)}</Td>
                    <Td>
                      {line.kind === "charge" && line.shipmentId !== null ? (
                        <Link href={`/files/${line.shipmentId}`} className="font-semibold hover:text-green">
                          {what(line)}
                        </Link>
                      ) : line.roundId !== null ? (
                        <Link href={`/rounds/${line.roundId}`} className="font-semibold hover:text-green">
                          {what(line)}
                        </Link>
                      ) : (
                        <span className="font-semibold">{what(line)}</span>
                      )}
                      {line.receivedCurrency === "IQD" && line.receivedAmount !== null && line.iqdPer100Usd !== null ? (
                        <span className="num block text-[12px] text-muted">
                          {formatMoney(line.receivedAmount, "IQD")} at {formatRatePerDollar(line.iqdPer100Usd)}
                        </span>
                      ) : null}
                      {line.note ? (
                        <span className="block text-[12px] text-muted" dir="auto">
                          {line.note}
                        </span>
                      ) : null}
                    </Td>
                    <Td right>{line.changeUsdCents > 0 ? <Money amount={line.changeUsdCents} /> : null}</Td>
                    <Td right>{line.changeUsdCents < 0 ? <Money amount={-line.changeUsdCents} /> : null}</Td>
                    <Td right>
                      <Money amount={line.balanceAfterUsdCents} className="font-semibold" />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHead title="Not paid in full" hint="A payment goes to the oldest of these first." />
            {s.open.length === 0 ? (
              <Empty title="Every file is paid" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>File</Th>
                    <Th right>Amount</Th>
                    <Th right>Left to pay</Th>
                  </tr>
                </thead>
                <tbody>
                  {s.open.map((file) => (
                    <tr key={file.consignmentId}>
                      <Td>
                        <Link href={`/files/${file.shipmentId}`} className="num font-semibold hover:text-green">
                          {file.shipmentCode}
                        </Link>
                        <span className="block text-[12px] text-muted">
                          {day(file.day)} · {CONSIGNMENT[file.status].label}
                        </span>
                      </Td>
                      <Td right>
                        <Money amount={file.dueUsdCents} />
                      </Td>
                      <Td right>
                        <Money amount={file.remainingUsdCents} className="font-semibold" />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHead title="Statements made" hint="Each one is kept as it was made." />
            {copies.data === undefined ? (
              <Loading />
            ) : copies.data.items.length === 0 ? (
              <Empty title="None yet">{canMake ? "“Make a statement to send” draws one from what is on this screen now." : "The CEO makes one to send."}</Empty>
            ) : (
              <ul className="divide-y divide-rule">
                {copies.data.items.map((record) => (
                  <li key={record.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">
                        {dayTime(record.asOf)} · <span className="num">{formatMoney(record.balanceUsdCents, "USD")}</span>
                      </p>
                      <p className="text-[12px] text-muted">{record.sentAt === null ? "Not sent" : `Sent ${dayTime(record.sentAt)} by ${record.sentByName}`}</p>
                    </div>
                    <Button small onClick={() => setShowing(record)}>
                      Open
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {showing ? <Copy record={showing} canSend={canMake} onClose={() => setShowing(null)} /> : null}
    </>
  );
}
