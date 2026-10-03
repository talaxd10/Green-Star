"use client";

// The office app's building blocks. Plain elements with one look, so every
// screen reads the same way.

import type { Currency } from "@green-star/contracts";
import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import type { ApiFailure } from "@/lib/api";
import { formatMoney } from "@/lib/money";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type Tone = "primary" | "plain" | "quiet" | "danger";

const TONES: Record<Tone, string> = {
  primary: "bg-green text-white border-green hover:bg-green-deep hover:border-green-deep",
  plain: "bg-surface text-ink border-rule-strong hover:border-ink",
  quiet: "bg-transparent text-muted border-transparent hover:bg-sunken hover:text-ink",
  danger: "bg-surface text-red border-red hover:bg-red-soft",
};

const BUTTON = "inline-flex items-center justify-center gap-2 rounded-md border font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";

export function Button({
  tone = "plain",
  small = false,
  busy = false,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; small?: boolean; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={cx(BUTTON, TONES[tone], small ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-sm", className)}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function LinkButton({ href, tone = "plain", small = false, children }: { href: string; tone?: Tone; small?: boolean; children: ReactNode }) {
  return (
    <Link href={href} className={cx(BUTTON, TONES[tone], small ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-sm")}>
      {children}
    </Link>
  );
}

export function Spinner() {
  return <span aria-hidden className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />;
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

const CONTROL = "rounded-md border bg-surface px-3 text-sm text-ink placeholder:text-faint disabled:bg-sunken disabled:text-muted";
const border = (problem?: string) => (problem ? "border-red" : "border-rule-strong hover:border-muted");

/** A control is 40px tall and fills its place unless the screen gives it its own height or width. */
function size(className: string | undefined, height = "h-10"): string {
  const given = ` ${className ?? ""}`;
  return cx(/\sh-/.test(given) ? null : height, /\sw-/.test(given) ? null : "w-full");
}

export function Field({
  label,
  hint,
  problem,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  problem?: string | undefined;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[13px] font-semibold text-ink">
        {label}
      </label>
      {children(id)}
      {problem ? (
        <p className="text-[13px] text-red" role="alert">
          {problem}
        </p>
      ) : hint ? (
        <p className="text-[13px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({ problem, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { problem?: string | undefined }) {
  return <input {...rest} aria-invalid={problem ? true : undefined} className={cx(CONTROL, size(className), border(problem), className)} />;
}

export function Select({ problem, className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { problem?: string | undefined }) {
  return (
    <select {...rest} aria-invalid={problem ? true : undefined} className={cx(CONTROL, size(className), border(problem), className)}>
      {children}
    </select>
  );
}

export function Textarea({ problem, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { problem?: string | undefined }) {
  return (
    <textarea
      rows={3}
      {...rest}
      aria-invalid={problem ? true : undefined}
      className={cx(CONTROL, size(className, "h-auto"), border(problem), "py-2 leading-snug", className)}
    />
  );
}

/** Why a save was refused, in the API's own words. Field problems show under their fields. */
export function Problem({ of }: { of: ApiFailure | null }) {
  if (of === null) return null;
  const general = Object.keys(of.fields).length === 0 || of.code !== "invalid_request";
  if (!general && of.fields._ === undefined) return null;
  return (
    <p className="rounded-md border border-red bg-red-soft px-3 py-2 text-sm text-red" role="alert">
      {of.fields._ ?? of.message}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Showing things
// ---------------------------------------------------------------------------

export type ChipTone = "green" | "amber" | "red" | "blue" | "grey";

const CHIPS: Record<ChipTone, string> = {
  green: "bg-green-soft text-green",
  amber: "bg-amber-soft text-amber-ink",
  red: "bg-red-soft text-red",
  blue: "bg-blue-soft text-blue",
  grey: "bg-sunken text-muted",
};

export function Chip({ tone = "grey", children }: { tone?: ChipTone; children: ReactNode }) {
  return (
    <span className={cx("num inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold", CHIPS[tone])}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

/** An amount, in the mono face so columns line up. Red when it is money missing. */
export function Money({ amount, currency = "USD", tone, className }: { amount: number; currency?: Currency; tone?: "red" | "muted" | "green"; className?: string }) {
  return (
    <span className={cx("num whitespace-nowrap", tone === "red" && "text-red", tone === "muted" && "text-muted", tone === "green" && "text-green", className)}>
      {formatMoney(amount, currency)}
    </span>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("rounded-xl border border-rule bg-surface shadow-card", className)}>{children}</section>;
}

export function CardHead({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-5 py-3.5">
      <div>
        <h2 className="display text-[17px] leading-tight">{title}</h2>
        {hint ? <p className="mt-0.5 text-[13px] text-muted">{hint}</p> : null}
      </div>
      {action}
    </header>
  );
}

/** One number that matters, with its name above it. */
export function Stat({ label, children, hint, tone }: { label: string; children: ReactNode; hint?: ReactNode; tone?: "red" | "amber" | "green" }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="eyebrow">{label}</span>
      <span className={cx("num text-[22px] font-semibold leading-tight", tone === "red" && "text-red", tone === "amber" && "text-amber-ink", tone === "green" && "text-green")}>
        {children}
      </span>
      {hint ? <span className="text-[13px] text-muted">{hint}</span> : null}
    </div>
  );
}

export function PageHead({ eyebrow, title, hint, children }: { eyebrow?: string; title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow mb-1">{eyebrow}</p> : null}
        <h1 className="display text-[30px] leading-none" dir="auto">
          {title}
        </h1>
        {hint ? <p className="mt-2 max-w-[70ch] text-sm text-muted">{hint}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </header>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <p className="display text-lg">{title}</p>
      {children ? <div className="max-w-[52ch] text-sm text-muted">{children}</div> : null}
    </div>
  );
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return (
    <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted">
      <Spinner /> {what}…
    </div>
  );
}

/** A read that failed. */
export function ReadProblem({ of }: { of: ApiFailure }) {
  return (
    <div className="m-5 rounded-md border border-red bg-red-soft px-4 py-3 text-sm text-red" role="alert">
      {of.message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={cx("w-full border-collapse text-sm", className)}>{children}</table>
    </div>
  );
}

export function Th({ children, right = false, className }: { children?: ReactNode; right?: boolean; className?: string }) {
  return (
    <th className={cx("eyebrow whitespace-nowrap border-b border-rule bg-sunken/60 px-4 py-2.5 font-medium", right ? "text-right" : "text-left", className)}>
      {children}
    </th>
  );
}

export function Td({ children, right = false, className, colSpan }: { children?: ReactNode; right?: boolean; className?: string; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={cx("border-b border-rule px-4 py-3 align-middle", right && "text-right", className)}>
      {children}
    </td>
  );
}

// ---------------------------------------------------------------------------
// Choosing between a few things
// ---------------------------------------------------------------------------

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string; count?: number | undefined }[];
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-rule bg-sunken p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx(
            "flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-semibold transition-colors",
            value === option.value ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink",
          )}
        >
          {option.label}
          {option.count !== undefined ? <span className="num text-[11px] text-faint">{option.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A window over the page
// ---------------------------------------------------------------------------

export function Dialog({
  open,
  onClose,
  title,
  hint,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();   // a click on the backdrop
      }}
      className={cx("w-[calc(100vw-2rem)] rounded-xl border border-rule-strong bg-surface p-0 text-ink shadow-pop", wide ? "max-w-3xl" : "max-w-lg")}
    >
      {open ? (
        <div className="flex max-h-[calc(100vh-4rem)] flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-rule px-6 py-4">
            <div>
              <h2 className="display text-xl leading-tight">{title}</h2>
              {hint ? <p className="mt-1 text-[13px] text-muted">{hint}</p> : null}
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 -mt-1 rounded-md p-2 text-muted hover:bg-sunken hover:text-ink">
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </header>
          <div className="overflow-y-auto px-6 py-5">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}

/** The Cancel and Save row at the bottom of a form. */
export function FormActions({ onCancel, saving, save = "Save", disabled = false, danger = false }: { onCancel: () => void; saving: boolean; save?: string; disabled?: boolean; danger?: boolean }) {
  return (
    <div className="mt-2 flex justify-end gap-2">
      <Button tone="quiet" onClick={onCancel} disabled={saving}>
        Cancel
      </Button>
      <Button type="submit" tone={danger ? "danger" : "primary"} busy={saving} disabled={disabled}>
        {save}
      </Button>
    </div>
  );
}

/** How much of his own limit a trusted customer has used. */
export function LimitBar({ balance, limit }: { balance: number; limit: number }) {
  const used = limit === 0 ? (balance > 0 ? 1 : 0) : Math.max(balance, 0) / limit;
  const over = balance > limit;
  return (
    <div className="flex items-center gap-2" title={`${formatMoney(Math.max(balance, 0), "USD")} of ${formatMoney(limit, "USD")}`}>
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-sunken">
        <div className={cx("h-full rounded-full", over ? "bg-red" : used > 0.8 ? "bg-amber" : "bg-green")} style={{ width: `${Math.min(used, 1) * 100}%` }} />
      </div>
      <span className={cx("num text-[11px]", over ? "font-semibold text-red" : "text-muted")}>{formatMoney(limit, "USD")}</span>
    </div>
  );
}

export { cx };
