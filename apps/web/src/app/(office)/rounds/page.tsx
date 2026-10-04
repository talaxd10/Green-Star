"use client";

import type { RoundStatus, RoundSummary } from "@green-star/contracts";
import Link from "next/link";
import { useState } from "react";
import { Button, Card, Chip, Empty, LinkButton, Loading, Money, PageHead, ReadProblem, Segmented, Table, Td, Th } from "@/components/ui";
import { withQuery } from "@/lib/api";
import { usePages } from "@/lib/hooks";
import { dayTime, ROUND } from "@/lib/labels";

type Show = "all" | RoundStatus;
const SHOW: { value: Show; label: string }[] = [
  { value: "all", label: "All" },
  { value: "planned", label: "Planned" },
  { value: "out", label: "Out" },
  { value: "returned", label: "Back" },
  { value: "handed_in", label: "Handed in" },
];

export default function RoundsPage() {
  const [show, setShow] = useState<Show>("all");
  const list = usePages<RoundSummary>(withQuery("/v1/rounds", { status: show === "all" ? undefined : show }));

  return (
    <>
      <PageHead title="Rounds" hint="A driver goes out with goods from any files and comes back with cash, receipts and photos. What happened at each stop is entered here.">
        <LinkButton tone="primary" href="/rounds/new">
          New round
        </LinkButton>
      </PageHead>
      <div className="mb-4">
        <Segmented label="Which rounds" value={show} onChange={setShow} options={SHOW} />
      </div>
      <Card>
        {list.error ? (
          <ReadProblem of={list.error} />
        ) : list.loading ? (
          <Loading what="Opening the rounds" />
        ) : list.items.length === 0 ? (
          <Empty title="No rounds here">A round is made before the driver leaves: who is driving, and which goods he takes.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Round</Th>
                <Th>Carried by</Th>
                <Th>Status</Th>
                <Th>Left</Th>
                <Th right>Stops entered</Th>
                <Th right>Collected</Th>
                <Th right>Cash not counted in</Th>
                <Th>Alerts</Th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((r) => (
                <tr key={r.id} className="group hover:bg-sunken/50">
                  <Td>
                    <Link href={`/rounds/${r.id}`} className="font-semibold group-hover:text-green">
                      Round <span className="num">{r.number}</span>
                    </Link>
                  </Td>
                  <Td>
                    <span dir="auto">{r.driverName ?? r.carrierName}</span>
                  </Td>
                  <Td>
                    <Chip tone={ROUND[r.status].tone}>{ROUND[r.status].label}</Chip>
                  </Td>
                  <Td className="whitespace-nowrap text-[13px] text-muted">{dayTime(r.leftAt)}</Td>
                  <Td right className="num text-muted">
                    {r.results} of {r.stops}
                  </Td>
                  <Td right>
                    <div className="flex flex-col items-end leading-tight">
                      {r.collectedUsdCents > 0 || r.collectedIqd === 0 ? <Money amount={r.collectedUsdCents} tone={r.collectedUsdCents === 0 ? "muted" : undefined} /> : null}
                      {r.collectedIqd > 0 ? <Money amount={r.collectedIqd} currency="IQD" /> : null}
                    </div>
                  </Td>
                  <Td right>
                    <div className="flex flex-col items-end leading-tight">
                      {r.gapUsdCents !== 0 ? <Money amount={r.gapUsdCents} tone={r.status === "handed_in" ? "red" : undefined} /> : null}
                      {r.gapIqd !== 0 ? <Money amount={r.gapIqd} currency="IQD" tone={r.status === "handed_in" ? "red" : undefined} /> : null}
                    </div>
                  </Td>
                  <Td>{r.missedCollections > 0 ? <Chip tone="red">{r.missedCollections} not collected</Chip> : null}</Td>
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
