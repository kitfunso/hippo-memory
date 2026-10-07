import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isAbort } from "../../api/client";

/** Shared snapshot state: a read response with a newer id makes every panel refetch. */
export interface SnapshotClock {
  /** Bumps whenever a read reports a snapshot newer than one already seen. */
  epoch: number;
  /** Highest snapshot id seen; read it in effects, never during render. */
  seen: { current: number };
  /** Records a response's id; false means the response is older than one already seen and must be dropped. */
  report: (id: number) => boolean;
}

/** Creates the clock; the provider calls this once. */
export function useSnapshotClockState(): SnapshotClock {
  const [epoch, setEpoch] = useState(0);
  const seen = useRef(-1);
  const report = useCallback((id: number) => {
    if (id < seen.current) return false;
    if (id > seen.current) {
      const first = seen.current < 0;
      seen.current = id;
      if (!first) setEpoch((e) => e + 1);
    }
    return true;
  }, []);
  return useMemo(() => ({ epoch, seen, report }), [epoch, report]);
}

/** What a panel's loader receives. */
export interface LoadOptions {
  signal: AbortSignal;
}

/** A panel's state and controls. */
export interface Panel<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** Refetch now, whatever the snapshot says (Retry, visibility refetch). */
  reload: () => void;
  /** Take a response fetched elsewhere (Refresh, an action's answer); false when it is older than data already seen. */
  accept: (data: T) => boolean;
  /** Wall-clock ms when `data` last arrived, or 0. */
  fetchedAt: number;
}

interface PanelState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  key: string;
  fetchedAt: number;
}

/** Fetches one panel and keeps it on the current snapshot; `depsKey` changing drops the old data. */
export function usePanelCore<T extends { snapshotId: number }>(
  clock: SnapshotClock,
  load: (opts: LoadOptions) => Promise<T>,
  depsKey: string,
  enabled = true,
): Panel<T> {
  const [state, setState] = useState<PanelState<T>>({ data: null, error: null, loading: enabled, key: depsKey, fetchedAt: 0 });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  useLayoutEffect(() => {
    loadRef.current = load;
  });
  const held = useRef<{ key: string; id: number } | null>(null);
  const forced = useRef(false);
  const { epoch, report, seen } = clock;

  useEffect(() => {
    if (!enabled) return;
    const h = held.current;
    if (!forced.current && h && h.key === depsKey && h.id >= seen.current) return;
    forced.current = false;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, data: s.key === depsKey ? s.data : null, error: null, loading: true, key: depsKey }));
    loadRef
      .current({ signal: ctrl.signal })
      .then((data) => {
        if (ctrl.signal.aborted) return;
        if (!report(data.snapshotId)) {
          forced.current = true;
          setNonce((n) => n + 1);
          return;
        }
        held.current = { key: depsKey, id: data.snapshotId };
        setState({ data, error: null, loading: false, key: depsKey, fetchedAt: Date.now() });
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted || isAbort(err)) return;
        setState((s) => ({ ...s, error: err, loading: false }));
      });
    return () => ctrl.abort();
  }, [depsKey, epoch, nonce, enabled, report, seen]);

  const reload = useCallback(() => {
    forced.current = true;
    setNonce((n) => n + 1);
  }, []);
  const accept = useCallback(
    (data: T) => {
      if (!report(data.snapshotId)) return false;
      held.current = { key: depsKey, id: data.snapshotId };
      setState({ data, error: null, loading: false, key: depsKey, fetchedAt: Date.now() });
      return true;
    },
    [report, depsKey],
  );

  const current = state.key === depsKey;
  return {
    data: current ? state.data : null,
    error: state.error,
    loading: state.loading,
    reload,
    accept,
    fetchedAt: current ? state.fetchedAt : 0,
  };
}
