"use client";

import type { Me, Page, RateToday } from "@green-star/contracts";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiFailure, newKey, withQuery } from "./api";

/** Reads an address and keeps it fresh. Pass null to wait. */
export function useGet<T>(url: string | null) {
  return useQuery<T, ApiFailure>({
    queryKey: [url],
    queryFn: () => api.get<T>(url as string),
    enabled: url !== null,
  });
}

/** Who is signed in. */
export function useMe() {
  return useGet<Me>("/v1/me");
}

export function useRateToday() {
  return useGet<RateToday>("/v1/fx-rates/today");
}

/** The text of a search box, a moment after the person stops typing. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export interface Save<TInput, TResult> {
  save: (input: TInput) => Promise<TResult | undefined>;
  saving: boolean;
  /** Why the last save was refused, or null. */
  problem: ApiFailure | null;
  /** What was wrong with one field: "received.amount". */
  fieldProblem: (name: string) => string | undefined;
  clear: () => void;
}

/**
 * One Save button.
 *
 * It holds the key for this click. If the connection drops and the person
 * clicks Save again, the same key goes with it, so the API does the work
 * once. After a save that went through, the next click gets a new key.
 */
export function useSave<TInput, TResult>(
  send: (input: TInput, key: string) => Promise<TResult>,
  onSaved?: (result: TResult) => void,
): Save<TInput, TResult> {
  const queryClient = useQueryClient();
  const key = useRef(newKey());
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<ApiFailure | null>(null);

  const save = useCallback(
    async (input: TInput) => {
      if (busy.current) return undefined;   // a second click while the first is on its way
      busy.current = true;
      setSaving(true);
      setProblem(null);
      try {
        const result = await send(input, key.current);
        key.current = newKey();
        // Money moved, so every number on every screen may have changed.
        await queryClient.invalidateQueries();
        onSaved?.(result);
        return result;
      } catch (error) {
        const failure = error instanceof ApiFailure ? error : new ApiFailure(0, { code: "unknown", message: String(error) });
        // A refusal means nothing was done. The mistake can be fixed and sent under a new key.
        if (failure.status !== 0) key.current = newKey();
        if (failure.status === 401) window.location.assign(`/sign-in?next=${encodeURIComponent(window.location.pathname)}`);
        setProblem(failure);
        return undefined;
      } finally {
        busy.current = false;
        setSaving(false);
      }
    },
    [send, onSaved, queryClient],
  );

  return {
    save,
    saving,
    problem,
    fieldProblem: (name) => problem?.fields[name],
    clear: () => setProblem(null),
  };
}

/** A list that comes a page at a time. `more()` fetches the next page and adds it to `items`. */
export function usePages<T>(url: string | null, limit = 50) {
  const query = useInfiniteQuery<Page<T>, ApiFailure>({
    queryKey: [url, "pages", limit],
    enabled: url !== null,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const base = url as string;
      const sep = base.includes("?") ? "&" : "?";
      return api.get<Page<T>>(`${base}${sep}${withQuery("", { limit, cursor: pageParam as string | null }).slice(1)}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  return {
    items: query.data?.pages.flatMap((page) => page.items) ?? [],
    loading: query.isLoading,
    error: query.error,
    hasMore: query.hasNextPage,
    more: () => void query.fetchNextPage(),
    loadingMore: query.isFetchingNextPage,
  };
}
