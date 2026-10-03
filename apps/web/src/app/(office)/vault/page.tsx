"use client";

import type { Currency, Vault } from "@green-star/contracts";
import { useState, type FormEvent } from "react";
import { NoteCounter } from "@/components/note-counter";
import { useToast } from "@/components/toast";
import { Button, Card, CardHead, Dialog, Empty, Field, FormActions, Loading, PageHead, Problem, ReadProblem, Stat, Table, Td, Textarea, Th } from "@/components/ui";
import { api } from "@/lib/api";
import { useCan, useGet, useSave } from "@/lib/hooks";
import { day, dayTime } from "@/lib/labels";
import { countNotes, formatMoney } from "@/lib/money";

function TakeBack({ closeId, onClose }: { closeId: string; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const take = useSave((body: unknown, key: string) => api.post(`/v1/vault/closes/${closeId}/void`, body, key), onClose);
  return (
    <Dialog open onClose={onClose} title="Take this count back" hint="A count is never edited. It is taken back and the vault is counted again.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void take.save({ reason });
        }}
      >
        <Field label="Why">{(id) => <Textarea id={id} rows={2} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Counted the wrong drawer" />}</Field>
        <Problem of={take.problem} />
        <FormActions onCancel={onClose} saving={take.saving} save="Take it back" danger disabled={reason.trim() === ""} />
      </form>
    </Dialog>
  );
}

export default function VaultPage() {
  const canClose = useCan("enter_money");
  const toast = useToast();
  const vault = useGet<Vault>("/v1/vault");
  const [usdNotes, setUsdNotes] = useState<Record<string, number>>({});
  const [iqdNotes, setIqdNotes] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const [id, setId] = useState(() => crypto.randomUUID());
  const [takingBack, setTakingBack] = useState<string | null>(null);

  const close = useSave(
    (body: unknown, key: string) => api.post<Vault>("/v1/vault/close", body, key),
    () => {
      toast("The vault is closed for today");
      setUsdNotes({});
      setIqdNotes({});
      setNote("");
      setId(crypto.randomUUID());
    },
  );

  if (vault.error) return <ReadProblem of={vault.error} />;
  if (vault.data === undefined) return <Loading what="Opening the vault" />;
  const v = vault.data;
  const of = (currency: Currency) => v.currencies.find((c) => c.currency === currency);
  const expected = (currency: Currency) => of(currency)?.expectedNow ?? 0;
  const gap = countNotes(usdNotes) !== expected("USD") || countNotes(iqdNotes) !== expected("IQD");
  const latest = v.closes.find((c) => !c.voided);

  return (
    <>
      <PageHead title="Vault close" hint="Count the vault note by note at the end of the day. The system adds it up and compares it with the last count plus everything entered since." />

      <Card className="mb-5 grid grid-cols-2 gap-6 p-5 md:grid-cols-4">
        <Stat label="Should hold, dollars">{formatMoney(expected("USD"), "USD")}</Stat>
        <Stat label="Should hold, dinars">{formatMoney(expected("IQD"), "IQD")}</Stat>
        <Stat label="Last counted" hint={latest ? `${dayTime(latest.closedAt)}` : "Never counted"}>
          {latest ? formatMoney(latest.usd.counted, "USD") : "–"}
        </Stat>
        <Stat label="Gaps noted so far" tone={(of("USD")?.notedGap ?? 0) !== 0 || (of("IQD")?.notedGap ?? 0) !== 0 ? "amber" : undefined} hint="Found at earlier closes, each with its note.">
          {formatMoney(of("USD")?.notedGap ?? 0, "USD")}
          <span className="mx-1 text-faint">·</span>
          {formatMoney(of("IQD")?.notedGap ?? 0, "IQD")}
        </Stat>
      </Card>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {canClose ? (
          <Card>
            <CardHead title="Count it" hint="How many of each note is in the box." />
            <form
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                void close.save({ id, usdNotes, iqdNotes, ...(note.trim() === "" ? {} : { note }) });
              }}
            >
              <div className="grid grid-cols-1 divide-y divide-rule md:grid-cols-2 md:divide-x md:divide-y-0">
                <NoteCounter currency="USD" denominations={v.denominations} notes={usdNotes} onChange={setUsdNotes} expected={expected("USD")} />
                <NoteCounter currency="IQD" denominations={v.denominations} notes={iqdNotes} onChange={setIqdNotes} expected={expected("IQD")} />
              </div>
              <div className="flex flex-col gap-3 border-t border-rule p-5">
                {gap ? (
                  <Field label="Why the count and the books differ" hint="The gap is kept on this close with your note. From then on the vault is expected to hold what you counted.">
                    {(fieldId) => <Textarea id={fieldId} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="$2 short. Counted twice. Will check yesterday's receipts." />}
                  </Field>
                ) : null}
                <Problem of={close.problem} />
                <div>
                  <Button type="submit" tone="primary" busy={close.saving} disabled={gap && note.trim() === ""}>
                    Close the vault
                  </Button>
                </div>
              </div>
            </form>
          </Card>
        ) : (
          <Card>
            <Empty title="The CEO closes the vault">You can see every close and what was counted.</Empty>
          </Card>
        )}

        <Card>
          <CardHead title="Earlier closes" />
          {v.closes.length === 0 ? (
            <Empty title="Not closed yet">The first close is the opening count: whatever is in the box becomes the starting point.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Day</Th>
                  <Th right>Counted</Th>
                  <Th right>Gap</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {v.closes.map((c) => (
                  <tr key={c.id} className={c.voided ? "text-faint line-through" : undefined}>
                    <Td className="whitespace-nowrap">
                      {day(c.day)}
                      {c.note ? <span className="block max-w-[26ch] whitespace-normal text-[12px] text-muted">{c.note}</span> : null}
                    </Td>
                    <Td right className="num whitespace-nowrap text-[13px]">
                      {formatMoney(c.usd.counted, "USD")}
                      <span className="block">{formatMoney(c.iqd.counted, "IQD")}</span>
                    </Td>
                    <Td right className="num whitespace-nowrap text-[13px]">
                      <span className={c.usd.difference !== 0 ? "text-red" : "text-muted"}>{formatMoney(c.usd.difference, "USD")}</span>
                      <span className={`block ${c.iqd.difference !== 0 ? "text-red" : "text-muted"}`}>{formatMoney(c.iqd.difference, "IQD")}</span>
                    </Td>
                    <Td right className="whitespace-nowrap">
                      {canClose && !c.voided && c.id === latest?.id ? (
                        <button type="button" className="text-[13px] text-muted hover:text-red hover:underline" onClick={() => setTakingBack(c.id)}>
                          Take back
                        </button>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
      {takingBack ? <TakeBack closeId={takingBack} onClose={() => setTakingBack(null)} /> : null}
    </>
  );
}
