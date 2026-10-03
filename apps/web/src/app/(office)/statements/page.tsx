"use client";

import type { StatementListItem } from "@green-star/contracts";
import Link from "next/link";
import { Card, Chip, Empty, LimitBar, LinkButton, Loading, Money, PageHead, ReadProblem, Table, Td, Th } from "@/components/ui";
import { useGet } from "@/lib/hooks";
import { dayTime, phone } from "@/lib/labels";

export default function StatementsPage() {
  const list = useGet<{ items: StatementListItem[] }>("/v1/statements");
  const due = list.data?.items.filter((item) => item.due).length ?? 0;

  return (
    <>
      <PageHead
        title="Statements"
        hint="Trusted customers who owe something, and when each was last sent what he owes. One a week keeps them told. Any customer's statement is on his own page."
      />
      <Card>
        {list.error ? (
          <ReadProblem of={list.error} />
        ) : list.data === undefined ? (
          <Loading what="Opening the list" />
        ) : list.data.items.length === 0 ? (
          <Empty title="Nobody to send one to">No trusted customer owes anything.</Empty>
        ) : (
          <>
            <p className="border-b border-rule px-5 py-3 text-[13px] text-muted">
              {due === 0 ? "Everyone on this list was sent a statement this week." : `${due} to send this week.`}
            </p>
            <Table>
              <thead>
                <tr>
                  <Th>Customer</Th>
                  <Th right>He owes</Th>
                  <Th>His limit</Th>
                  <Th>Last statement sent</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((item) => (
                  <tr key={item.customerId} className="group hover:bg-sunken/50">
                    <Td>
                      <Link href={`/customers/${item.customerId}`} className="font-semibold group-hover:text-green" dir="auto">
                        {item.customerName}
                      </Link>
                      <span className="num block text-[12px] text-muted">{phone(item.phone) || "no phone"}</span>
                    </Td>
                    <Td right>
                      <Money amount={item.balanceUsdCents} className="font-semibold" tone={item.overLimit ? "red" : undefined} />
                    </Td>
                    <Td>{item.creditLimitUsdCents === null ? <span className="text-[13px] text-muted">No limit</span> : <LimitBar balance={item.balanceUsdCents} limit={item.creditLimitUsdCents} />}</Td>
                    <Td className="text-[13px] text-muted">
                      {item.lastSentAt === null ? (
                        "Never"
                      ) : (
                        <>
                          {dayTime(item.lastSentAt)}
                          {item.lastSentBalanceUsdCents !== null ? (
                            <span className="num block text-[12px]">
                              said <Money amount={item.lastSentBalanceUsdCents} />
                            </span>
                          ) : null}
                        </>
                      )}
                    </Td>
                    <Td right>
                      <div className="flex items-center justify-end gap-3 whitespace-nowrap">
                        {item.due ? <Chip tone="amber">To send</Chip> : <Chip tone="green">Sent this week</Chip>}
                        <LinkButton small href={`/customers/${item.customerId}/statement`}>
                          Statement
                        </LinkButton>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </Card>
    </>
  );
}
