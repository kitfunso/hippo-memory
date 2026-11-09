import { errorMessage, fetchOverview, postForget, postPin, postResolve, postWrong } from "../../api/client";
import { OVERVIEW_ROUTE, navigate, parseHash } from "../../router";
import type { MemoryDetail } from "../../types";
import {
  type ActionEvent,
  type ControllerState,
  type DrawerSink,
  type Effect,
  type Job,
  INITIAL_STATE,
  reduce,
} from "./actionState";
import type { HealthValue } from "./HealthContext";
import { DEAD_PROJECT_NOTICE } from "./useProjectDetail";

/** Shown when a mark-wrong lands but the memory's earlier good outcomes still outweigh it. */
export const WRONG_OUTWEIGHED = "Marked wrong; earlier good outcomes still outweigh it";

interface Outcome {
  note: string | null;
  detail?: MemoryDetail;
}

/** What the controller reads from outside: the latest Health state. */
export interface ControllerHooks {
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

/** The controller's methods plus what a view needs to follow its state. */
export interface ActionStore {
  actions: Controller;
  subscribe: (listener: () => void) => () => void;
  getState: () => ControllerState;
}

/** Name of the undo shortcut on this platform. */
export const undoKey = (): string => (/Mac|iPhone|iPad/.test(navigator.platform) ? "Cmd+Z" : "Ctrl+Z");

/** What the interpreter keeps besides the state: the real timer, the drawer's accept function and the pin chain. */
interface Runtime {
  hooks: ControllerHooks;
  state: ControllerState;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | undefined;
  sink: DrawerSink | null;
  tail: Promise<unknown>;
}

function stopTimer(rt: Runtime): void {
  clearTimeout(rt.timer);
  rt.timer = undefined;
}

// The timer follows `state.timer`; it is armed here, inside dispatch, so a click and its 6 s window start together.
function armTimer(rt: Runtime): void {
  stopTimer(rt);
  const { timer } = rt.state;
  if (timer.kind !== "running") return;
  rt.timer = setTimeout(() => {
    rt.timer = undefined;
    dispatch(rt, { type: "timerFired" });
  }, timer.left);
}

function dispatch(rt: Runtime, event: ActionEvent): void {
  const before = rt.state;
  const { state, effects } = reduce(before, event, Date.now());
  rt.state = state;
  if (state !== before) rt.listeners.forEach((listener) => listener());
  if (state.timer !== before.timer) armTimer(rt);
  effects.forEach((effect) => runEffect(rt, effect));
}

function runEffect(rt: Runtime, effect: Effect): void {
  if (effect.type === "reload") rt.hooks.health().overview.reload();
  else void runJob(rt, effect.job, effect.keepalive);
}

function sendPin(rt: Runtime, id: string, pinned: boolean): Promise<Outcome> {
  const run = rt.tail.then(() => postPin(id, pinned)).then((detail): Outcome => ({ note: null, detail }));
  // Keeps the chain alive after a failure; runJob reports the same rejection through `run`.
  rt.tail = run.catch(() => undefined);
  return run;
}

function sendJob(rt: Runtime, job: Job, keepalive: boolean): Promise<Outcome> {
  const { request } = job;
  switch (request.kind) {
    case "forget":
      return postForget(request.id, { keepalive }).then(() => ({ note: null }));
    case "wrong":
      return postWrong(request.id, { keepalive }).then((detail) => ({
        note: detail.wrong ? null : WRONG_OUTWEIGHED,
        detail,
      }));
    case "resolve":
      return postResolve(request.conflictId, request.keepId, { keepalive }).then(() => ({ note: null }));
    case "pin":
      return sendPin(rt, request.id, request.pinned);
  }
}

async function runJob(rt: Runtime, job: Job, keepalive: boolean): Promise<void> {
  let outcome: Outcome;
  try {
    outcome = await sendJob(rt, job, keepalive);
  } catch (err) {
    // On pagehide there is no page left to show the message on.
    dispatch(rt, { type: "failed", owner: job.owner, message: keepalive ? null : errorMessage(err) });
    return;
  }
  if (keepalive) return;
  const { detail } = outcome;
  const taken = detail !== undefined && rt.sink !== null && rt.sink.id === detail.id && rt.sink.accept(detail);
  await refreshAfter(rt, job, outcome.note, taken);
}

function leftEmpty(job: Job, projects: { key: string; live: number }[]): boolean {
  if (job.request.kind !== "forget" || projects.some((p) => p.key === job.projectKey && p.live > 0)) return false;
  const route = parseHash(window.location.hash);
  return route.view === "health" && route.projectKey === job.projectKey;
}

async function refreshAfter(rt: Runtime, job: Job, note: string | null, taken: boolean): Promise<void> {
  let message = note;
  let snapshotId: number | null = null;
  try {
    const overview = await fetchOverview();
    rt.hooks.health().overview.accept(overview);
    snapshotId = overview.snapshotId;
    if (leftEmpty(job, overview.projects)) {
      navigate(OVERVIEW_ROUTE, { replace: true });
      message = DEAD_PROJECT_NOTICE;
    }
  } catch (err) {
    message = `Saved, but refreshing failed: ${errorMessage(err)}`;
  }
  dispatch(rt, { type: "settled", job, snapshotId, taken, message });
}

/** Pin sends at once; wrong, resolve and forget show on rows and send when the 6 s window closes. */
export function createController(hooks: ControllerHooks): ActionStore {
  const rt: Runtime = {
    hooks,
    state: INITIAL_STATE,
    listeners: new Set(),
    timer: undefined,
    sink: null,
    tail: Promise.resolve(),
  };
  const send = (event: ActionEvent) => dispatch(rt, event);
  const defer = (request: Extract<ActionEvent, { type: "defer" }>["request"], projectKey: string) =>
    send({ type: "defer", request, projectKey, undoKey: undoKey() });
  const actions: Controller = {
    pin: (id, pinned, projectKey) => send({ type: "pin", id, pinned, projectKey, undoKey: undoKey() }),
    markWrong: (id, projectKey) => defer({ kind: "wrong", id }, projectKey),
    resolve: (conflictId, keepId, loserId, projectKey) =>
      defer({ kind: "resolve", conflictId, keepId, loserId }, projectKey),
    forget: (id, projectKey) => defer({ kind: "forget", id }, projectKey),
    undo: () => send({ type: "undo" }),
    canUndo: () => rt.state.slot !== null && rt.state.slot.kind !== "notice",
    pause: () => send({ type: "toastPaused" }),
    resume: () => send({ type: "toastResumed" }),
    notify: (text) => send({ type: "notify", text }),
    commitPending: (keepalive) => send({ type: "commit", keepalive }),
    bindDrawer(next) {
      rt.sink = next;
      send({ type: "drawerBound", id: next?.id ?? null });
    },
    release: (id, snapshotId) => send({ type: "released", id, snapshotId }),
    restored: () => send({ type: "restored" }),
    dispose: () => stopTimer(rt),
  };
  return {
    actions,
    subscribe(listener) {
      rt.listeners.add(listener);
      return () => {
        rt.listeners.delete(listener);
      };
    },
    getState: () => rt.state,
  };
}
