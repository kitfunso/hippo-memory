import type { Dispatch, SetStateAction } from "react";
import { errorMessage, fetchOverview, postForget, postPin, postResolve, postWrong } from "../../api/client";
import { OVERVIEW_ROUTE, navigate, parseHash } from "../../router";
import type { HealthValue } from "./HealthContext";
import { DEAD_PROJECT_NOTICE } from "./useProjectDetail";

/** How long a deferred action can be undone before its POST is sent. */
export const UNDO_WINDOW_MS = 6000;

/** Shown when a mark-wrong lands but the memory's earlier good outcomes still outweigh it. */
export const WRONG_OUTWEIGHED = "Marked wrong; earlier good outcomes still outweigh it";

/** How one row is restyled while an action is pending; rows are never removed on the client. */
export interface RowOverlay {
  /** Owner action: only that action drops this entry. */
  readonly by: number;
  forgetting?: boolean;
  wrong?: boolean;
  pinned?: boolean;
  kept?: boolean;
  weakened?: boolean;
  resolved?: boolean;
}

/** What the toast shows; `seq` changes for every new toast so the region re-announces. */
export interface ToastState {
  seq: number;
  text: string;
  undo: boolean;
}

type Flags = Omit<RowOverlay, "by">;

interface Job {
  owner: number;
  projectKey: string;
  forgets: boolean;
  send: (keepalive: boolean) => Promise<string | null>;
}

interface Slot {
  pending: Job | null;
  onUndo: (() => void) | null;
  onExpire: () => void;
}

/** What the controller drives: the overlay and toast state, and the latest Health state. */
export interface ControllerHooks {
  setOverlay: Dispatch<SetStateAction<ReadonlyMap<string, RowOverlay>>>;
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
  notify: (text: string) => void;
  /** Sends the pending action now; `keepalive` is for pagehide. */
  commitPending: (keepalive: boolean) => void;
  dispose: () => void;
}

/** Name of the undo shortcut on this platform. */
export const undoKey = (): string => (/Mac|iPhone|iPad/.test(navigator.platform) ? "Cmd+Z" : "Ctrl+Z");

/** Pin sends at once; wrong, resolve and forget restyle rows through the overlay and send when the 6 s window closes. */
export function createController(hooks: ControllerHooks): Controller {
  let slot: Slot | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let left = 0;
  let startedAt = 0;
  let seq = 0;
  let tail: Promise<unknown> = Promise.resolve();

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

  function put(owner: number, id: string, flags: Flags): void {
    hooks.setOverlay((prev) => new Map(prev).set(id, { ...prev.get(id), ...flags, by: owner }));
  }

  function drop(owner: number): void {
    hooks.setOverlay((prev) => {
      const next = new Map([...prev].filter(([, row]) => row.by !== owner));
      return next.size === prev.size ? prev : next;
    });
  }

  function notify(text: string): void {
    commitPending(false);
    show(text, { pending: null, onUndo: null, onExpire: clear });
  }

  function leftEmpty(job: Job, projects: { key: string; live: number }[]): boolean {
    if (!job.forgets || projects.some((p) => p.key === job.projectKey && p.live > 0)) return false;
    const route = parseHash(window.location.hash);
    return route.view === "health" && route.projectKey === job.projectKey;
  }

  async function settle(job: Job, note: string | null): Promise<void> {
    let message = note;
    try {
      const overview = await fetchOverview();
      hooks.health().overview.accept(overview);
      if (leftEmpty(job, overview.projects)) {
        navigate(OVERVIEW_ROUTE, { replace: true });
        message = DEAD_PROJECT_NOTICE;
      }
    } catch (err) {
      message = `Saved, but refreshing failed: ${errorMessage(err)}`;
    }
    drop(job.owner);
    if (message) notify(message);
  }

  async function execute(job: Job, keepalive: boolean): Promise<void> {
    let note: string | null;
    try {
      note = await job.send(keepalive);
    } catch (err) {
      drop(job.owner);
      // On pagehide there is no page left to show the message on.
      if (!keepalive) notify(errorMessage(err));
      return;
    }
    if (!keepalive) await settle(job, note);
  }

  function commitPending(keepalive: boolean): void {
    const job = slot?.pending;
    if (!job) return;
    clear();
    void execute(job, keepalive);
  }

  function defer(text: string, projectKey: string, flags: [string, Flags][], send: Job["send"], forgets = false): void {
    commitPending(false);
    const job: Job = { owner: ++seq, projectKey, forgets, send };
    for (const [id, f] of flags) put(job.owner, id, f);
    show(`${text}. Undo: ${undoKey()}`, { pending: job, onUndo: () => drop(job.owner), onExpire: () => commitPending(false) });
  }

  function sendPin(id: string, pinned: boolean, projectKey: string): void {
    const owner = ++seq;
    const send = () => {
      const run = tail.then(() => postPin(id, pinned)).then(() => null);
      // Keeps the chain alive after a failure; execute reports the same rejection through `run`.
      tail = run.catch(() => undefined);
      return run;
    };
    put(owner, id, { pinned });
    void execute({ owner, projectKey, forgets: false, send }, false);
  }

  return {
    pin(id, pinned, projectKey) {
      commitPending(false);
      sendPin(id, pinned, projectKey);
      show(`${pinned ? "Pinned" : "Unpinned"} memory. Undo: ${undoKey()}`, {
        pending: null,
        onUndo: () => sendPin(id, !pinned, projectKey),
        onExpire: clear,
      });
    },
    markWrong(id, projectKey) {
      defer("Marking memory wrong", projectKey, [[id, { wrong: true }]], (keepalive) =>
        postWrong(id, { keepalive }).then((detail) => (detail.wrong ? null : WRONG_OUTWEIGHED)),
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
        (keepalive) => postResolve(conflictId, keepId, { keepalive }).then(() => null),
      );
    },
    forget(id, projectKey) {
      defer("Forgetting memory", projectKey, [[id, { forgetting: true }]], (keepalive) => postForget(id, { keepalive }).then(() => null), true);
    },
    undo() {
      const current = slot;
      if (!current?.onUndo) return;
      clear();
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
    dispose: stop,
  };
}
