import type { Dispatch, SetStateAction } from "react";
import { errorMessage, fetchOverview, postForget, postPin, postResolve, postWrong } from "../../api/client";
import { OVERVIEW_ROUTE, navigate, parseHash } from "../../router";
import type { MemoryDetail } from "../../types";
import type { HealthValue } from "./HealthContext";
import { DEAD_PROJECT_NOTICE } from "./useProjectDetail";

/** How long a deferred action can be undone before its POST is sent. */
export const UNDO_WINDOW_MS = 6000;

/** Shown when a mark-wrong lands but the memory's earlier good outcomes still outweigh it. */
export const WRONG_OUTWEIGHED = "Marked wrong; earlier good outcomes still outweigh it";

/** How one row is restyled while an action is pending; rows are never removed on the client. */
export interface RowOverlay {
  forgetting?: boolean;
  wrong?: boolean;
  pinned?: boolean;
  kept?: boolean;
  weakened?: boolean;
  resolved?: boolean;
  /** The server has the action; the entry stays until the drawer holds detail from this snapshot or a later one. */
  settled?: number;
}

type Flags = Omit<RowOverlay, "settled">;

/** One action's flags on one memory; each owner keeps its own so a later action never inherits an earlier one's. */
export interface OverlayEntry {
  owner: number;
  id: string;
  flags: Flags;
  settled?: number;
}

/** The by-id view the rows and the drawer read: every owner's flags merged, in the order the actions started. */
export function mergeOverlay(entries: readonly OverlayEntry[]): ReadonlyMap<string, RowOverlay> {
  const merged = new Map<string, RowOverlay>();
  for (const e of entries) {
    const prev = merged.get(e.id);
    const next: RowOverlay = { ...prev, ...e.flags };
    if (e.settled !== undefined) next.settled = Math.max(e.settled, prev?.settled ?? 0);
    merged.set(e.id, next);
  }
  return merged;
}

/** What the toast shows; `seq` changes for every new toast so the region re-announces. */
export interface ToastState {
  seq: number;
  text: string;
  undo: boolean;
}

/** What the open drawer lends the controller: the memory it shows and a way to put fresh detail straight in. */
export interface DrawerSink {
  id: string;
  accept: (detail: MemoryDetail) => boolean;
}

interface Outcome {
  note: string | null;
  detail?: MemoryDetail;
}

interface Job {
  owner: number;
  ids: readonly string[];
  projectKey: string;
  forgets: boolean;
  send: (keepalive: boolean) => Promise<Outcome>;
}

interface Slot {
  pending: Job | null;
  onUndo: (() => void) | null;
  onExpire: () => void;
}

/** What the controller drives: the overlay and toast state, and the latest Health state. */
export interface ControllerHooks {
  setEntries: Dispatch<SetStateAction<readonly OverlayEntry[]>>;
  setToast: Dispatch<SetStateAction<ToastState | null>>;
  health: () => HealthValue;
}

/** The action and undo model of plan 3.4; see `createController`. */
export interface Controller {
  pin: (id: string, pinned: boolean, projectKey: string) => void;
  markWrong: (id: string, projectKey: string) => void;
  resolve: (conflictId: number, keepId: string, loserId: string, projectKey: string) => void;
  forget: (id: string, projectKey: string) => void;
  undo: () => void;
  canUndo: () => boolean;
  pause: () => void;
  resume: () => void;
  /** Shows a message; while another toast is up it waits its turn, so it never cuts an Undo window short. */
  notify: (text: string) => void;
  /** Sends the pending action now; `keepalive` is for pagehide. */
  commitPending: (keepalive: boolean) => void;
  /** The drawer registers what it shows, or null when it shows nothing. */
  bindDrawer: (sink: DrawerSink | null) => void;
  /** The drawer holds detail for `id` from `snapshotId`: settled entries that detail covers can go. */
  release: (id: string, snapshotId: number) => void;
  /** A page restored from the back-forward cache: drops every entry and refetches. */
  restored: () => void;
  dispose: () => void;
}

/** Name of the undo shortcut on this platform. */
export const undoKey = (): string => (/Mac|iPhone|iPad/.test(navigator.platform) ? "Cmd+Z" : "Ctrl+Z");

/** Pin sends at once; wrong, resolve and forget restyle rows through the overlay and send when the 6 s window closes. */
export function createController(hooks: ControllerHooks): Controller {
  let slot: Slot | null = null;
  let sink: DrawerSink | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let left = 0;
  let startedAt = 0;
  let seq = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const queue: string[] = [];

  function stop(): void {
    clearTimeout(timer);
    timer = undefined;
  }

  function start(ms: number): void {
    stop();
    left = ms;
    startedAt = Date.now();
    timer = setTimeout(() => {
      timer = undefined;
      slot?.onExpire();
    }, ms);
  }

  function clear(): void {
    stop();
    slot = null;
    hooks.setToast(null);
  }

  function show(text: string, next: Slot): void {
    slot = next;
    hooks.setToast({ seq: ++seq, text, undo: next.onUndo !== null });
    start(UNDO_WINDOW_MS);
  }

  // A closed toast hands the screen to the oldest waiting message.
  function closeToast(): void {
    clear();
    const text = queue.shift();
    if (text !== undefined) show(text, { pending: null, onUndo: null, onExpire: closeToast });
  }

  function notify(text: string): void {
    if (slot === null && queue.length === 0) show(text, { pending: null, onUndo: null, onExpire: closeToast });
    else queue.push(text);
  }

  function put(owner: number, id: string, flags: Flags): void {
    hooks.setEntries((prev) => [...prev, { owner, id, flags }]);
  }

  function drop(owner: number): void {
    hooks.setEntries((prev) => (prev.some((e) => e.owner === owner) ? prev.filter((e) => e.owner !== owner) : prev));
  }

  function hold(owner: number, snapshotId: number): void {
    hooks.setEntries((prev) => prev.map((e) => (e.owner === owner ? { ...e, settled: snapshotId } : e)));
  }

  function leftEmpty(job: Job, projects: { key: string; live: number }[]): boolean {
    if (!job.forgets || projects.some((p) => p.key === job.projectKey && p.live > 0)) return false;
    const route = parseHash(window.location.hash);
    return route.view === "health" && route.projectKey === job.projectKey;
  }

  // Entries on the memory the drawer shows wait for the drawer's own fresh detail, so Keep and Mark wrong never re-enable on stale data.
  async function settle(job: Job, note: string | null, taken: boolean): Promise<void> {
    let message = note;
    let snapshotId: number | null = null;
    try {
      const overview = await fetchOverview();
      hooks.health().overview.accept(overview);
      snapshotId = overview.snapshotId;
      if (leftEmpty(job, overview.projects)) {
        navigate(OVERVIEW_ROUTE, { replace: true });
        message = DEAD_PROJECT_NOTICE;
      }
    } catch (err) {
      message = `Saved, but refreshing failed: ${errorMessage(err)}`;
    }
    const shown = sink !== null && job.ids.includes(sink.id);
    if (!taken && shown && snapshotId !== null) hold(job.owner, snapshotId);
    else drop(job.owner);
    if (message) notify(message);
  }

  async function execute(job: Job, keepalive: boolean): Promise<void> {
    let outcome: Outcome;
    try {
      outcome = await job.send(keepalive);
    } catch (err) {
      drop(job.owner);
      // On pagehide there is no page left to show the message on.
      if (!keepalive) notify(errorMessage(err));
      return;
    }
    if (keepalive) return;
    const { detail } = outcome;
    const taken = detail !== undefined && sink !== null && sink.id === detail.id && sink.accept(detail);
    await settle(job, outcome.note, taken);
  }

  // `flush` false is for a caller about to show its own toast, so a waiting message is not shown for an instant.
  function closePending(keepalive: boolean, flush: boolean): void {
    const job = slot?.pending;
    if (!job) return;
    if (flush) closeToast();
    else clear();
    void execute(job, keepalive);
  }

  function commitPending(keepalive: boolean): void {
    closePending(keepalive, true);
  }

  function defer(text: string, projectKey: string, flags: [string, Flags][], send: Job["send"], forgets = false): void {
    closePending(false, false);
    const job: Job = { owner: ++seq, ids: flags.map(([id]) => id), projectKey, forgets, send };
    for (const [id, f] of flags) put(job.owner, id, f);
    show(`${text}. Undo: ${undoKey()}`, { pending: job, onUndo: () => drop(job.owner), onExpire: () => commitPending(false) });
  }

  function sendPin(id: string, pinned: boolean, projectKey: string): void {
    const owner = ++seq;
    const send = () => {
      const run = tail.then(() => postPin(id, pinned)).then((detail): Outcome => ({ note: null, detail }));
      // Keeps the chain alive after a failure; execute reports the same rejection through `run`.
      tail = run.catch(() => undefined);
      return run;
    };
    put(owner, id, { pinned });
    void execute({ owner, ids: [id], projectKey, forgets: false, send }, false);
  }

  return {
    pin(id, pinned, projectKey) {
      closePending(false, false);
      sendPin(id, pinned, projectKey);
      show(`${pinned ? "Pinned" : "Unpinned"} memory. Undo: ${undoKey()}`, {
        pending: null,
        onUndo: () => sendPin(id, !pinned, projectKey),
        onExpire: closeToast,
      });
    },
    markWrong(id, projectKey) {
      defer("Marking memory wrong", projectKey, [[id, { wrong: true }]], (keepalive) =>
        postWrong(id, { keepalive }).then((detail) => ({ note: detail.wrong ? null : WRONG_OUTWEIGHED, detail })),
      );
    },
    resolve(conflictId, keepId, loserId, projectKey) {
      defer(
        "Resolving conflict",
        projectKey,
        [
          [keepId, { resolved: true, kept: true }],
          [loserId, { resolved: true, weakened: true }],
        ],
        (keepalive) => postResolve(conflictId, keepId, { keepalive }).then(() => ({ note: null })),
      );
    },
    forget(id, projectKey) {
      defer("Forgetting memory", projectKey, [[id, { forgetting: true }]], (keepalive) => postForget(id, { keepalive }).then(() => ({ note: null })), true);
    },
    undo() {
      const current = slot;
      if (!current?.onUndo) return;
      closeToast();
      current.onUndo();
    },
    canUndo: () => slot?.onUndo != null,
    pause() {
      if (timer === undefined) return;
      stop();
      left = Math.max(0, left - (Date.now() - startedAt));
    },
    resume() {
      if (slot && timer === undefined) start(left);
    },
    notify,
    commitPending,
    bindDrawer(next) {
      const moved = sink?.id !== next?.id;
      sink = next;
      if (!moved) return;
      hooks.setEntries((prev) => {
        const kept = new Set(prev.filter((e) => e.settled !== undefined && e.id === next?.id).map((e) => e.owner));
        const rest = prev.filter((e) => e.settled === undefined || kept.has(e.owner));
        return rest.length === prev.length ? prev : rest;
      });
    },
    release(id, snapshotId) {
      hooks.setEntries((prev) => {
        const done = new Set(prev.filter((e) => e.id === id && e.settled !== undefined && snapshotId >= e.settled).map((e) => e.owner));
        return done.size === 0 ? prev : prev.filter((e) => !done.has(e.owner));
      });
    },
    restored() {
      hooks.setEntries((prev) => (prev.length === 0 ? prev : []));
      hooks.health().overview.reload();
    },
    dispose: stop,
  };
}
