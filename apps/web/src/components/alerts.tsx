"use client";

// One alert as a row, and the window that resolves it. Used by the Today
// screen and the Alerts screen.

import type { Alert } from "@green-star/contracts";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { useSave } from "@/lib/hooks";
import { ALERT, dayTime, SEVERITY } from "@/lib/labels";
import { useToast } from "./toast";
import { Button, Chip, Dialog, Field, FormActions, Problem, Textarea } from "./ui";

/** Where to go to look at what an alert is about. */
function places(alert: Alert): { href: string; label: string }[] {
  const out: { href: string; label: string }[] = [];
  if (alert.roundId !== null) out.push({ href: `/rounds/${alert.roundId}`, label: `Round ${alert.roundNumber ?? ""}`.trim() });
  if (alert.customerId !== null) out.push({ href: `/customers/${alert.customerId}`, label: alert.customerName ?? "Customer" });
  if (alert.shipmentId !== null) out.push({ href: `/files/${alert.shipmentId}`, label: alert.shipmentCode ?? "File" });
  if (alert.kind === "vault_gap" || alert.kind === "vault_not_closed") out.push({ href: "/vault", label: "Vault close" });
  if (alert.kind === "wallet_gap" || alert.kind === "wallet_check_due") out.push({ href: "/money#wallets", label: "Wallets" });
  if (alert.kind === "payment_at_old_rate" && alert.customerId !== null) out.push({ href: `/money?customer=${alert.customerId}`, label: "Payments" });
  return out;
}

function ResolveDialog({ alert, onClose }: { alert: Alert; onClose: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState("");
  const resolve = useSave(
    (body: { note: string }, key: string) => api.post<Alert>(`/v1/alerts/${alert.id}/resolve`, body, key),
    () => {
      toast("Alert resolved");
      onClose();
    },
  );
  return (
    <Dialog open onClose={onClose} title="Resolve this alert" hint={alert.title}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void resolve.save({ note });
        }}
      >
        <Field label="What was done about it" hint="The alert stays on record with your name and this note." problem={resolve.fieldProblem("note")}>
          {(id) => <Textarea id={id} dir="auto" rows={3} autoFocus value={note} onChange={(e) => setNote(e.target.value)} problem={resolve.fieldProblem("note")} />}
        </Field>
        <Problem of={resolve.problem} />
        <FormActions onCancel={onClose} saving={resolve.saving} save="Resolve" disabled={note.trim() === ""} />
      </form>
    </Dialog>
  );
}

/** One alert. An open one has its Resolve button. */
export function AlertItem({ alert }: { alert: Alert }) {
  const [resolving, setResolving] = useState(false);
  const severity = SEVERITY[alert.severity];
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 px-5 py-3.5" data-alert={alert.kind}>
      <div className="flex w-[132px] shrink-0 flex-col items-start gap-1 pt-0.5">
        <Chip tone={alert.status === "open" ? severity.tone : "grey"}>{ALERT[alert.kind]}</Chip>
      </div>
      <div className="min-w-0 flex-1 basis-[280px]">
        <p className="font-semibold leading-snug" dir="auto">
          {alert.title}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
          <span className="whitespace-nowrap">Since {dayTime(alert.openedAt)}</span>
          {places(alert).map((place) => (
            <Link key={place.href} href={place.href} className="font-medium text-green hover:underline" dir="auto">
              {place.label}
            </Link>
          ))}
        </p>
        {alert.status === "resolved" ? (
          <p className="mt-2 rounded-md bg-sunken px-3 py-2 text-[13px]" dir="auto">
            <span className="text-muted">
              Resolved by {alert.resolvedByName} on {dayTime(alert.resolvedAt)}:
            </span>{" "}
            {alert.note}
            {alert.stillWrong ? null : <span className="text-muted"> · no longer the case since {dayTime(alert.clearedAt)}</span>}
          </p>
        ) : null}
        {alert.status === "cleared" ? <p className="mt-1 text-[13px] text-muted">Went away by itself on {dayTime(alert.clearedAt)}.</p> : null}
      </div>
      {alert.status === "open" ? (
        <Button small onClick={() => setResolving(true)}>
          Resolve
        </Button>
      ) : null}
      {resolving ? <ResolveDialog alert={alert} onClose={() => setResolving(false)} /> : null}
    </li>
  );
}

const ORDER = { high: 0, medium: 1, low: 2 } as const;

/** The serious ones first, then the newest. */
export function bySeverity(alerts: readonly Alert[]): Alert[] {
  return [...alerts].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || (a.openedAt < b.openedAt ? 1 : -1));
}
