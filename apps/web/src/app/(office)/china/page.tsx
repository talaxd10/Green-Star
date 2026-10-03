"use client";

import type { ChinaAccount } from "@green-star/contracts";
import { useState } from "react";
import { Button, Card, CardHead, Empty, Loading, Money, PageHead, ReadProblem, Stat, Table, Td, Th } from "@/components/ui";
import { useGet } from "@/lib/hooks";
import { day, dayTime, ENTRY } from "@/lib/labels";
import { formatMoney } from "@/lib/money";

export default function ChinaPage() {
  const [limit, setLimit] = useState(40);
  const account = useGet<ChinaAccount>(`/v1/china-account?limit=${limit}`);

  if (account.error) return <ReadProblem of={account.error} />;
  if (account.data === undefined) return <Loading what="Opening the China account" />;
  const a = account.data;

  return (
    <>
      <PageHead title="China account" hint="Everything collected is owed to the China office. Each confirmed file adds to it, customer by customer, and each amount sent pays it down." />

      <Card className="mb-5 grid grid-cols-3 gap-6 p-5">
        <Stat label="Owed to China now" tone={a.owedUsdCents > 0 ? undefined : "green"}>
          {formatMoney(a.owedUsdCents, "USD")}
        </Stat>
        <Stat label="Charged on files">{formatMoney(a.chargedUsdCents, "USD")}</Stat>
        <Stat label="Sent">{formatMoney(a.sentUsdCents, "USD")}</Stat>
      </Card>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card>
          <CardHead title="By day" />
          {a.byDay.length === 0 ? (
            <Empty title="Nothing yet" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Day</Th>
                  <Th right>Files added</Th>
                  <Th right>Sent</Th>
                  <Th right>Owed after</Th>
                </tr>
              </thead>
              <tbody>
                {a.byDay.map((d) => (
                  <tr key={d.day}>
                    <Td className="whitespace-nowrap">{day(d.day)}</Td>
                    <Td right>{d.chargedUsdCents === 0 ? "" : <Money amount={d.chargedUsdCents} />}</Td>
                    <Td right>{d.sentUsdCents === 0 ? "" : <Money amount={d.sentUsdCents} tone="green" />}</Td>
                    <Td right>
                      <Money amount={d.owedAfterUsdCents} className="font-medium" />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHead title="Line by line" hint="Newest first." />
          {a.lines.length === 0 ? (
            <Empty title="Nothing yet">It starts with the first confirmed file.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>What</Th>
                  <Th right>Change</Th>
                  <Th right>Owed after</Th>
                </tr>
              </thead>
              <tbody>
                {a.lines.map((line) => (
                  <tr key={line.entryId}>
                    <Td className="whitespace-nowrap text-[13px] text-muted">{dayTime(line.happenedAt)}</Td>
                    <Td>
                      <span className="font-semibold">
                        {line.isReversal ? "Reversed: " : ""}
                        {ENTRY[line.kind]}
                      </span>
                      <span className="block text-[12px] text-muted">{line.shipmentCode ? <span className="num">{line.shipmentCode}</span> : line.reason}</span>
                    </Td>
                    <Td right>
                      <Money amount={line.owedChangeUsdCents} tone={line.owedChangeUsdCents < 0 ? "green" : undefined} />
                    </Td>
                    <Td right>
                      <Money amount={line.owedAfterUsdCents} tone="muted" />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {a.nextCursor !== null ? (
            <div className="flex justify-center border-t border-rule p-3">
              <Button small tone="quiet" onClick={() => setLimit((n) => Math.min(n + 40, 200))} busy={account.isFetching}>
                Show more
              </Button>
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
