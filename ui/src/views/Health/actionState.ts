import type { MemoryDetail } from "../../types";

/** How long a deferred action can be undone before its POST is sent. */
export const UNDO_WINDOW_MS = 6000;

/** The pin lane's action: the value the row shows until the server confirms it. */
export type PinAction = { kind: "pin"; pinned: boolean };

/** What one lane of a row is doing; `resolve` is a request that makes a `keep` row and a `weaken` row. */
export type RowAction = { kind: "forget" } | { kind: "wrong" } | { kind: "keep" } | { kind: "weaken" } | PinAction;

/** One lane's state; a lane that is absent is idle, so a phase always has its action and a settled one its snapshot. */
export type RowState<A extends RowAction = RowAction> =
  | { phase: "pending"; action: A } // inside the undo window, nothing sent
  | { phase: "sent"; action: A } // POST sent or in flight, overview refresh not done
  | { phase: "settled"; action: A; snapshotId: number }; // the server has it; held until the drawer catches up

/** One action's row on one memory; one owner never holds two entries on one id. */
export interface OverlayEntry {
  owner: number;
  id: string;
  row: RowState;
}

/** What rows and the drawer read for one id; absent from the map means idle. Each lane holds only its own action. */
export interface RowOverlay {
  forget?: RowState<{ kind: "forget" }>;
  wrong?: RowState<{ kind: "wrong" }>;
  keep?: RowState<{ kind: "keep" }>;
  weaken?: RowState<{ kind: "weaken" }>;
  pin?: RowState<PinAction>;
  /** Highest snapshot of any settled entry for the id; the drawer releases entries once its detail reaches it. */
  settledAt?: number;
}

type Overlay = RowOverlay | undefined;

/** The row is being forgotten. */
export const isForgetting = (o: Overlay): boolean => o?.forget !== undefined;

/** The pin lane's value, or undefined when no pin or unpin is under way for the id. */
export const pinnedOf = (o: Overlay): boolean | undefined => o?.pin?.action.pinned;

/** The memory is marked wrong. */
export const isWrong = (o: Overlay): boolean => o?.wrong !== undefined;

/** The memory was kept in a resolved conflict. */
export const isKept = (o: Overlay): boolean => o?.keep !== undefined;

/** The memory was weakened in a resolved conflict. */
export const isWeakened = (o: Overlay): boolean => o?.weaken !== undefined;

/** The memory sits in a resolved conflict, kept or weakened. */
export const isResolved = (o: Overlay): boolean => isKept(o) || isWeakened(o);

/** The highest settled snapshot held for the id, if any. */
export const settledAt = (o: Overlay): number | undefined => o?.settledAt;

function isKind<K extends RowAction["kind"]>(row: RowState, kind: K): row is RowState<Extract<RowAction, { kind: K }>> {
  return row.action.kind === kind;
}

function withLane(overlay: RowOverlay, row: RowState): RowOverlay {
  if (isKind(row, "forget")) return { ...overlay, forget: row };
  if (isKind(row, "wrong")) return { ...overlay, wrong: row };
  if (isKind(row, "keep")) return { ...overlay, keep: row };
  if (isKind(row, "weaken")) return { ...overlay, weaken: row };
  return isKind(row, "pin") ? { ...overlay, pin: row } : overlay;
}

const EMPTY_OVERLAY: ReadonlyMap<string, RowOverlay> = new Map();

/** One overlay per id: each entry feeds its own lane, the later owner wins a lane, and lanes never touch each other. */
export function mergeOverlay(entries: readonly OverlayEntry[]): ReadonlyMap<string, RowOverlay> {
  if (entries.length === 0) return EMPTY_OVERLAY;
  const merged = new Map<string, RowOverlay>();
  for (const e of [...entries].sort((a, b) => a.owner - b.owner)) {
    const next = withLane(merged.get(e.id) ?? {}, e.row);
    const held = e.row.phase === "settled" ? Math.max(e.row.snapshotId, next.settledAt ?? 0) : undefined;
    merged.set(e.id, held === undefined ? next : { ...next, settledAt: held });
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

/** An action as data; the interpreter turns it into the POST. */
export type Request =
  | { kind: "forget"; id: string }
  | { kind: "wrong"; id: string }
  | { kind: "resolve"; conflictId: number; keepId: string; loserId: string }
  | { kind: "pin"; id: string; pinned: boolean };

/** A request with the owner that tags its rows and the memories it touches. */
export interface Job {
  owner: number;
  request: Request;
  ids: readonly string[];
  projectKey: string;
}

/** What the toast belongs to: a deferred job, a pin that Undo reverses, or a plain notice. */
export type Slot =
  | { kind: "deferred"; job: Job }
  | { kind: "pin"; id: string; pinned: boolean; projectKey: string }
  | { kind: "notice" };

/** The toast's clock; the interpreter owns the real timer and follows this value. */
export type TimerState =
  | { kind: "off" }
  | { kind: "running"; left: number; startedAt: number }
  | { kind: "paused"; left: number };

/** Everything the controller knows; changes only through `reduce`. */
export interface ControllerState {
  entries: readonly OverlayEntry[];
  toast: ToastState | null;
  slot: Slot | null;
  queue: readonly string[];
  timer: TimerState;
  /** One counter for job owners and toast ids, so each is unique. */
  seq: number;
  drawerId: string | null;
}

type Ev<T extends ActionEvent["type"]> = Extract<ActionEvent, { type: T }>;

/** Everything that can happen to the controller. */
export type ActionEvent =
  | { type: "defer"; request: Exclude<Request, { kind: "pin" }>; projectKey: string; undoKey: string }
  | { type: "pin"; id: string; pinned: boolean; projectKey: string; undoKey: string }
  | { type: "commit"; keepalive: boolean }
  | { type: "timerFired" }
  | { type: "undo" }
  | { type: "failed"; owner: number; message: string | null }
  | { type: "settled"; job: Job; snapshotId: number | null; taken: boolean; message: string | null }
  | { type: "drawerBound"; id: string | null }
  | { type: "released"; id: string; snapshotId: number }
  | { type: "restored" }
  | { type: "toastPaused" }
  | { type: "toastResumed" }
  | { type: "notify"; text: string };

/** What the interpreter must do after a transition. */
export type Effect = { type: "run"; job: Job; keepalive: boolean } | { type: "reload" };

/** The next state and the effects to run. */
export interface Reduction {
  state: ControllerState;
  effects: readonly Effect[];
}

const OFF: TimerState = { kind: "off" };
const NONE: readonly Effect[] = [];

/** The controller before anything happened. */
export const INITIAL_STATE: ControllerState = {
  entries: [],
  toast: null,
  slot: null,
  queue: [],
  timer: OFF,
  seq: 0,
  drawerId: null,
};

const TOAST_TEXT = { forget: "Forgetting memory", wrong: "Marking memory wrong", resolve: "Resolving conflict" };

const noEffects = (state: ControllerState): Reduction => ({ state, effects: NONE });

function actionsOf(request: Request): [string, RowAction][] {
  switch (request.kind) {
    case "forget":
      return [[request.id, { kind: "forget" }]];
    case "wrong":
      return [[request.id, { kind: "wrong" }]];
    case "resolve":
      return [
        [request.keepId, { kind: "keep" }],
        [request.loserId, { kind: "weaken" }],
      ];
    case "pin":
      return [[request.id, { kind: "pin", pinned: request.pinned }]];
  }
}

function rowsOf(job: Job, phase: "pending" | "sent"): OverlayEntry[] {
  return actionsOf(job.request).map(([id, action]) => ({ owner: job.owner, id, row: { phase, action } }));
}

function dropOwners(state: ControllerState, owners: ReadonlySet<number>): ControllerState {
  if (!state.entries.some((e) => owners.has(e.owner))) return state;
  return { ...state, entries: state.entries.filter((e) => !owners.has(e.owner)) };
}

const dropOwner = (state: ControllerState, owner: number): ControllerState => dropOwners(state, new Set([owner]));

function mapOwner(state: ControllerState, owner: number, change: (e: OverlayEntry) => OverlayEntry): ControllerState {
  if (!state.entries.some((e) => e.owner === owner)) return state;
  return { ...state, entries: state.entries.map((e) => (e.owner === owner ? change(e) : e)) };
}

function show(state: ControllerState, text: string, slot: Slot, now: number): ControllerState {
  const seq = state.seq + 1;
  const timer: TimerState = { kind: "running", left: UNDO_WINDOW_MS, startedAt: now };
  return { ...state, seq, slot, toast: { seq, text, undo: slot.kind !== "notice" }, timer };
}

const clear = (state: ControllerState): ControllerState => ({ ...state, slot: null, toast: null, timer: OFF });

// A closed toast hands the screen to the oldest waiting message.
function closeToast(state: ControllerState, now: number): ControllerState {
  const cleared = clear(state);
  if (cleared.queue.length === 0) return cleared;
  const [text, ...rest] = cleared.queue;
  return show({ ...cleared, queue: rest }, text, { kind: "notice" }, now);
}

function notify(state: ControllerState, text: string, now: number): ControllerState {
  if (state.slot === null && state.queue.length === 0) return show(state, text, { kind: "notice" }, now);
  return { ...state, queue: [...state.queue, text] };
}

const markSent = (e: OverlayEntry): OverlayEntry =>
  e.row.phase === "pending" ? { ...e, row: { phase: "sent", action: e.row.action } } : e;

// `flush` false is for a caller about to show its own toast, so a waiting message is not shown for an instant.
function closePending(state: ControllerState, flush: boolean, keepalive: boolean, now: number): Reduction {
  const { slot } = state;
  if (slot === null || slot.kind !== "deferred") return noEffects(state);
  const { job } = slot;
  const closed = flush ? closeToast(state, now) : clear(state);
  return { state: mapOwner(closed, job.owner, markSent), effects: [{ type: "run", job, keepalive }] };
}

// A pin sends at once, so its row starts sent and its owner comes from the same counter as every other.
function startPin(state: ControllerState, id: string, pinned: boolean, projectKey: string): Reduction {
  const job: Job = { owner: state.seq + 1, request: { kind: "pin", id, pinned }, ids: [id], projectKey };
  const next = { ...state, seq: job.owner, entries: [...state.entries, ...rowsOf(job, "sent")] };
  return { state: next, effects: [{ type: "run", job, keepalive: false }] };
}

function onDefer(state: ControllerState, e: Ev<"defer">, now: number): Reduction {
  const closed = closePending(state, false, false, now);
  const owner = closed.state.seq + 1;
  const ids = actionsOf(e.request).map(([id]) => id);
  const job: Job = { owner, request: e.request, ids, projectKey: e.projectKey };
  const entries = [...closed.state.entries, ...rowsOf(job, "pending")];
  const text = `${TOAST_TEXT[e.request.kind]}. Undo: ${e.undoKey}`;
  const next = show({ ...closed.state, seq: owner, entries }, text, { kind: "deferred", job }, now);
  return { state: next, effects: closed.effects };
}

function onPin(state: ControllerState, e: Ev<"pin">, now: number): Reduction {
  const closed = closePending(state, false, false, now);
  const started = startPin(closed.state, e.id, e.pinned, e.projectKey);
  const text = `${e.pinned ? "Pinned" : "Unpinned"} memory. Undo: ${e.undoKey}`;
  const slot: Slot = { kind: "pin", id: e.id, pinned: e.pinned, projectKey: e.projectKey };
  return { state: show(started.state, text, slot, now), effects: [...closed.effects, ...started.effects] };
}

function onTimerFired(state: ControllerState, now: number): Reduction {
  const { slot } = state;
  if (slot === null) return noEffects(state);
  if (slot.kind === "deferred") return closePending(state, true, false, now);
  return noEffects(closeToast(state, now));
}

function onUndo(state: ControllerState, now: number): Reduction {
  const { slot } = state;
  if (slot === null || slot.kind === "notice") return noEffects(state);
  const closed = closeToast(state, now);
  if (slot.kind === "deferred") return noEffects(dropOwner(closed, slot.job.owner));
  return startPin(closed, slot.id, !slot.pinned, slot.projectKey);
}

function onFailed(state: ControllerState, e: Ev<"failed">, now: number): Reduction {
  const dropped = dropOwner(state, e.owner);
  return noEffects(e.message === null ? dropped : notify(dropped, e.message, now));
}

// A row on the shown memory waits for the drawer's fresh detail, so Keep and Mark wrong never re-enable on stale data.
function onSettled(state: ControllerState, e: Ev<"settled">, now: number): Reduction {
  const { job, snapshotId } = e;
  const shown = state.drawerId !== null && job.ids.includes(state.drawerId);
  const held = !e.taken && shown && snapshotId !== null;
  const rows = held
    ? mapOwner(state, job.owner, (x) => ({ ...x, row: { phase: "settled", action: x.row.action, snapshotId } }))
    : dropOwner(state, job.owner);
  return noEffects(e.message === null ? rows : notify(rows, e.message, now));
}

function onDrawerBound(state: ControllerState, id: string | null): Reduction {
  if (state.drawerId === id) return noEffects(state);
  const holders = new Set(state.entries.filter((e) => e.row.phase === "settled" && e.id === id).map((e) => e.owner));
  const entries = state.entries.filter((e) => e.row.phase !== "settled" || holders.has(e.owner));
  const kept = entries.length === state.entries.length ? state.entries : entries;
  return noEffects({ ...state, drawerId: id, entries: kept });
}

function onReleased(state: ControllerState, e: Ev<"released">): Reduction {
  const covered = state.entries.filter(
    (x) => x.id === e.id && x.row.phase === "settled" && e.snapshotId >= x.row.snapshotId,
  );
  return noEffects(dropOwners(state, new Set(covered.map((x) => x.owner))));
}

function onRestored(state: ControllerState): Reduction {
  return { state: state.entries.length === 0 ? state : { ...state, entries: [] }, effects: [{ type: "reload" }] };
}

function onPaused(state: ControllerState, now: number): Reduction {
  const { timer } = state;
  if (timer.kind !== "running") return noEffects(state);
  return noEffects({ ...state, timer: { kind: "paused", left: Math.max(0, timer.left - (now - timer.startedAt)) } });
}

function onResumed(state: ControllerState, now: number): Reduction {
  const { timer } = state;
  if (state.slot === null || timer.kind !== "paused") return noEffects(state);
  return noEffects({ ...state, timer: { kind: "running", left: timer.left, startedAt: now } });
}

function unreachable(event: never): never {
  throw new Error(`Unhandled action event: ${JSON.stringify(event)}`);
}

/** The one pure transition; `now` is a parameter so the clock stays outside, and a no-op returns the same state. */
export function reduce(state: ControllerState, event: ActionEvent, now: number): Reduction {
  switch (event.type) {
    case "defer":
      return onDefer(state, event, now);
    case "pin":
      return onPin(state, event, now);
    case "commit":
      return closePending(state, true, event.keepalive, now);
    case "timerFired":
      return onTimerFired(state, now);
    case "undo":
      return onUndo(state, now);
    case "failed":
      return onFailed(state, event, now);
    case "settled":
      return onSettled(state, event, now);
    case "drawerBound":
      return onDrawerBound(state, event.id);
    case "released":
      return onReleased(state, event);
    case "restored":
      return onRestored(state);
    case "toastPaused":
      return onPaused(state, now);
    case "toastResumed":
      return onResumed(state, now);
    case "notify":
      return noEffects(notify(state, event.text, now));
    default:
      return unreachable(event);
  }
}
