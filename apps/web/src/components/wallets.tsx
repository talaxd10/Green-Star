"use client";

// The wallet check on the Money screen. Wallet money never passes through the
// vault, so the CEO reads each wallet's balance in its app and types it in.

import type { Wallet, Wallets } from "@green-star/contracts";
import { useState } from "react";
import { api } from "@/lib/api";
import { useGet, useSave } from "@/lib/hooks";
import { dayTime } from "@/lib/labels";
import { formatMoney, parseAmount } from "@/lib/money";
import { useToast } from "./toast";
import { Button, Card, CardHead, Chip, Dialog, Field, FormActions, Input, Loading, Money, Problem, ReadProblem, Table, Td, Textarea, Th } from "./ui";

function CheckDialog({ wallet, onClose }: { wallet: Wallet; onClose: () => void }) {
  const toast = useToast();
  // One id for this window: saving twice is one check.
  const [id] = useState(() => crypto.randomUUID());
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState("");
  const check = useSave(
    (body: unknown, key: string) => api.post<Wallets>("/v1/wallets/checks", body, key),
    () => {
      toast(`${wallet.name} checked`);
      onClose();
    },
  );
  const shown = parseAmount(typed, wallet.currency);
  const difference = shown === null ? null : shown - wallet.expectedInApp;
  const gap = difference !== null && difference !== 0;

  return (
    <Dialog open onClose={onClose} title={`Check ${wallet.name}`} hint="Open the wallet's app, read the balance, and type it here.">
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (shown === null) return;
          void check.save({ id, wallet: wallet.code, appBalance: shown, ...(note.trim() === "" ? {} : { note }) });
        }}
      >
        <div className="flex items-baseline justify-between rounded-md bg-sunken px-4 py-3">
          <span className="text-[13px] text-muted">The books say it should show</span>
          <Money amount={wallet.expectedInApp} currency={wallet.currency} className="text-[17px] font-semibold" />
        </div>
        <Field
          label={`Balance in the app, in ${wallet.currency === "USD" ? "dollars" : "dinars"}`}
          problem={check.fieldProblem("appBalance") ?? (typed.trim() !== "" && shown === null ? "Type the amount in figures" : undefined)}
        >
          {(inputId) => <Input id={inputId} className="num" inputMode="decimal" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={wallet.currency === "USD" ? "0.00" : "0"} />}
        </Field>
        {difference === null ? null : gap ? (
          <p className="rounded-md border border-amber bg-amber-soft px-3 py-2 text-sm text-amber-ink" role="status">
            The app shows <b className="num">{formatMoney(Math.abs(difference), wallet.currency)}</b> {difference < 0 ? "less" : "more"} than the books. Say why below.
          </p>
        ) : (
          <p className="rounded-md border border-green bg-green-soft px-3 py-2 text-sm text-green" role="status">
            It matches the books.
          </p>
        )}
        <Field label={gap ? "Why they differ" : "Note, if any"} problem={check.problem?.code === "gap_note_required" ? "Say why they differ" : check.fieldProblem("note")}>
          {(noteId) => <Textarea id={noteId} dir="auto" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <Problem of={check.problem?.code === "gap_note_required" ? null : check.problem} />
        <FormActions onCancel={onClose} saving={check.saving} save="Save the check" disabled={shown === null || (gap && note.trim() === "")} />
      </form>
    </Dialog>
  );
}

const isUnused = (w: Wallet) => w.ledgerBalance === 0 && w.expectedInApp === 0 && w.lastCheckedAt === null;

/** The wallets money has come in through first, then the ones never used. */
const inOrder = (wallets: readonly Wallet[]) => [...wallets].sort((a, b) => Number(isUnused(a)) - Number(isUnused(b)) || a.name.localeCompare(b.name));

export function WalletsCard() {
  const wallets = useGet<Wallets>("/v1/wallets");
  const [checking, setChecking] = useState<Wallet | null>(null);

  return (
    <Card>
      <div id="wallets" className="scroll-mt-16" />
      <CardHead title="Wallets" hint="FIB, FastPay and ZainCash. Each one is checked against its own app, because this money never passes through the vault." />
      {wallets.error ? (
        <ReadProblem of={wallets.error} />
      ) : wallets.data === undefined ? (
        <Loading />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Wallet</Th>
              <Th right>The app should show</Th>
              <Th>Last checked</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {inOrder(wallets.data.wallets).map((w) => {
              const unused = isUnused(w);
              return (
                <tr key={w.code} className={unused ? "text-faint" : undefined}>
                  <Td>
                    <span className="whitespace-nowrap font-semibold">{w.name}</span>
                    {w.checkDue ? (
                      <span className="ml-2">
                        <Chip tone="amber">Check due</Chip>
                      </span>
                    ) : null}
                  </Td>
                  <Td right>
                    <Money amount={w.expectedInApp} currency={w.currency} />
                    {w.expectedInApp !== w.ledgerBalance ? (
                      <span className="num block text-[12px] text-muted" title="What came in through this wallet, before the gaps found at earlier checks">
                        {formatMoney(w.ledgerBalance, w.currency)} came in
                      </span>
                    ) : null}
                  </Td>
                  <Td className="text-[13px] text-muted">
                    {w.lastCheckedAt === null ? (
                      "Never"
                    ) : (
                      <>
                        {dayTime(w.lastCheckedAt)}
                        {w.lastDifference !== null && w.lastDifference !== 0 ? (
                          <span className="num block text-[12px] text-red">
                            {formatMoney(Math.abs(w.lastDifference), w.currency)} {w.lastDifference < 0 ? "less" : "more"} in the app
                          </span>
                        ) : null}
                      </>
                    )}
                    {w.uncheckedSince !== null && !unused ? <span className="block whitespace-nowrap text-[12px]">New money since {dayTime(w.uncheckedSince)}</span> : null}
                  </Td>
                  <Td right>
                    <Button small onClick={() => setChecking(w)}>
                      Check
                    </Button>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {checking ? <CheckDialog wallet={checking} onClose={() => setChecking(null)} /> : null}
    </Card>
  );
}
