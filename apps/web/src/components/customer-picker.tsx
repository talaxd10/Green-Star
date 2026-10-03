"use client";

import type { CustomerSummary, Page } from "@green-star/contracts";
import { useState } from "react";
import { withQuery } from "@/lib/api";
import { useDebounced, useGet } from "@/lib/hooks";
import { phone, TRUST } from "@/lib/labels";
import { Chip, cx, Input, Money } from "./ui";

/** Finds a customer by phone, mark or name, the same three ways the files do. */
export function CustomerPicker({
  id,
  value,
  onChange,
  problem,
  autoFocus = false,
}: {
  id?: string;
  value: CustomerSummary | null;
  onChange: (customer: CustomerSummary | null) => void;
  problem?: string | undefined;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const q = useDebounced(text.trim(), 200);
  const found = useGet<Page<CustomerSummary>>(open && q.length >= 2 ? withQuery("/v1/customers", { q, limit: 8 }) : null);

  if (value !== null) {
    return (
      <div className={cx("flex h-10 items-center justify-between gap-3 rounded-md border bg-sunken px-3 text-sm", problem ? "border-red" : "border-rule-strong")}>
        <span className="flex min-w-0 items-center gap-2">
          <b className="truncate font-semibold" dir="auto">
            {value.name}
          </b>
          <span className="num text-[12px] text-muted">{phone(value.phone)}</span>
          <Chip tone={TRUST[value.trust].tone}>{TRUST[value.trust].label}</Chip>
        </span>
        <button
          type="button"
          className="text-[13px] font-semibold text-green hover:underline"
          onClick={() => {
            onChange(null);
            setText("");
          }}
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Input
        id={id}
        autoFocus={autoFocus}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        placeholder="Phone, mark or name"
        value={text}
        problem={problem}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
      />
      {open && q.length >= 2 ? (
        <ul id={`${id}-list`} role="listbox" className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-rule-strong bg-surface py-1 shadow-pop">
          {found.data === undefined ? (
            <li className="px-3 py-2 text-sm text-muted">Looking…</li>
          ) : found.data.items.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted">Nobody matches &ldquo;{q}&rdquo;.</li>
          ) : (
            found.data.items.map((customer) => (
              <li key={customer.id} role="option" aria-selected={false}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-sunken"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(customer);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0">
                    <b className="block truncate font-semibold" dir="auto">
                      {customer.name}
                    </b>
                    <span className="num text-[12px] text-muted">
                      {[phone(customer.phone), ...customer.marks.slice(0, 2)].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <Money amount={customer.balanceUsdCents} tone={customer.balanceUsdCents > 0 ? undefined : "muted"} className="text-[13px]" />
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
