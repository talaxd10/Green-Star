"use client";

import type { Currency } from "@green-star/contracts";
import { useEffect, useState } from "react";
import { countNotes, formatMoney, parseAmount } from "@/lib/money";
import { cx } from "./ui";

/**
 * Cash counted as one amount per currency (Tala, 28 October: "just dollar
 * and dinar"). He types what he counted; the system shows it beside what
 * should be there. It is sent as a count of the smallest unit, {"1": amount}.
 */
export function NoteCounter({
  currency,
  notes,
  onChange,
  expected,
}: {
  currency: Currency;
  notes: Record<string, number>;
  onChange: (notes: Record<string, number>) => void;
  /** What the receipts, or the ledger, say should be there. */
  expected: number;
}) {
  const [typed, setTyped] = useState("");
  const counted = countNotes(notes);
  const difference = counted - expected;
  const parsed = typed.trim() === "" ? 0 : parseAmount(typed, currency);

  // Cleared from outside (after a save): clear the box too.
  useEffect(() => {
    if (counted === 0 && parsed !== null && parsed !== 0) setTyped("");
  }, [counted, parsed]);

  const set = (text: string) => {
    setTyped(text);
    const amount = text.trim() === "" ? 0 : parseAmount(text, currency);
    onChange(amount !== null && amount > 0 ? { "1": amount } : {});
  };

  const word = currency === "USD" ? "dollars" : "dinars";
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between px-5 pb-2 pt-4">
        <h3 className="display text-[17px]">{currency === "USD" ? "Dollars" : "Dinars"}</h3>
        <span className="text-[13px] text-muted">
          should be <b className="num font-semibold text-ink">{formatMoney(expected, currency)}</b>
        </span>
      </div>
      <div className="px-5 pb-1">
        <label htmlFor={`${currency}-counted`} className="mb-1.5 block text-sm font-semibold">
          Counted, in {word}
        </label>
        <input
          id={`${currency}-counted`}
          inputMode={currency === "USD" ? "decimal" : "numeric"}
          className={cx(
            "num h-10 w-full rounded-md border bg-surface px-3 text-right text-base hover:border-muted",
            parsed === null ? "border-red" : "border-rule-strong",
          )}
          value={typed}
          placeholder={currency === "USD" ? "0.00" : "0"}
          onChange={(e) => set(e.target.value)}
        />
        {parsed === null ? (
          <p className="mt-1 text-[13px] text-red">{currency === "IQD" ? "Dinars are whole numbers" : "That is not an amount"}</p>
        ) : null}
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
