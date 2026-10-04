import { type ReactNode, type RefObject, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type Chip, errorMessage, fetchOverview } from "../../api/client";
import type { Overview } from "../../types";
import { HOME_CAMERA } from "./canvas/camera";
import type { TipHandle } from "./Tip";
import type { TreemapMemory } from "./Treemap";
import { type Panel, type SnapshotClock, usePanelCore, useSnapshotClockState } from "./usePanel";
import { type SearchState, useSearch } from "./useSearch";

export type Range = 7 | 30 | 90;

/** A drill from a treemap cell: the project to open and the chip its band selects. */
export interface Intent {
  key: string;
  chip: Chip;
}

/** Visible-tab refetch threshold: data older than this is reloaded when the tab returns. */
export const STALE_MS = 30_000;

export interface HealthValue {
  clock: SnapshotClock;
  overview: Panel<Overview>;
  range: Range;
  setRange: (range: Range) => void;
  /** One `?fresh=1` overview fetch; every other panel follows through the snapshot clock. */
  refresh: () => void;
  refreshing: boolean;
  search: SearchState;
  /** One-line status shown as a dismissible banner (dead link, failed refresh). */
  notice: string | null;
  setNotice: (text: string | null) => void;
  tip: RefObject<TipHandle | null>;
  treemap: RefObject<TreemapMemory>;
  /** Set by a treemap cell click, read and cleared by the project view that opens. */
  intent: RefObject<Intent | null>;
}

const HealthContext = createContext<HealthValue | null>(null);

/** Shared Health state: snapshot clock, overview panel, search, range and refresh. */
export function HealthProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const clock = useSnapshotClockState();
  const overview = usePanelCore<Overview>(clock, ({ signal }) => fetchOverview({ signal }), "overview", enabled);
  const search = useSearch(clock);
  const [range, setRange] = useState<Range>(30);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const tip = useRef<TipHandle | null>(null);
  const treemap = useRef<TreemapMemory>({ cam: { ...HOME_CAMERA }, selKey: null });
  const intent = useRef<Intent | null>(null);
  const busy = useRef(false);
  const { accept, reload, fetchedAt } = overview;

  const refresh = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    setRefreshing(true);
    setNotice(null);
    fetchOverview({ fresh: true })
      .then(accept)
      .catch((err: Error) => setNotice(`Refresh failed: ${errorMessage(err)}`))
      .finally(() => {
        busy.current = false;
        setRefreshing(false);
      });
  }, [accept]);

  const stamp = useRef(fetchedAt);
  useEffect(() => {
    stamp.current = fetchedAt;
  }, [fetchedAt]);
  useEffect(() => {
    if (!enabled) return;
    const stale = () => stamp.current > 0 && Date.now() - stamp.current > STALE_MS;
    if (stale()) reload();
    const onVisible = () => {
      if (document.visibilityState === "visible" && stale()) reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled, reload]);

  const value = useMemo<HealthValue>(
    () => ({ clock, overview, range, setRange, refresh, refreshing, search, notice, setNotice, tip, treemap, intent }),
    [clock, overview, range, refresh, refreshing, search, notice],
  );
  return <HealthContext.Provider value={value}>{children}</HealthContext.Provider>;
}

/** The Health state; throws outside `HealthProvider` so a missing provider fails loudly. */
export function useHealth(): HealthValue {
  const value = useContext(HealthContext);
  if (!value) throw new Error("useHealth must be used inside HealthProvider");
  return value;
}
