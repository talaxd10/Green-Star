"use client";

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ApiFailure } from "@/lib/api";
import { ToastProvider } from "./toast";

/** A session that ended while a screen was open sends the person back to sign in. */
function signedOut(error: unknown): void {
  if (error instanceof ApiFailure && error.status === 401 && !window.location.pathname.startsWith("/sign-in")) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.assign(`/sign-in?next=${next}`);
  }
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: signedOut }),
        mutationCache: new MutationCache({ onError: signedOut }),
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            // A refusal is an answer, not a failure to retry. Only a dropped connection is tried again.
            retry: (count, error) => error instanceof ApiFailure && error.status === 0 && count < 2,
            refetchOnWindowFocus: true,
          },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
