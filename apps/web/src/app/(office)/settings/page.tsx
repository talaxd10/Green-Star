"use client";

import type { Carrier, Driver, Settings, UserList } from "@green-star/contracts";
import { useState, type FormEvent } from "react";
import { useToast } from "@/components/toast";
import { Button, Card, CardHead, Chip, Dialog, Empty, Field, FormActions, Input, Loading, PageHead, Problem, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useGet, useSave } from "@/lib/hooks";
import { dayTime, phone } from "@/lib/labels";

function MyPassword() {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const change = useSave(
    (body: unknown) => api.post("/v1/auth/password", body),
    () => {
      toast("Password changed. Your other devices are signed out.");
      setCurrent("");
      setNext("");
    },
  );
  return (
    <Card>
      <CardHead title="My password" hint="Changing it signs out every other device you are signed in on." />
      <form
        className="flex max-w-md flex-col gap-4 p-5"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void change.save({ current, next });
        }}
      >
        <Field label="Current password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
        <Field label="New password" hint="At least 10 characters." problem={change.fieldProblem("next")}>
          {(id) => <Input id={id} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} problem={change.fieldProblem("next")} />}
        </Field>
        <Problem of={change.problem} />
        <div>
          <Button type="submit" busy={change.saving} disabled={current === "" || next.length < 10}>
            Change my password
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** The account and the devices it is signed in on. There is one kind of account: the CEO's. */
function Devices() {
  const users = useGet<UserList>("/v1/users");
  const signOut = useSave((sessionId: string, key: string) => api.del(`/v1/sessions/${sessionId}`, key));

  return (
    <Card>
      <CardHead title="Signed-in devices" hint="Every phone and computer this account is signed in on. Sign out one you no longer use, or one that is lost." />
      {users.data === undefined ? (
        <Loading />
      ) : (
        <ul className="divide-y divide-rule">
          {users.data.users.map((user) => (
            <li key={user.id} className="px-5 py-4">
              <p className="font-semibold" dir="auto">
                {user.name}
              </p>
              <p className="num mt-0.5 text-[13px] text-muted">{phone(user.phone)}</p>
              {user.sessions.length > 0 ? (
                <ul className="mt-3 flex flex-col gap-1.5">
                  {user.sessions.map((session) => (
                    <li key={session.id} className="flex items-center justify-between gap-3 rounded-md bg-sunken/60 px-3 py-1.5 text-[13px]">
                      <span className="min-w-0 truncate text-muted" title={session.device ?? undefined}>
                        {deviceName(session.device)} · last used {dayTime(session.lastSeenAt)}
                        {session.current ? <b className="ml-2 font-semibold text-green">this device</b> : null}
                      </span>
                      {!session.current ? (
                        <button type="button" className="shrink-0 font-semibold text-red hover:underline" onClick={() => void signOut.save(session.id)}>
                          Sign out
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[13px] text-faint">Not signed in anywhere.</p>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="px-5 pb-4">
        <Problem of={signOut.problem} />
      </div>
    </Card>
  );
}

/** "Chrome on Windows" out of what the browser calls itself. */
function deviceName(agent: string | null): string {
  if (!agent) return "Unknown device";
  const browser = /Edg\//.test(agent) ? "Edge" : /Chrome\//.test(agent) ? "Chrome" : /Firefox\//.test(agent) ? "Firefox" : /Safari\//.test(agent) ? "Safari" : "A browser";
  const system = /Windows/.test(agent) ? "Windows" : /Android/.test(agent) ? "Android" : /iPhone|iPad/.test(agent) ? "iPhone" : /Mac OS X/.test(agent) ? "Mac" : /Linux/.test(agent) ? "Linux" : "";
  return system ? `${browser} on ${system}` : browser;
}

function People({ kind }: { kind: "drivers" | "carriers" }) {
  const list = useGet<{ items: (Driver | Carrier)[] }>(`/v1/${kind}`);
  const [name, setName] = useState("");
  const [extra, setExtra] = useState("");
  const [carrierKind, setCarrierKind] = useState("transport_office");
  const add = useSave(
    (body: unknown, key: string) => api.post(`/v1/${kind}`, body, key),
    () => {
      setName("");
      setExtra("");
    },
  );
  const change = useSave(({ id, body }: { id: string; body: unknown }, key: string) => api.patch(`/v1/${kind}/${id}`, body, key));
  const drivers = kind === "drivers";

  return (
    <Card>
      <CardHead title={drivers ? "Drivers" : "Our cars and transport offices"} hint={drivers ? "Each driver is a named person with his own cash on each round. He has no login." : "A transport office in another city carries a round and collects, like a driver does."} />
      {list.data === undefined ? (
        <Loading />
      ) : list.data.items.length === 0 ? (
        <Empty title={drivers ? "No drivers yet" : "None yet"} />
      ) : (
        <ul className="divide-y divide-rule">
          {list.data.items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
              <span className={item.active ? "" : "text-faint line-through"}>
                <b className="font-semibold" dir="auto">{item.name}</b>
                <span className="num ml-2 text-[13px] text-muted">{"phone" in item ? phone(item.phone) : [item.kind === "own_car" ? "our car" : "transport office", item.city].filter(Boolean).join(" · ")}</span>
              </span>
              <button type="button" className="text-[13px] font-semibold text-muted hover:text-ink hover:underline" onClick={() => void change.save({ id: item.id, body: { active: !item.active } })}>
                {item.active ? "Switch off" : "Switch on"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-start gap-2 border-t border-rule p-5"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void add.save(drivers ? { name, ...(extra.trim() === "" ? {} : { phone: extra }) } : { name, kind: carrierKind, ...(extra.trim() === "" ? {} : { city: extra }) });
        }}
      >
        <Input aria-label="Name" className="w-48" dir="auto" placeholder={drivers ? "Driver's name" : "Name"} value={name} onChange={(e) => setName(e.target.value)} />
        <Input aria-label={drivers ? "Phone" : "City"} className="w-44" placeholder={drivers ? "Phone, optional" : "City, optional"} value={extra} onChange={(e) => setExtra(e.target.value)} problem={add.fieldProblem("phone")} />
        {!drivers ? (
          <Select aria-label="Kind" className="w-44" value={carrierKind} onChange={(e) => setCarrierKind(e.target.value)}>
            <option value="transport_office">Transport office</option>
            <option value="own_car">Our own car</option>
          </Select>
        ) : null}
        <Button type="submit" busy={add.saving} disabled={name.trim() === ""}>
          Add
        </Button>
        <div className="w-full"><Problem of={add.problem ?? change.problem} /></div>
      </form>
    </Card>
  );
}

/** The numbers the checks work from. */
function Checks() {
  const toast = useToast();
  const settings = useGet<Settings>("/v1/settings");
  const [draft, setDraft] = useState<{ held?: string; close?: string; wallet?: string }>({});
  const save = useSave(
    (body: unknown, key: string) => api.put<Settings>("/v1/settings", body, key),
    () => {
      toast("Settings saved");
      setDraft({});
    },
  );
  if (settings.data === undefined) {
    return (
      <Card>
        <CardHead title="Checks" />
        <Loading />
      </Card>
    );
  }
  const s = settings.data;
  const held = draft.held ?? String(s.heldInCarDays);
  const close = draft.close ?? s.vaultCloseTime;
  const wallet = draft.wallet ?? String(s.walletCheckDays);
  const days = (typed: string) => (/^\d{1,2}$/.test(typed.trim()) && Number(typed) >= 1 && Number(typed) <= 60 ? Number(typed) : null);
  const body = {
    ...(days(held) !== null && days(held) !== s.heldInCarDays ? { heldInCarDays: days(held) } : {}),
    ...(/^([01]\d|2[0-3]):[0-5]\d$/.test(close) && close !== s.vaultCloseTime ? { vaultCloseTime: close } : {}),
    ...(days(wallet) !== null && days(wallet) !== s.walletCheckDays ? { walletCheckDays: days(wallet) } : {}),
  };
  const closeOk = /^([01]\d|2[0-3]):[0-5]\d$/.test(close);
  const valid = days(held) !== null && days(wallet) !== null && closeOk;

  return (
    <Card>
      <CardHead title="Checks" hint="When the system raises an alert by itself." />
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void save.save(body);
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Held in the car, days" hint="Goods held longer raise an alert." problem={save.fieldProblem("heldInCarDays") ?? (days(held) === null ? "1 to 60" : undefined)}>
            {(id) => <Input id={id} className="num" inputMode="numeric" value={held} onChange={(e) => setDraft({ ...draft, held: e.target.value })} />}
          </Field>
          <Field label="Vault closing time" hint="Baghdad time, 24-hour. The reminder starts here." problem={save.fieldProblem("vaultCloseTime") ?? (closeOk ? undefined : "Like 18:00")}>
            {(id) => <Input id={id} className="num" inputMode="numeric" placeholder="18:00" value={close} onChange={(e) => setDraft({ ...draft, close: e.target.value })} />}
          </Field>
          <Field label="Wallet check, days" hint="How long wallet money may wait." problem={save.fieldProblem("walletCheckDays") ?? (days(wallet) === null ? "1 to 60" : undefined)}>
            {(id) => <Input id={id} className="num" inputMode="numeric" value={wallet} onChange={(e) => setDraft({ ...draft, wallet: e.target.value })} />}
          </Field>
        </div>
        <Problem of={save.problem} />
        <div>
          <Button type="submit" busy={save.saving} disabled={!valid || Object.keys(body).length === 0}>
            Save the checks
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <>
      <PageHead title="Settings" hint="The checks, the people who carry the goods, your password and the devices you are signed in on." />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="flex flex-col gap-5">
          <Checks />
          <MyPassword />
          <Devices />
        </div>
        <div className="flex flex-col gap-5">
          <People kind="drivers" />
          <People kind="carriers" />
        </div>
      </div>
    </>
  );
}
