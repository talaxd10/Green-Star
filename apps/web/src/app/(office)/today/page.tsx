"use client";

import type { Alert, Page, TodayReport } from "@green-star/contracts";
import Link from "next/link";
import { AlertItem, bySeverity } from "@/components/alerts";
import { Card, CardHead, Chip, Empty, LinkButton, Loading, Money, PageHead, ReadProblem, Stat, Table, Td, Th } from "@/components/ui";
import { useCan, useGet } from "@/lib/hooks";
import { day, dayTime, ROUND, SHIPMENT } from "@/lib/labels";
import { formatRatePerDollar } from "@/lib/money";

const SHOWN = 6;

export default function TodayPage() {
  const canEnter = useCan("enter_money");
  const report = useGet<TodayReport>("/v1/reports/today");
  const open = useGet<Page<Alert>>("/v1/alerts?status=open&limit=200");

  if (report.error) return <ReadProblem of={report.error} />;
  if (report.data === undefined) return <Loading what="Opening today" />;
  const t = report.data;
  const alerts = bySeverity(open.data?.items ?? []);
  const notCollected = t.expectedUsdCents - t.collectedUsdCents;
  const out = t.rounds.filter((r) => r.status === "out" || r.status === "planned").length;
  const back = t.rounds.filter((r) => r.status === "returned").length;

  return (
    <>
      <PageHead eyebrow={day(t.day)} title="Today" hint="What needs you first, then today's rounds and the files still open." />

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card className="p-5">
          <Stat label="Open alerts" tone={t.alerts.high > 0 ? "red" : t.alerts.open > 0 ? "amber" : "green"} hint={t.alerts.open === 0 ? "Everything matches" : `${t.alerts.high} of them serious`}>
            {t.alerts.open}
          </Stat>
        </Card>
        <Card className="p-5">
          <Stat
            label="Today's rate"
            tone={t.rate === null ? "amber" : undefined}
            hint={
              t.rate === null ? (
                <Link href="/money" className="font-medium text-green hover:underline">
                  Set it before the first dinar payment
                </Link>
              ) : (
                `IQD per $1, set by ${t.rate.setBy}`
              )
            }
          >
            {t.rate === null ? "Not set" : formatRatePerDollar(t.rate.iqdPer100Usd)}
          </Stat>
        </Card>
        <Card className="p-5">
          <Stat label="Rounds out" hint={back > 0 ? `${back} back, cash not counted in yet` : "None waiting to be counted in"}>
            {out}
          </Stat>
        </Card>
        <Card className="p-5">
          <Stat label="Held in the car" hint="Goods that came back undelivered">
            {t.heldInCar}
          </Stat>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
        <div className="flex flex-col gap-5">
          <Card>
            <CardHead
              title="Needs you"
              hint="Everything that does not match."
              action={
                <LinkButton small href="/alerts">
                  All alerts
                </LinkButton>
              }
            />
            {open.error ? (
              <ReadProblem of={open.error} />
            ) : open.data === undefined ? (
              <Loading />
            ) : alerts.length === 0 ? (
              <Empty title="Nothing needs you">No missed collections, no cash gaps, nobody over his limit.</Empty>
            ) : (
              <>
                <ul className="divide-y divide-rule">
                  {alerts.slice(0, SHOWN).map((alert) => (
                    <AlertItem key={alert.id} alert={alert} canResolve={canEnter} />
                  ))}
                </ul>
                {alerts.length > SHOWN ? (
                  <p className="border-t border-rule px-5 py-3 text-[13px] text-muted">
                    And {alerts.length - SHOWN} more.{" "}
                    <Link href="/alerts" className="font-medium text-green hover:underline">
                      See them all
                    </Link>
                  </p>
                ) : null}
              </>
            )}
          </Card>

        </div>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHead title="Money on today's rounds" hint="What the rounds went out to collect, what they took, and what has been counted into the vault." />
            <div className="grid grid-cols-3 gap-4 border-b border-rule p-5">
              <Stat label="To collect">
                <Money amount={t.expectedUsdCents} />
              </Stat>
              <Stat label="Collected" hint="Cash and wallets, in dollars">
                <Money amount={t.collectedUsdCents} />
              </Stat>
              <Stat label="Not collected" tone={notCollected > 0 ? "amber" : undefined} hint="On account, held or unpaid">
                <Money amount={Math.max(notCollected, 0)} />
              </Stat>
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>Cash</Th>
                  <Th right>Receipts say</Th>
                  <Th right>Counted in</Th>
                  <Th right>Still out</Th>
                </tr>
              </thead>
              <tbody>
                {t.cash.map((c) => (
                  <tr key={c.currency}>
                    <Td className="font-semibold">{c.currency === "USD" ? "Dollars" : "Dinars"}</Td>
                    <Td right>
                      <Money amount={c.collected} currency={c.currency} />
                    </Td>
                    <Td right>
                      <Money amount={c.counted} currency={c.currency} />
                    </Td>
                    <Td right>
                      <Money amount={c.gap} currency={c.currency} tone={c.gap === 0 ? "muted" : undefined} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="flex items-baseline justify-between border-t border-rule px-5 py-3.5 text-sm">
              <span className="text-muted">Paid at the office today, cash and wallets</span>
              <Money amount={t.officePaymentsUsdCents} className="font-semibold" />
            </p>
          </Card>

        </div>
      </div>

      <div className="mt-5 flex flex-col gap-5">
        <Card>
          <CardHead
            title="Today's rounds"
            hint="Rounds that are not finished, and rounds counted in today."
            action={
              canEnter ? (
                <LinkButton small href="/rounds/new">
                  New round
                </LinkButton>
              ) : undefined
            }
          />
          {t.rounds.length === 0 ? (
            <Empty title="No rounds today" />
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
                  <Th />
                </tr>
              </thead>
              <tbody>
                {t.rounds.map((r) => (
                  <tr key={r.id} className="group hover:bg-sunken/50">
                    <Td>
                      <Link href={`/rounds/${r.id}`} className="whitespace-nowrap font-semibold group-hover:text-green">
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
                    <Td right className="num whitespace-nowrap text-muted">
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
        </Card>
        <Card>
          <CardHead title="Files in progress" hint="Every file that is not closed, and what it is waiting for." />
          {t.files.length === 0 ? (
            <Empty title="No open files" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>File</Th>
                  <Th>Status</Th>
                  <Th>Waiting for</Th>
                  <Th right>Collected</Th>
                </tr>
              </thead>
              <tbody>
                {t.files.map((f) => {
                  const waiting = [
                    f.notDelivered > 0 ? `${f.notDelivered} to deliver` : null,
                    f.deliveredNotPaid > 0 ? `${f.deliveredNotPaid} not paid` : null,
                    f.waitingForHandIn > 0 ? `${f.waitingForHandIn} to count in` : null,
                    f.disputesWaiting > 0 ? `${f.disputesWaiting} with China` : null,
                  ].filter((x): x is string => x !== null);
                  return (
                    <tr key={f.id} className="group hover:bg-sunken/50">
                      <Td>
                        <Link href={`/files/${f.id}`} className="num font-semibold group-hover:text-green">
                          {f.code}
                        </Link>
                        <span className="block whitespace-nowrap text-[12px] text-muted">{f.consignments} customers</span>
                      </Td>
                      <Td>
                        <Chip tone={SHIPMENT[f.status].tone}>{SHIPMENT[f.status].label}</Chip>
                      </Td>
                      <Td className="text-[13px] text-muted">{f.status === "draft" ? "To be confirmed" : waiting.length === 0 ? "Nothing" : waiting.join(", ")}</Td>
                      <Td right>
                        <Money amount={f.collectedUsdCents} />
                        <span className="num block whitespace-nowrap text-[12px] text-muted">
                          of <Money amount={f.expectedUsdCents} />
                        </span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
