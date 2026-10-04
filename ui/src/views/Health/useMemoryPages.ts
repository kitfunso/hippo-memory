import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { type MemoryPageQuery, errorMessage, fetchMemoryPage, isAbort, memoryPageQueryString } from "../../api/client";
import type { DecayOutlook, MemoryPage, MemoryRow } from "../../types";
import type { SnapshotClock } from "./usePanel";

/** Rows per server page. */
export const PAGE_SIZE = 100;

/** The memory page query without its paging fields. */
export type PageFilters = Omit<MemoryPageQuery, "offset" | "limit">;

/** What a table row has right now: its memory, a placeholder, or a failed page. */
export type RowSlot = { state: "ready"; row: MemoryRow } | { state: "loading" } | { state: "error"; message: string };

const LOADING: RowSlot = { state: "loading" };

interface State {
  key: string;
  epoch: number;
  pages: ReadonlyMap<number, readonly MemoryRow[]>;
  failed: ReadonlyMap<number, string>;
  total: number | null;
  counts: MemoryPage["counts"] | null;
  decay: DecayOutlook | null;
}

type Action =
  | { type: "reset"; key: string; epoch: number }
  | { type: "page"; key: string; epoch: number; offset: number; page: MemoryPage }
  | { type: "fail"; key: string; epoch: number; offset: number; message: string }
  | { type: "retry"; offset: number };

function reduce(state: State, action: Action): State {
  if (action.type === "reset") {
    const same = state.key === action.key;
    return {
      key: action.key,
      epoch: action.epoch,
      pages: new Map(),
      failed: new Map(),
      total: same ? state.total : null,
      counts: same ? state.counts : null,
      decay: same ? state.decay : null,
    };
  }
  if (action.type === "retry") {
    const failed = new Map(state.failed);
    failed.delete(action.offset);
    return { ...state, failed };
  }
  if (action.key !== state.key || action.epoch !== state.epoch) return state;
  if (action.type === "fail") return { ...state, failed: new Map(state.failed).set(action.offset, action.message) };
  const { page } = action;
  return { ...state, pages: new Map(state.pages).set(action.offset, page.rows), total: page.total, counts: page.counts, decay: page.decay };
}

interface Generation {
  key: string;
  epoch: number;
  projectKey: string;
  filters: PageFilters;
  ctrls: Map<number, AbortController>;
  requested: Set<number>;
}

/** The sparse row cache of the memory table. */
export interface MemoryPages {
  /** Rows after the chip; null until the first page of this query lands. */
  total: number | null;
  counts: MemoryPage["counts"] | null;
  decay: DecayOutlook | null;
  rowAt: (index: number) => RowSlot;
  /** Visible plus overscan row range; fetches the pages it touches. */
  want: (first: number, last: number) => void;
  /** Fetches a failed page again. */
  retry: (index: number) => void;
  /** Message of a failed first page when there is nothing to show yet. */
  error: string | null;
}

const pageOf = (index: number): number => index - (index % PAGE_SIZE);

/** Server-paged rows keyed by offset; any filter, sort or snapshot change drops the cache and refetches the window. */
export function useMemoryPages(projectKey: string, filters: PageFilters, clock: SnapshotClock): MemoryPages {
  const key = `${projectKey}|${memoryPageQueryString(filters)}`;
  const { epoch, report } = clock;
  const [state, dispatch] = useReducer(reduce, { key, epoch, pages: new Map(), failed: new Map(), total: null, counts: null, decay: null });
  const latest = useRef({ key, epoch, projectKey, filters });
  const gen = useRef<Generation | null>(null);
  const wanted = useRef({ first: 0, last: 1 });

  useLayoutEffect(() => {
    latest.current = { key, epoch, projectKey, filters };
  });

  const load = useCallback(
    (g: Generation, offset: number, again: boolean) => {
      const ctrl = new AbortController();
      g.ctrls.set(offset, ctrl);
      const query = { ...g.filters, offset, limit: PAGE_SIZE };
      fetchMemoryPage(g.projectKey, query, { signal: ctrl.signal })
        .then((page) => {
          if (ctrl.signal.aborted) return;
          if (!report(page.snapshotId)) {
            if (again) load(g, offset, false);
            else dispatch({ type: "fail", key: g.key, epoch: g.epoch, offset, message: "The page is older than the data on screen" });
            return;
          }
          dispatch({ type: "page", key: g.key, epoch: g.epoch, offset, page });
        })
        .catch((err: Error) => {
          if (ctrl.signal.aborted || isAbort(err)) return;
          dispatch({ type: "fail", key: g.key, epoch: g.epoch, offset, message: errorMessage(err) });
        });
    },
    [report],
  );

  const ensure = useCallback(
    (g: Generation, first: number, last: number) => {
      for (let offset = pageOf(first); offset < last; offset += PAGE_SIZE) {
        if (g.requested.has(offset)) continue;
        g.requested.add(offset);
        load(g, offset, true);
      }
    },
    [load],
  );

  useEffect(() => {
    const now = latest.current;
    const previous = gen.current;
    previous?.ctrls.forEach((c) => c.abort());
    if (previous && previous.key !== now.key) wanted.current = { first: 0, last: 1 };
    const g: Generation = { ...now, ctrls: new Map(), requested: new Set() };
    gen.current = g;
    dispatch({ type: "reset", key: g.key, epoch: g.epoch });
    ensure(g, 0, 1);
    ensure(g, wanted.current.first, wanted.current.last);
    return () => g.ctrls.forEach((c) => c.abort());
  }, [key, epoch, ensure]);

  const want = useCallback(
    (first: number, last: number) => {
      wanted.current = { first, last };
      const g = gen.current;
      if (g && g.key === latest.current.key && g.epoch === latest.current.epoch) ensure(g, first, last);
    },
    [ensure],
  );

  const retry = useCallback(
    (index: number) => {
      const g = gen.current;
      if (!g) return;
      const offset = pageOf(index);
      g.requested.delete(offset);
      dispatch({ type: "retry", offset });
      ensure(g, offset, offset + 1);
    },
    [ensure],
  );

  const current = state.key === key && state.epoch === epoch;
  const rowAt = useCallback(
    (index: number): RowSlot => {
      if (!current) return LOADING;
      const offset = pageOf(index);
      const row = state.pages.get(offset)?.[index - offset];
      if (row) return { state: "ready", row };
      const message = state.failed.get(offset);
      return message === undefined ? LOADING : { state: "error", message };
    },
    [current, state.pages, state.failed],
  );

  const failedFirst = state.failed.get(0);
  return {
    total: state.key === key ? state.total : null,
    counts: state.key === key ? state.counts : null,
    decay: state.key === key ? state.decay : null,
    rowAt,
    want,
    retry,
    error: state.key === key && state.total === null && failedFirst !== undefined ? failedFirst : null,
  };
}
