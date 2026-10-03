"use client";

import type { Currency, Denomination } from "@green-star/contracts";
import { countNotes, formatMoney } from "@/lib/money";
import { cx } from "./ui";

/**
 * Cash counted note by note. He types how many of each note; the system adds
 * it up and shows it beside what should be there. His last mismatches were
 * miscounts and forgotten entries, and this is what catches both.
 */
export function NoteCounter({
  currency,
  denominations,
  notes,
  onChange,
  expected,
}: {
  currency: Currency;
  denominations: Denomination[];
  notes: Record<string, number>;
  onChange: (notes: Record<string, number>) => void;
  /** What the receipts, or the ledger, say should be there. */
  expected: number;
}) {
  const counted = countNotes(notes);
  const difference = counted - expected;
  const mine = denominations.filter((d) => d.currency === currency).sort((a, b) => b.value - a.value);

  const set = (value: number, typed: string) => {
    const count = typed === "" ? 0 : Number(typed.replace(/\D/g, ""));
    const next = { ...notes };
    if (count > 0) next[String(value)] = count;
    else delete next[String(value)];
    onChange(next);
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between px-5 pb-2 pt-4">
        <h3 className="display text-[17px]">{currency === "USD" ? "Dollars" : "Dinars"}</h3>
        <span className="text-[13px] text-muted">
          should be <b className="num font-semibold text-ink">{formatMoney(expected, currency)}</b>
        </span>
      </div>
      <div className="grid grid-cols-[1fr_88px_1fr] items-center gap-x-3 gap-y-1.5 px-5">
        <span className="eyebrow">Note</span>
        <span className="eyebrow text-center">How many</span>
        <span className="eyebrow text-right">Makes</span>
        {mine.map((d) => {
          const count = notes[String(d.value)] ?? 0;
          return (
            <div key={d.value} className="contents">
              <label htmlFor={`${currency}-${d.value}`} className="num text-sm">
                {currency === "USD" ? d.label : `${d.label} IQD`}
              </label>
              <input
                id={`${currency}-${d.value}`}
                inputMode="numeric"
                className="num h-9 w-full rounded-md border border-rule-strong bg-surface px-2 text-center text-sm hover:border-muted"
                value={count === 0 ? "" : String(count)}
                placeholder="0"
                onChange={(e) => set(d.value, e.target.value)}
              />
              <span className={cx("num text-right text-sm", count === 0 ? "text-faint" : "text-ink")}>{formatMoney(count * d.value, currency)}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-rule px-5 py-3">
        <span className="text-sm text-muted">Counted</span>
        <span className="num text-lg font-semibold">{formatMoney(counted, currency)}</span>
      </div>
      {counted === 0 && expected !== 0 ? (
        <div className="bg-sunken px-5 py-2.5 text-sm text-muted">Not counted yet</div>
      ) : (
        <div className={cx("flex items-center justify-between px-5 py-2.5 text-sm", difference === 0 ? "bg-green-soft text-green" : "bg-red-soft text-red")}>
          {difference === 0 ? (
            <span className="font-semibold">Matches</span>
          ) : (
            <>
              <span className="font-semibold">{difference < 0 ? "Short by" : "Over by"}</span>
              <span className="num font-semibold">{formatMoney(Math.abs(difference), currency)}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
