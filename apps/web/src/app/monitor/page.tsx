"use client";

// The office monitor: a full-screen, read-only display for the office TV.
// It shows only the widgets the CEO chose, never money, and refreshes itself.

import type { Me, Monitor, MonitorFile, MonitorHeld, MonitorRound, MonitorWidget } from "@green-star/contracts";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { Star } from "@/components/icons";
import { api, ApiFailure } from "@/lib/api";
import { SHIPMENT } from "@/lib/labels";

const REFRESH_MS = 30_000;
const BAGHDAD = "Asia/Baghdad";
const clockFormat = new Intl.DateTimeFormat("en-GB", { timeZone: BAGHDAD, hour: "2-digit", minute: "2-digit", hour12: false });
const dateFormat = new Intl.DateTimeFormat("en-GB", { timeZone: BAGHDAD, weekday: "long", day: "numeric", month: "long" });
const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: BAGHDAD, hour: "2-digit", minute: "2-digit", hour12: false });
const shortDay = new Intl.DateTimeFormat("en-GB", { timeZone: BAGHDAD, day: "numeric", month: "short" });

function Bar({ done, of }: { done: number; of: number }) {
  const part = of === 0 ? 0 : Math.min(done / of, 1);
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
      <div className="h-full rounded-full bg-[#6dcb9a]" style={{ width: `${part * 100}%` }} />
    </div>
  );
}

function Panel({ title, count, empty, children }: { title: string; count: number; empty: string; children: ReactNode }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-col rounded-2xl bg-rail-hover" aria-label={title}>
      <header className="flex items-baseline justify-between gap-4 border-b border-white/10 px-7 py-5">
        <h2 className="display text-[30px] leading-none text-white">{title}</h2>
        <span className="num text-[30px] font-semibold leading-none text-[#6dcb9a]">{count}</span>
      </header>
      {count === 0 ? <p className="px-7 py-8 text-[20px] text-rail-muted">{empty}</p> : <ul className="flex min-h-0 flex-col divide-y divide-white/10 overflow-hidden">{children}</ul>}
    </section>
  );
}

function Files({ files }: { files: MonitorFile[] }) {
  return (
    <Panel title="Files" count={files.length} empty="No files in progress.">
      {files.map((f) => (
        <li key={f.code} className="flex flex-col gap-2.5 px-7 py-4">
          <div className="flex items-baseline justify-between gap-4">
            <span className="num text-[24px] font-semibold text-white">{f.code}</span>
            <span className="text-[17px] text-rail-muted">{SHIPMENT[f.status].label}</span>
          </div>
          <Bar done={f.delivered} of={f.consignments} />
          <span className="text-[17px] text-rail-ink">
            <b className="num font-semibold">{f.delivered}</b> of <b className="num font-semibold">{f.consignments}</b> customers have their goods
          </span>
        </li>
      ))}
    </Panel>
  );
}

const ROUND_WORD: Record<MonitorRound["status"], string> = { planned: "Loading", out: "Out", returned: "Back" };

function Rounds({ rounds }: { rounds: MonitorRound[] }) {
  return (
    <Panel title="Rounds" count={rounds.length} empty="No rounds out.">
      {rounds.map((r) => (
        <li key={r.number} className="flex flex-col gap-2.5 px-7 py-4">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-[24px] font-semibold text-white">
              Round <span className="num">{r.number}</span>
            </span>
            <span className="text-[17px] text-rail-muted">
              {ROUND_WORD[r.status]}
              {r.status === "out" && r.leftAt !== null ? ` since ${timeFormat.format(new Date(r.leftAt))}` : ""}
            </span>
          </div>
          <span className="truncate text-[19px] text-rail-ink" dir="auto">
            {r.carriedBy}
          </span>
          <Bar done={r.done} of={r.stops} />
          <span className="text-[17px] text-rail-ink">
            <b className="num font-semibold">{r.done}</b> of <b className="num font-semibold">{r.stops}</b> stops done
          </span>
        </li>
      ))}
    </Panel>
  );
}

function Held({ held, now }: { held: MonitorHeld[]; now: number }) {
  return (
    <Panel title="Held in the car" count={held.length} empty="Nothing is held.">
      {held.map((h, index) => {
        const days = h.heldSince === null ? null : Math.floor((now - Date.parse(h.heldSince)) / 86_400_000);
        return (
          <li key={`${h.shipmentCode}-${h.customerName}-${index}`} className="flex items-baseline justify-between gap-4 px-7 py-4">
            <div className="min-w-0">
              <p className="truncate text-[22px] font-semibold text-white" dir="auto">
                {h.customerName}
              </p>
              <p className="text-[17px] text-rail-muted">
                <span className="num">{h.shipmentCode}</span>
                {h.city ? ` · ${h.city}` : ""}
              </p>
            </div>
            {h.heldSince !== null ? (
              <span className="shrink-0 text-right text-[17px] text-rail-ink">
                since {shortDay.format(new Date(h.heldSince))}
                {days !== null && days >= 1 ? <span className="num block text-[#f0b13a]">{days === 1 ? "1 day" : `${days} days`}</span> : null}
              </span>
            ) : null}
          </li>
        );
      })}
    </Panel>
  );
}

const COLUMNS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3" };

export default function MonitorPage() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  const me = useQuery<Me, ApiFailure>({ queryKey: ["/v1/me"], queryFn: () => api.get<Me>("/v1/me") });
  const screen = useQuery<Monitor, ApiFailure>({
    queryKey: ["/v1/monitor"],
    queryFn: () => api.get<Monitor>("/v1/monitor"),
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: true,
  });

  const signOut = async () => {
    await api.post("/v1/auth/logout").catch(() => {});
    window.location.assign("/sign-in");
  };

  const widgets: MonitorWidget[] = screen.data?.widgets ?? [];
  const stale = screen.error !== null && screen.data !== undefined;

  return (
    <div className="flex h-screen flex-col gap-6 overflow-hidden bg-rail p-8 text-rail-ink">
      <header className="flex items-center justify-between gap-6">
        <div className="flex items-center gap-3.5">
          <Star size={34} />
          <span className="display text-[32px] leading-none text-white">Green Star</span>
        </div>
        <div className="flex items-baseline gap-5">
          <span className="text-[22px] text-rail-muted">{dateFormat.format(now)}</span>
          <span className="num text-[44px] font-semibold leading-none text-white" aria-label="Time in Baghdad">
            {clockFormat.format(now)}
          </span>
        </div>
      </header>

      {screen.data === undefined ? (
        <p className="m-auto text-[22px] text-rail-muted" role={screen.error ? "alert" : "status"}>
          {screen.error ? (screen.error.status === 403 ? "This account cannot open the office screen." : "Cannot reach the office system. Trying again.") : "Opening the office screen…"}
        </p>
      ) : widgets.length === 0 ? (
        <p className="m-auto max-w-[40ch] text-center text-[22px] text-rail-muted">Nothing is chosen for this screen yet. The CEO picks what it shows in Settings.</p>
      ) : (
        <main className={`grid min-h-0 flex-1 gap-6 ${COLUMNS[widgets.length] ?? "grid-cols-3"}`}>
          {widgets.map((widget) =>
            widget === "files" ? (
              <Files key={widget} files={screen.data.files ?? []} />
            ) : widget === "rounds" ? (
              <Rounds key={widget} rounds={screen.data.rounds ?? []} />
            ) : (
              <Held key={widget} held={screen.data.held ?? []} now={now} />
            ),
          )}
        </main>
      )}

      <footer className="flex items-center justify-between gap-6 text-[14px] text-rail-muted">
        <span role="status">
          {stale ? "No connection. Showing what was last received." : screen.data ? `Updated ${timeFormat.format(new Date(screen.data.at))}` : ""}
        </span>
        <span className="flex items-center gap-5">
          {me.data !== undefined && me.data.user.role !== "monitor" ? (
            <Link href="/today" className="hover:text-white hover:underline">
              Back to the office
            </Link>
          ) : null}
          <button type="button" onClick={signOut} className="hover:text-white hover:underline">
            Sign out
          </button>
        </span>
      </footer>
    </div>
  );
}
