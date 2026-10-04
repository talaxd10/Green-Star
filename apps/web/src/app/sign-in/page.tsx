"use client";

import type { Me } from "@green-star/contracts";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { Star } from "@/components/icons";
import { Button, Field, Input, Problem } from "@/components/ui";
import { api, ApiFailure } from "@/lib/api";

function SignIn() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiFailure | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await api.post<Me>("/v1/auth/login", { phone, password });
      // Only ever back to a screen of this app, never to another site.
      router.replace(next !== null && next.startsWith("/") && !next.startsWith("//") ? next : "/");
    } catch (error) {
      setProblem(error instanceof ApiFailure ? error : new ApiFailure(0, { message: String(error) }));
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-screen grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <section className="hidden flex-col justify-between bg-rail p-12 text-rail-ink lg:flex">
        <div className="flex items-center gap-3">
          <Star size={28} />
          <span className="display text-2xl text-white">Green Star</span>
        </div>
        <div>
          <p className="display max-w-[14ch] text-[52px] leading-[0.98] text-white">The office, in one place.</p>
          <p className="mt-5 max-w-[38ch] text-[15px] text-rail-muted">Customers, files from China, rounds, payments in dollars and dinars, and the vault. Straight accounts, to the cent.</p>
        </div>
        <p className="num text-[11px] uppercase tracking-widest text-rail-muted">Erbil</p>
      </section>

      <section className="grid place-items-center p-6">
        <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-5" noValidate>
          <div className="mb-1 flex items-center gap-2.5 lg:hidden">
            <Star />
            <span className="display text-xl">Green Star</span>
          </div>
          <div>
            <h1 className="display text-[30px] leading-none">Sign in</h1>
            <p className="mt-2 text-sm text-muted">With the phone number on your account.</p>
          </div>
          <Field label="Phone number" problem={problem?.fields.phone}>
            {(id) => (
              <Input id={id} name="phone" autoComplete="username" inputMode="tel" autoFocus value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0770 123 4567" problem={problem?.fields.phone} />
            )}
          </Field>
          <Field label="Password" problem={problem?.fields.password}>
            {(id) => <Input id={id} name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} problem={problem?.fields.password} />}
          </Field>
          <Problem of={problem} />
          <Button type="submit" tone="primary" busy={busy} disabled={phone.trim() === "" || password === ""}>
            Sign in
          </Button>
        </form>
      </section>
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignIn />
    </Suspense>
  );
}
