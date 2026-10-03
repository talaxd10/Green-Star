"use client";

import type { Action } from "@green-star/contracts";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useMe, useRateToday } from "@/lib/hooks";
import { ROLE } from "@/lib/labels";
import { formatRatePerDollar } from "@/lib/money";
import { icons, Star } from "./icons";
import { cx, Loading } from "./ui";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  /** Shown only to those who can do this. Everything else is shown to everyone who sees the books. */
  needs?: Action;
}

const NAV: NavItem[] = [
  { href: "/customers", label: "Customers", icon: icons.customers },
  { href: "/files", label: "Files", icon: icons.files },
  { href: "/rounds", label: "Rounds", icon: icons.rounds },
  { href: "/money", label: "Money", icon: icons.money },
  { href: "/vault", label: "Vault close", icon: icons.vault },
  { href: "/china", label: "China account", icon: icons.china },
  { href: "/settings", label: "Settings", icon: icons.settings },
];

function RateChip() {
  const rate = useRateToday();
  if (rate.data === undefined) return null;
  if (rate.data.rate === null) {
    return (
      <Link href="/money" className="num rounded-full bg-amber-soft px-3 py-1 text-[12px] font-semibold text-amber-ink hover:underline">
        Today&apos;s rate is not set
      </Link>
    );
  }
  return (
    <Link href="/money" className="num rounded-full border border-rule bg-surface px-3 py-1 text-[12px] text-muted hover:border-rule-strong" title="Today's dinar rate">
      Rate today <b className="font-semibold text-ink">{formatRatePerDollar(rate.data.rate.iqdPer100Usd)}</b> IQD per $1
    </Link>
  );
}

/** The frame around every screen: the rail on the left, today's rate on top. */
export function Shell({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (me.error?.status === 401) router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
    // The office monitor is a screen, not a person: it has nothing to do here.
    if (me.data?.user.role === "monitor") router.replace("/monitor");
  }, [me.error, me.data, router, pathname]);

  if (me.data === undefined || me.data.user.role === "monitor") {
    return (
      <div className="grid min-h-screen place-items-center">
        <Loading what="Opening the office" />
      </div>
    );
  }

  const signOut = async () => {
    await api.post("/v1/auth/logout").catch(() => {});
    window.location.assign("/sign-in");
  };

  return (
    <div className="grid min-h-screen grid-cols-[228px_minmax(0,1fr)]">
      <aside className="sticky top-0 flex h-screen flex-col bg-rail text-rail-ink">
        <Link href="/" className="flex items-center gap-2.5 px-5 pb-5 pt-6">
          <Star />
          <span className="display text-[19px] text-white">Green Star</span>
        </Link>
        <nav className="flex flex-1 flex-col gap-0.5 px-3" aria-label="Screens">
          {NAV.filter((item) => item.needs === undefined || me.data.can.includes(item.needs)).map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex h-10 items-center gap-3 rounded-md px-3 text-[14px] font-medium transition-colors",
                  active ? "bg-green text-white" : "text-rail-ink hover:bg-rail-hover",
                )}
              >
                <span className={active ? "text-white" : "text-rail-muted"}>{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-white/10 px-5 py-4">
          <p className="truncate text-[14px] font-semibold text-white" dir="auto">
            {me.data.user.name}
          </p>
          <p className="num text-[11px] uppercase tracking-wider text-rail-muted">
            {ROLE[me.data.user.role]}
            {me.data.user.role === "owner" ? " · read only" : ""}
          </p>
          <button type="button" onClick={signOut} className="mt-3 flex items-center gap-2 text-[13px] text-rail-muted hover:text-white">
            {icons.out} Sign out
          </button>
        </div>
      </aside>
      <div className="min-w-0">
        <div className="sticky top-0 z-10 flex h-12 items-center justify-end gap-3 border-b border-rule bg-paper/90 px-8 backdrop-blur">
          <RateChip />
        </div>
        <main className="mx-auto w-full max-w-[1240px] px-8 pb-16 pt-7">{children}</main>
      </div>
    </div>
  );
}
