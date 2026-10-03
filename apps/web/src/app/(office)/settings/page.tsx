"use client";

import type { Carrier, Driver, UserList, UserWithSessions } from "@green-star/contracts";
import { useState, type FormEvent } from "react";
import { useToast } from "@/components/toast";
import { Button, Card, CardHead, Chip, Dialog, Empty, Field, FormActions, Input, Loading, PageHead, Problem, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useCan, useGet, useMe, useSave } from "@/lib/hooks";
import { dayTime, phone, ROLE } from "@/lib/labels";

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

function NewUser({ onClose }: { onClose: () => void }) {
  const [role, setRole] = useState<"owner" | "monitor">("owner");
  const [name, setName] = useState("");
  const [signIn, setSignIn] = useState("");
  const [password, setPassword] = useState("");
  const add = useSave((body: unknown, key: string) => api.post<UserWithSessions>("/v1/users", body, key), onClose);
  return (
    <Dialog open onClose={onClose} title="Add an account" hint="The owner sees every screen and changes nothing. The monitor is the office screen and shows only what you choose.">
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void add.save(role === "owner" ? { role, name, phone: signIn, password } : { role, name, signInName: signIn, password });
        }}
      >
        <Field label="Account for">
          {(id) => (
            <Select id={id} value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="owner">The owner</option>
              <option value="monitor">The office monitor</option>
            </Select>
          )}
        </Field>
        <Field label="Name" problem={add.fieldProblem("name")}>
          {(id) => <Input id={id} dir="auto" value={name} onChange={(e) => setName(e.target.value)} placeholder={role === "owner" ? "Kak Azad" : "Office TV"} />}
        </Field>
        {role === "owner" ? (
          <Field label="Phone number" hint="He signs in with it." problem={add.fieldProblem("phone") ?? (add.problem?.code === "phone_taken" ? add.problem.message : undefined)}>
            {(id) => <Input id={id} inputMode="tel" value={signIn} onChange={(e) => setSignIn(e.target.value)} placeholder="0770 123 4567" />}
          </Field>
        ) : (
          <Field label="Sign-in name" hint="The screen signs in with this instead of a phone: office-tv" problem={add.fieldProblem("signInName") ?? (add.problem?.code === "name_taken" ? add.problem.message : undefined)}>
            {(id) => <Input id={id} className="num lowercase" value={signIn} onChange={(e) => setSignIn(e.target.value)} placeholder="office-tv" />}
          </Field>
        )}
        <Field label="Password" hint="At least 10 characters. Tell it to him yourself." problem={add.fieldProblem("password")}>
          {(id) => <Input id={id} type="text" autoComplete="off" className="num" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Problem of={add.problem} />
        <FormActions onCancel={onClose} saving={add.saving} save="Add the account" disabled={name.trim() === "" || signIn.trim() === "" || password.length < 10} />
      </form>
    </Dialog>
  );
}

function SetPassword({ user, onClose }: { user: UserWithSessions; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const set = useSave((body: unknown, key: string) => api.patch(`/v1/users/${user.id}`, body, key), onClose);
  return (
    <Dialog open onClose={onClose} title={`New password for ${user.name}`} hint="He is signed out on every device and signs in again with this one.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void set.save({ password });
        }}
      >
        <Field label="New password" hint="At least 10 characters." problem={set.fieldProblem("password")}>
          {(id) => <Input id={id} type="text" autoComplete="off" autoFocus className="num" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Problem of={set.problem} />
        <FormActions onCancel={onClose} saving={set.saving} save="Set the password" disabled={password.length < 10} />
      </form>
    </Dialog>
  );
}

function Users() {
  const users = useGet<UserList>("/v1/users");
  const me = useMe();
  const [adding, setAdding] = useState(false);
  const [passwordFor, setPasswordFor] = useState<UserWithSessions | null>(null);
  const change = useSave(({ id, body }: { id: string; body: unknown }, key: string) => api.patch(`/v1/users/${id}`, body, key));
  const signOut = useSave((sessionId: string, key: string) => api.del(`/v1/sessions/${sessionId}`, key));

  return (
    <Card>
      <CardHead
        title="Accounts"
        hint="Who can sign in, and the devices each one is signed in on."
        action={
          <Button small onClick={() => setAdding(true)}>
            Add an account
          </Button>
        }
      />
      {users.data === undefined ? (
        <Loading />
      ) : (
        <ul className="divide-y divide-rule">
          {users.data.users.map((user) => (
            <li key={user.id} className="px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <b className="font-semibold" dir="auto">{user.name}</b>
                    <Chip tone={user.role === "ceo" ? "green" : user.role === "owner" ? "blue" : "grey"}>{ROLE[user.role]}</Chip>
                    {!user.active ? <Chip tone="red">Switched off</Chip> : null}
                  </p>
                  <p className="num mt-0.5 text-[13px] text-muted">{user.phone ? phone(user.phone) : user.signInName}</p>
                </div>
                <div className="flex gap-2">
                  <Button small onClick={() => setPasswordFor(user)}>
                    New password
                  </Button>
                  {user.id !== me.data?.user.id ? (
                    <Button small tone={user.active ? "danger" : "plain"} busy={change.saving} onClick={() => void change.save({ id: user.id, body: { active: !user.active } })}>
                      {user.active ? "Switch off" : "Switch on"}
                    </Button>
                  ) : null}
                </div>
              </div>
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
      <div className="px-5 pb-4"><Problem of={change.problem ?? signOut.problem} /></div>
      {adding ? <NewUser onClose={() => setAdding(false)} /> : null}
      {passwordFor ? <SetPassword user={passwordFor} onClose={() => setPasswordFor(null)} /> : null}
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
  const canChange = useCan("enter_money");
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
              {canChange ? (
                <button type="button" className="text-[13px] font-semibold text-muted hover:text-ink hover:underline" onClick={() => void change.save({ id: item.id, body: { active: !item.active } })}>
                  {item.active ? "Switch off" : "Switch on"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canChange ? (
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
      ) : null}
    </Card>
  );
}

export default function SettingsPage() {
  const canManage = useCan("manage_users");
  return (
    <>
      <PageHead title="Settings" hint="Accounts, the people who carry the goods, and your own password." />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="flex flex-col gap-5">
          {canManage ? <Users /> : null}
          <MyPassword />
        </div>
        <div className="flex flex-col gap-5">
          <People kind="drivers" />
          <People kind="carriers" />
        </div>
      </div>
    </>
  );
}
