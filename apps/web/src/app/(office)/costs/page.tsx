"use client";

import type { CostLine, DeliveryCosts } from "@green-star/contracts";
import Link from "next/link";
import { useState } from "react";
import { Card, CardHead, Empty, Field, Input, Loading, PageHead, ReadProblem, Stat, Table, Td, Th } from "@/components/ui";
import { withQuery } from "@/lib/api";
import { useGet } from "@/lib/hooks";
import { day } from "@/lib/labels";
import { formatMoney } from "@/lib/money";

/** "Oct 2026" from "2026-10". */
const monthName = (month: string) => new Date(`${month}-01T12:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

/** As it was paid: "$40.00 · 115,000 IQD". */
function paid(line: CostLine): string {
  const parts = [line.usdPaid !== 0 ? formatMoney(line.usdPaid, "USD") : null, line.iqdPaid !== 0 ? formatMoney(line.iqdPaid, "IQD") : null].filter(Boolean);
  return parts.length === 0 ? "" : parts.join(" · ");
}

function Bar({ value, max }: { value: number; max: number }) {
  const width = max <= 0 ? 0 : Math.max(2, Math.round((value / max) * 100));
  return (
    <span className="block h-1.5 w-full rounded-full bg-sunken" aria-hidden>
      <span className="block h-1.5 rounded-full bg-green" style={{ width: `${value <= 0 ? 0 : width}%` }} />
    </span>
  );
}

export default function CostsPage() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const report = useGet<DeliveryCosts>(withQuery("/v1/reports/delivery-costs", { from, to }));

  if (report.error) return <ReadProblem of={report.error} />;
  const r = report.data;
  const months = r?.byMonth ?? [];
  const maxMonth = Math.max(0, ...months.map((m) => m.usdCents));

  return (
    <>
      <PageHead
        title="Delivery costs"
        hint="Every expense of getting goods to customers, counted exactly: what the driver spent from his account and what was paid from the vault. Dinars are counted in dollars at the rate of their day."
      >
        <div className="flex items-end gap-3">
          <Field label="From">{(id) => <Input id={id} type="date" value={from || (r?.from ?? "")} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="To">{(id) => <Input id={id} type="date" value={to || (r?.to ?? "")} onChange={(e) => setTo(e.target.value)} />}</Field>
        </div>
      </PageHead>

      {r === undefined ? (
        <Loading what="Adding it up" />
      ) : (
        <>
          <Card className="mb-5 grid grid-cols-2 gap-6 p-5 lg:grid-cols-5" >
            <Stat label="Delivery cost" hint={paid(r.delivery) || "Nothing spent"}>
              <span data-testid="delivery-total">{formatMoney(r.delivery.usdCents, "USD")}</span>
            </Stat>
            <Stat label="Goods delivered" hint={`${r.delivered.rounds} ${r.delivered.rounds === 1 ? "round" : "rounds"}`}>
              {r.delivered.customers}
            </Stat>
            <Stat label="Per customer's goods" hint="Delivery cost divided by the goods handed over">
              <span data-testid="per-delivery">{r.perDeliveryUsdCents === null ? "–" : formatMoney(r.perDeliveryUsdCents, "USD")}</span>
            </Stat>
            <Stat label="Per kilogram" hint={r.delivered.weightGrams > 0 ? `${(r.delivered.weightGrams / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })} kg delivered` : "Weights come from imported files"}>
              {r.perKgUsdCents === null ? "–" : formatMoney(r.perKgUsdCents, "USD")}
            </Stat>
            <Stat label="Other expenses" hint="Customs and airport, rent and salaries, other. Not delivery.">
              {formatMoney(r.other.usdCents, "USD")}
            </Stat>
          </Card>
          {r.daysWithoutRate.length > 0 ? (
            <p className="mb-5 rounded-md bg-amber-soft px-3 py-2 text-sm text-amber-ink">
              No dinar rate was set on {r.daysWithoutRate.map(day).join(", ")}. Dinars spent those days are counted at the nearest day&apos;s rate.
            </p>
          ) : null}

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Card>
              <CardHead title="By month" hint="What delivering cost, next to what was delivered. This is the number for a second car." />
              {months.length === 0 ? (
                <Empty title="Nothing in this time" />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Month</Th>
                      <Th right>Cost</Th>
                      <Th className="w-1/4" />
                      <Th right>Rounds</Th>
                      <Th right>Goods</Th>
                      <Th right>Per goods</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {months.map((m) => (
                      <tr key={m.month}>
                        <Td>{monthName(m.month)}</Td>
                        <Td right className="num font-medium">{formatMoney(m.usdCents, "USD")}</Td>
                        <Td><Bar value={m.usdCents} max={maxMonth} /></Td>
                        <Td right className="num text-muted">{m.rounds}</Td>
                        <Td right className="num text-muted">{m.deliveredCustomers}</Td>
                        <Td right className="num">{m.deliveredCustomers === 0 ? "–" : formatMoney(Math.round(m.usdCents / m.deliveredCustomers), "USD")}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>

            <Card>
              <CardHead title="By kind" hint="What the money went on." />
              <Table>
                <thead>
                  <tr>
                    <Th>Kind</Th>
                    <Th right>In dollars</Th>
                    <Th right>As paid</Th>
                  </tr>
                </thead>
                <tbody>
                  {r.byCategory.map((c) => (
                    <tr key={c.category} className={c.usdCents === 0 ? "text-faint" : undefined}>
                      <Td>
                        {c.label}
                        {!c.delivery ? <span className="ml-2 text-[12px] text-muted">not delivery</span> : null}
                      </Td>
                      <Td right className="num font-medium">{formatMoney(c.usdCents, "USD")}</Td>
                      <Td right className="num text-[13px] text-muted">{paid(c)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>

            <Card>
              <CardHead title="By city" hint="The city on each receipt, and where the goods went." />
              {r.byCity.length === 0 ? (
                <Empty title="Nothing in this time" />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>City</Th>
                      <Th right>Cost</Th>
                      <Th right>Goods delivered</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.byCity.map((c) => (
                      <tr key={c.city}>
                        <Td><span dir="auto">{c.city}</span></Td>
                        <Td right className="num font-medium">{formatMoney(c.usdCents, "USD")}</Td>
                        <Td right className="num text-muted">{c.deliveredCustomers}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>

            <Card>
              <CardHead title="By round" hint="Receipts entered with a round, next to what that round delivered." />
              {r.byRound.length === 0 ? (
                <Empty title="No rounds in this time" />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Round</Th>
                      <Th>Who</Th>
                      <Th right>Cost</Th>
                      <Th right>Goods</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.byRound.map((x) => (
                      <tr key={x.roundId}>
                        <Td>
                          <Link href={`/rounds/${x.roundId}`} className="num font-semibold hover:text-green">
                            {x.number}
                          </Link>
                          {x.leftAt ? <span className="ml-2 text-[12px] text-muted">{day(x.leftAt)}</span> : null}
                        </Td>
                        <Td><span dir="auto">{x.driverName ?? x.carrierName}</span></Td>
                        <Td right className="num font-medium">{formatMoney(x.usdCents, "USD")}</Td>
                        <Td right className="num text-muted">{x.deliveredCustomers}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
