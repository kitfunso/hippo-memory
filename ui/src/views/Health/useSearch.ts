import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchSearch, isAbort } from "../../api/client";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import type { SearchResult } from "../../types";
import type { SnapshotClock } from "./usePanel";

export const SEARCH_DEBOUNCE_MS = 200;
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 200;

/** Where a search stands for the query currently typed. */
export type SearchStatus = "idle" | "searching" | "done" | "error";

export interface SearchState {
  input: string;
  setInput: (value: string) => void;
  clear: () => void;
  /** The trimmed query the results belong to, or "" when no search is active. */
  query: string;
  status: SearchStatus;
  result: SearchResult | null;
  /** Memories matched per project key; null when no search has results for the typed query. */
  hits: ReadonlyMap<string, number> | null;
  error: string | null;
}

interface Settled {
  q: string;
  result: SearchResult | null;
  error: string | null;
}

/** Debounced, abortable search; only a response for the query now typed is ever exposed, and a newer snapshot refetches it. */
export function useSearch(clock: SnapshotClock): SearchState {
  const [input, setInput] = useState("");
  const debounced = useDebouncedValue(input, SEARCH_DEBOUNCE_MS);
  const [settled, setSettled] = useState<Settled | null>(null);
  const [nonce, setNonce] = useState(0);
  const { report, epoch } = clock;

  const typed = input.trim();
  const sent = debounced.trim();
  const valid = (q: string) => q.length >= SEARCH_MIN && q.length <= SEARCH_MAX;

  useEffect(() => {
    if (!valid(sent)) return;
    const ctrl = new AbortController();
    fetchSearch(sent, { signal: ctrl.signal })
      .then((result) => {
        if (ctrl.signal.aborted) return;
        if (!report(result.snapshotId)) {
          setNonce((n) => n + 1);
          return;
        }
        setSettled({ q: sent, result, error: null });
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted || isAbort(err)) return;
        setSettled({ q: sent, result: null, error: err.message });
      });
    return () => ctrl.abort();
  }, [sent, report, epoch, nonce]);

  const clear = useCallback(() => setInput(""), []);

  const current = valid(typed) && settled !== null && settled.q === typed ? settled : null;
  const status: SearchStatus = !valid(typed) ? "idle" : current === null ? "searching" : current.error ? "error" : "done";
  const result = current?.result ?? null;

  const hits = useMemo(() => {
    if (!result) return null;
    const map = new Map<string, number>(Object.entries(result.hits));
    if (result.total === 0) for (const m of result.nameMatches) map.set(m.key, m.live);
    return map;
  }, [result]);

  return { input, setInput, clear, query: current ? typed : "", status, result, hits, error: current?.error ?? null };
}
