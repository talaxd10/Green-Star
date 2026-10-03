"use client";

import type { Carrier, Consignment, Driver, RoundDetail } from "@green-star/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { Button, Card, CardHead, Chip, Empty, Field, Input, LinkButton, Loading, Money, PageHead, Problem, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useGet, useSave } from "@/lib/hooks";
import { CONSIGNMENT, TRUST } from "@/lib/labels";

export default function NewRoundPage() {
  const router = useRouter();
  const drivers = useGet<{ items: Driver[] }>("/v1/drivers");
  const carriers = useGet<{ items: Carrier[] }>("/v1/carriers");
  const ready = useGet<{ items: Consignment[] }>("/v1/consignments?filter=ready");

  const [who, setWho] = useState("");
  const [note, setNote] = useState("");
  /** consignment id -> cartons counted at the airport, as typed. Present means it goes on the round. */
  const [picked, setPicked] = useState<Record<string, string>>({});

  const create = useSave(
    (body: unknown, key: string) => api.post<RoundDetail>("/v1/rounds", body, key),
    (round) => router.push(`/rounds/${round.id}`),
  );

  const byFile = useMemo(() => {
    const groups = new Map<string, Consignment[]>();
    for (const row of ready.data?.items ?? []) groups.set(row.shipmentCode, [...(groups.get(row.shipmentCode) ?? []), row]);
    return [...groups.entries()];
  }, [ready.data]);

  const count = Object.keys(picked).length;
  const toCollect = (ready.data?.items ?? []).filter((row) => row.id in picked).reduce((sum, row) => sum + row.remainingUsdCents, 0);

  const toggle = (row: Consignment) =>
    setPicked((current) => {
      const next = { ...current };
      if (row.id in next) delete next[row.id];
      else next[row.id] = row.cartonsExpected === null ? "" : String(row.cartonsExpected);
      return next;
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const [kind, id] = who.split(":");
    void create.save({
      ...(kind === "driver" ? { driverId: id } : { carrierId: id }),
      ...(note.trim() === "" ? {} : { note }),
      stops: Object.entries(picked).map(([consignmentId, cartons]) => ({ consignmentId, ...(cartons.trim() === "" ? {} : { cartonsCounted: Number(cartons) }) })),
    });
  };

  if (drivers.data === undefined || carriers.data === undefined || ready.data === undefined) return <Loading what="Getting the goods that are ready" />;
  const activeDrivers = drivers.data.items.filter((d) => d.active);
  const activeCarriers = carriers.data.items.filter((c) => c.active);

  return (
    <form onSubmit={submit} noValidate>
      <PageHead eyebrow="Rounds" title="New round" hint="Before he leaves: who carries the goods, which goods, and the cartons counted at the airport. One round can carry goods from several files.">
        <LinkButton tone="quiet" href="/rounds">
          Cancel
        </LinkButton>
        <Button type="submit" tone="primary" busy={create.saving} disabled={who === ""}>
          Make the round
        </Button>
      </PageHead>

      <Card className="mb-5 grid max-w-2xl grid-cols-2 gap-4 p-5">
        <Field
          label="Carried by"
          problem={create.fieldProblem("driverId")}
          hint={
            activeDrivers.length + activeCarriers.length === 0 ? (
              <>
                Add a driver in <Link href="/settings" className="font-semibold text-green hover:underline">Settings</Link> first.
              </>
            ) : undefined
          }
        >
          {(id) => (
            <Select id={id} value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Pick a driver or a carrier</option>
              <optgroup label="Drivers">
                {activeDrivers.map((d) => (
                  <option key={d.id} value={`driver:${d.id}`}>
                    {d.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Our cars and transport offices">
                {activeCarriers.map((c) => (
                  <option key={c.id} value={`carrier:${c.id}`}>
                    {c.name}
                    {c.city ? ` · ${c.city}` : ""}
                  </option>
                ))}
              </optgroup>
            </Select>
          )}
        </Field>
        <Field label="Note" hint="Optional">
          {(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Kirkuk road, back tomorrow" />}
        </Field>
      </Card>

      <Card>
        <CardHead
          title="Goods ready to go"
          hint="From confirmed files, and goods held in the car from an earlier round."
          action={
            <p className="text-sm text-muted">
              {count} {count === 1 ? "stop" : "stops"} · to collect <Money amount={toCollect} className="font-semibold text-ink" />
            </p>
          }
        />
        {byFile.length === 0 ? (
          <Empty title="Nothing is waiting">Goods can go on a round once their file is confirmed.</Empty>
        ) : (
          byFile.map(([code, rows]) => (
            <div key={code}>
              <div className="flex items-center justify-between border-b border-rule bg-sunken/60 px-5 py-2">
                <span className="num text-[13px] font-semibold">{code}</span>
                <button
                  type="button"
                  className="text-[13px] font-semibold text-green hover:underline"
                  onClick={() =>
                    setPicked((current) => {
                      const all = rows.every((row) => row.id in current);
                      const next = { ...current };
                      for (const row of rows) {
                        if (all) delete next[row.id];
                        else if (!(row.id in next)) next[row.id] = row.cartonsExpected === null ? "" : String(row.cartonsExpected);
                      }
                      return next;
                    })
                  }
                >
                  {rows.every((row) => row.id in picked) ? "Take none" : "Take all"}
                </button>
              </div>
              {rows.map((row) => {
                const on = row.id in picked;
                return (
                  <label key={row.id} className={`grid cursor-pointer grid-cols-[24px_minmax(0,1fr)_120px_120px_150px] items-center gap-3 border-b border-rule px-5 py-2.5 text-sm ${on ? "bg-green-soft/40" : "hover:bg-sunken/40"}`}>
                    <input type="checkbox" className="size-4 accent-green" checked={on} onChange={() => toggle(row)} />
                    <span className="min-w-0">
                      <b className="font-semibold" dir="auto">
                        {row.customerName}
                      </b>
                      <span className="ml-2 text-[12px] text-muted">
                        {TRUST[row.trust].label.toLowerCase()}
                        {row.city ? ` · ${row.city}` : ""}
                      </span>
                      {row.status === "held" ? <span className="ml-2"><Chip tone={CONSIGNMENT.held.tone}>{CONSIGNMENT.held.label}</Chip></span> : null}
                    </span>
                    <span className="text-right">{row.amountDueUsdCents === 0 ? <span className="text-[13px] text-muted">prepaid</span> : <Money amount={row.remainingUsdCents} />}</span>
                    <span className="num text-right text-[13px] text-muted">{row.cartonsExpected === null ? "" : `${row.cartonsExpected} on the file`}</span>
                    {on ? (
                      <Input
                        aria-label={`Cartons counted for ${row.customerName}`}
                        className="num h-8 text-right"
                        inputMode="numeric"
                        placeholder="cartons counted"
                        value={picked[row.id]}
                        onClick={(e) => e.preventDefault()}
                        onChange={(e) => setPicked((current) => ({ ...current, [row.id]: e.target.value.replace(/\D/g, "") }))}
                      />
                    ) : (
                      <span />
                    )}
                  </label>
                );
              })}
            </div>
          ))
        )}
      </Card>
      <div className="mt-4 max-w-2xl">
        <Problem of={create.problem} />
      </div>
    </form>
  );
}
