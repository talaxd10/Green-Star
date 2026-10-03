"use client";

import type { Alert, AlertCount, AlertStatus } from "@green-star/contracts";
import { useState } from "react";
import { AlertItem, bySeverity } from "@/components/alerts";
import { Button, Card, Empty, Loading, PageHead, ReadProblem, Segmented } from "@/components/ui";
import { useCan, useGet, usePages } from "@/lib/hooks";

const EMPTY: Record<AlertStatus, { title: string; text: string }> = {
  open: { title: "Nothing is open", text: "Everything matches: no missed collections, no cash gaps, nobody over his limit." },
  resolved: { title: "Nothing resolved yet", text: "An alert you close with a note is kept here, with your name and what you wrote." },
  cleared: { title: "Nothing here yet", text: "An alert that stops being true goes away by itself and is kept here: the customer paid, the rest of the cash came in." },
};

export default function AlertsPage() {
  const canResolve = useCan("enter_money");
  const [show, setShow] = useState<AlertStatus>("open");
  const count = useGet<AlertCount>("/v1/alerts/count");
  const list = usePages<Alert>(`/v1/alerts?status=${show}`);
  // Open alerts read with the serious ones first; the others in the order they were closed.
  const items = show === "open" && !list.hasMore ? bySeverity(list.items) : list.items;

  return (
    <>
      <PageHead
        title="Alerts"
        hint="Everything that does not match: a customer who got his goods without paying, cash that was not counted in, a count that is off. Each one is closed with a note, or goes away when it stops being true."
      />
      <div className="mb-4">
        <Segmented
          label="Which alerts"
          value={show}
          onChange={setShow}
          options={[
            { value: "open", label: "Open", count: count.data?.open },
            { value: "resolved", label: "Resolved" },
            { value: "cleared", label: "Went away" },
          ]}
        />
      </div>
      <Card>
        {list.error ? (
          <ReadProblem of={list.error} />
        ) : list.loading ? (
          <Loading what="Opening the alerts" />
        ) : items.length === 0 ? (
          <Empty title={EMPTY[show].title}>{EMPTY[show].text}</Empty>
        ) : (
          <ul className="divide-y divide-rule">
            {items.map((alert) => (
              <AlertItem key={alert.id} alert={alert} canResolve={canResolve} />
            ))}
          </ul>
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
