"use client";

import type { ShipmentStatus, ShipmentSummary } from "@green-star/contracts";
import Link from "next/link";
import { useState } from "react";
import { Card, Chip, Empty, LinkButton, Loading, Money, PageHead, ReadProblem, Segmented, Table, Td, Th, Button } from "@/components/ui";
import { withQuery } from "@/lib/api";
import { usePages } from "@/lib/hooks";
import { day, SHIPMENT } from "@/lib/labels";

type Show = "all" | ShipmentStatus;

const SHOW: { value: Show; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Drafts" },
  { value: "confirmed", label: "Confirmed" },
  { value: "on_rounds", label: "On rounds" },
  { value: "reconciling", label: "Reconciling" },
  { value: "closed", label: "Closed" },
];

/** In a few words, what still stops a file closing. */
export function blockers(file: ShipmentSummary): string[] {
  const out: string[] = [];
  if (file.status === "draft") return ["Not confirmed yet"];
  if (file.notDelivered > 0) out.push(`${file.notDelivered} not delivered`);
  if (file.deliveredNotPaid > 0) out.push(`${file.deliveredNotPaid} delivered, not paid`);
  if (file.waitingForHandIn > 0) out.push(`${file.waitingForHandIn} waiting for the round's cash`);
  if (file.disputesWaiting > 0) out.push(`${file.disputesWaiting} waiting on China`);
  return out;
}

export default function FilesPage() {
  const [show, setShow] = useState<Show>("all");
  const list = usePages<ShipmentSummary>(withQuery("/v1/shipments", { status: show === "all" ? undefined : show }));

  return (
    <>
      <PageHead title="Files" hint="Each file from China, what it should bring in, what has come in, and what stops it closing. A file closes by itself.">
        <LinkButton href="/files/import">Import from Excel</LinkButton>
        <LinkButton tone="primary" href="/files/new">
          Type a file in
        </LinkButton>
      </PageHead>

      <div className="mb-4">
        <Segmented label="Which files" value={show} onChange={setShow} options={SHOW} />
      </div>

      <Card>
        {list.error ? (
          <ReadProblem of={list.error} />
        ) : list.loading ? (
          <Loading what="Opening the files" />
        ) : list.items.length === 0 ? (
          <Empty title="No files here">{show === "all" ? "Type the first file in, one row per customer." : "No file is in this state right now."}</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>File</Th>
                <Th>Arrived</Th>
                <Th>Status</Th>
                <Th right>Customers</Th>
                <Th right>To collect</Th>
                <Th right>Collected</Th>
                <Th right>Still out</Th>
                <Th>What stops it closing</Th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((file) => (
                <tr key={file.id} className="group hover:bg-sunken/50">
                  <Td>
                    <Link href={`/files/${file.id}`} className="num font-semibold group-hover:text-green">
                      {file.code}
                    </Link>
                  </Td>
                  <Td className="whitespace-nowrap text-[13px] text-muted">{day(file.arrivedOn)}</Td>
                  <Td>
                    <Chip tone={SHIPMENT[file.status].tone}>{SHIPMENT[file.status].label}</Chip>
                  </Td>
                  <Td right className="num text-muted">
                    {file.consignments}
                  </Td>
                  <Td right>{file.status === "draft" ? <span className="text-muted">–</span> : <Money amount={file.expectedUsdCents} />}</Td>
                  <Td right>{file.status === "draft" ? <span className="text-muted">–</span> : <Money amount={file.collectedUsdCents} tone="muted" />}</Td>
                  <Td right>{file.status === "draft" ? <span className="text-muted">–</span> : <Money amount={file.remainingUsdCents} tone={file.remainingUsdCents === 0 ? "muted" : undefined} className="font-medium" />}</Td>
                  <Td className="text-[13px] text-muted">
                    {file.status === "closed" ? (file.onAccount > 0 ? `${file.onAccount} on account with a trusted customer` : "") : blockers(file).join(" · ")}
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
    </>
  );
}
