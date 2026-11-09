import { describe, expect, it } from "vitest";
import {
  type ActionEvent,
  type ControllerState,
  type Effect,
  type Job,
  type OverlayEntry,
  type Request,
  type RowAction,
  type RowOverlay,
  type RowState,
  INITIAL_STATE,
  UNDO_WINDOW_MS,
  isForgetting,
  isKept,
  isResolved,
  isWeakened,
  isWrong,
  mergeOverlay,
  pinnedOf,
  reduce,
  settledAt,
} from "./actionState";

const KEY = "Ctrl+Z";
const P = "p:hippo";

type Ev<T extends ActionEvent["type"]> = Extract<ActionEvent, { type: T }>;

const defer = (request: Ev<"defer">["request"]): ActionEvent => ({
  type: "defer",
  request,
  projectKey: P,
  undoKey: KEY,
});
const ids = (r: Request): string[] => (r.kind === "resolve" ? [r.keepId, r.loserId] : [r.id]);
const job = (owner: number, request: Request): Job => ({ owner, request, ids: ids(request), projectKey: P });
const run = (j: Job, keepalive = false): Effect => ({ type: "run", job: j, keepalive });
const forget = (id = "m1") => defer({ kind: "forget", id });
const wrong = (id = "m1") => defer({ kind: "wrong", id });
const resolve = (keepId = "m1", loserId = "m2") => defer({ kind: "resolve", conflictId: 7, keepId, loserId });
const pin = (pinned: boolean, id = "m1"): ActionEvent => ({ type: "pin", id, pinned, projectKey: P, undoKey: KEY });
const notify = (text: string): ActionEvent => ({ type: "notify", text });
const commit = (keepalive = false): ActionEvent => ({ type: "commit", keepalive });
const bound = (id: string | null): ActionEvent => ({ type: "drawerBound", id });
const settled = (job: Job, over: Partial<Ev<"settled">> = {}): ActionEvent => ({
  type: "settled",
  job,
  snapshotId: 2,
  taken: false,
  message: null,
  ...over,
});
const failed = (owner: number, message: string | null = "boom"): ActionEvent => ({ type: "failed", owner, message });

const FIRED: ActionEvent = { type: "timerFired" };
const UNDO: ActionEvent = { type: "undo" };
const PAUSED: ActionEvent = { type: "toastPaused" };
const RESUMED: ActionEvent = { type: "toastResumed" };
const RESTORED: ActionEvent = { type: "restored" };
const ABSENT: Job = { owner: 99, request: { kind: "forget", id: "m1" }, ids: ["m1"], projectKey: P };

/** The state after these events, each applied at `now` 0. */
const fold = (...events: ActionEvent[]): ControllerState =>
  events.reduce((s, e) => reduce(s, e, 0).state, INITIAL_STATE);

const rows = (s: ControllerState): string[] =>
  s.entries.map(({ owner, id, row }) => {
    const { action } = row;
    const what = action.kind === "pin" ? `pin:${action.pinned}` : action.kind;
    return `${owner} ${id} ${what} ${row.phase === "settled" ? `settled@${row.snapshotId}` : row.phase}`;
  });

function jobOf(s: ControllerState): Job {
  if (s.slot?.kind !== "deferred") throw new Error("no deferred job in the slot");
  return s.slot.job;
}

/** The deferred action sent with the drawer on `drawer`; its job is returned for the later settle. */
function sentJob(first: ActionEvent, drawer: string | null = "m1") {
  const queued = fold(bound(drawer), first);
  return { job: jobOf(queued), state: reduce(queued, commit(), 0).state };
}

function runJobOf(effects: readonly Effect[]): Job {
  const [first] = effects;
  if (first?.type !== "run") throw new Error("no run effect");
  return first.job;
}

const FORGET: RowAction = { kind: "forget" };
const WRONG: RowAction = { kind: "wrong" };
const KEEP: RowAction = { kind: "keep" };
const WEAKEN: RowAction = { kind: "weaken" };
const PIN_ON: RowAction = { kind: "pin", pinned: true };
const PIN_OFF: RowAction = { kind: "pin", pinned: false };

const entry = (owner: number, id: string, row: RowState): OverlayEntry => ({ owner, id, row });

const IDLE = { forgetting: false, pinned: undefined, wrong: false, kept: false, weakened: false, resolved: false };

const facts = (o: RowOverlay | undefined) => ({
  forgetting: isForgetting(o),
  pinned: pinnedOf(o),
  wrong: isWrong(o),
  kept: isKept(o),
  weakened: isWeakened(o),
  resolved: isResolved(o),
});
const pending = (action: RowAction): RowState => ({ phase: "pending", action });
const heldAt = (action: RowAction, snapshotId: number): RowState => ({ phase: "settled", action, snapshotId });

describe("transition 1: defer", () => {
  it("shows its rows pending, its toast with the undo key, and the 6 s window", () => {
    const { state, effects } = reduce(INITIAL_STATE, forget(), 500);
    expect(rows(state)).toEqual(["1 m1 forget pending"]);
    expect(state.toast).toEqual({ seq: 2, text: "Forgetting memory. Undo: Ctrl+Z", undo: true });
    expect(state.slot).toEqual({ kind: "deferred", job: job(1, { kind: "forget", id: "m1" }) });
    expect(state.timer).toEqual({ kind: "running", left: UNDO_WINDOW_MS, startedAt: 500 });
    expect(effects).toEqual([]);
  });

  it("creates a keep row and a weaken row under one owner for a resolve", () => {
    const { state } = reduce(INITIAL_STATE, resolve("m1", "m2"), 0);
    expect(rows(state)).toEqual(["1 m1 keep pending", "1 m2 weaken pending"]);
    expect(jobOf(state).ids).toEqual(["m1", "m2"]);
    expect(state.toast?.text).toBe("Resolving conflict. Undo: Ctrl+Z");
  });

  it("sends the job it displaces at once, without letting a waiting notice take the screen", () => {
    const first = fold(forget("m1"), notify("waiting"));
    const { state, effects } = reduce(first, wrong("m2"), 0);
    expect(effects).toEqual([{ type: "run", job: jobOf(first), keepalive: false }]);
    expect(rows(state)).toEqual(["1 m1 forget sent", "3 m2 wrong pending"]);
    expect(state.toast?.text).toBe("Marking memory wrong. Undo: Ctrl+Z");
    expect(state.queue).toEqual(["waiting"]);
  });
});

describe("transition 2: pin", () => {
  it("sends at once: the row is sent, a run effect follows, and the toast offers Undo", () => {
    const { state, effects } = reduce(INITIAL_STATE, pin(true), 0);
    expect(rows(state)).toEqual(["1 m1 pin:true sent"]);
    expect(effects).toEqual([run(job(1, { kind: "pin", id: "m1", pinned: true }))]);
    expect(state.toast).toEqual({ seq: 2, text: "Pinned memory. Undo: Ctrl+Z", undo: true });
    expect(state.slot).toEqual({ kind: "pin", id: "m1", pinned: true, projectKey: P });
  });

  it("words an unpin as Unpinned", () => {
    expect(reduce(INITIAL_STATE, pin(false), 0).state.toast?.text).toBe("Unpinned memory. Undo: Ctrl+Z");
  });

  it("runs the displaced deferred job first, then the pin", () => {
    const first = fold(forget("m1"), notify("waiting"));
    const { state, effects } = reduce(first, pin(true, "m2"), 0);
    expect(effects.map((e) => (e.type === "run" ? e.job.request.kind : e.type))).toEqual(["forget", "pin"]);
    expect(rows(state)).toEqual(["1 m1 forget sent", "3 m2 pin:true sent"]);
    expect(state.queue).toEqual(["waiting"]);
  });
});

describe("transitions 3 and 4: commit and timerFired", () => {
  it("3: commit sends the job, turns its rows pending to sent and closes the toast", () => {
    const start = fold(resolve());
    const { state, effects } = reduce(start, commit(), 0);
    expect(rows(state)).toEqual(["1 m1 keep sent", "1 m2 weaken sent"]);
    expect(effects).toEqual([{ type: "run", job: jobOf(start), keepalive: false }]);
    expect(state.toast).toBeNull();
    expect(state.slot).toBeNull();
    expect(state.timer).toEqual({ kind: "off" });
  });

  it("3: a keepalive commit leaves the rows sent and flags the run", () => {
    const { state, effects } = reduce(fold(forget()), commit(true), 0);
    expect(rows(state)).toEqual(["1 m1 forget sent"]);
    expect(effects).toMatchObject([{ type: "run", keepalive: true }]);
  });

  it("3: a commit hands the screen to the oldest waiting notice", () => {
    const { state } = reduce(fold(forget(), notify("first"), notify("second")), commit(), 0);
    expect(state.toast).toMatchObject({ text: "first", undo: false });
    expect(state.slot).toEqual({ kind: "notice" });
    expect(state.queue).toEqual(["second"]);
  });

  it("4: timerFired on a deferred slot commits with keepalive false", () => {
    const start = fold(wrong());
    const { state, effects } = reduce(start, FIRED, 0);
    expect(rows(state)).toEqual(["1 m1 wrong sent"]);
    expect(effects).toEqual([{ type: "run", job: jobOf(start), keepalive: false }]);
    expect(state.timer).toEqual({ kind: "off" });
  });

  it("4b: timerFired on a pin toast closes it and shows the next notice, with no effect", () => {
    const start = fold(pin(true), notify("next"));
    const { state, effects } = reduce(start, FIRED, 0);
    expect(state.toast).toMatchObject({ text: "next", undo: false });
    expect(state.queue).toEqual([]);
    expect(effects).toEqual([]);
    expect(rows(state)).toEqual(["1 m1 pin:true sent"]);
  });

  it("4b: timerFired on the last notice leaves nothing on screen", () => {
    const { state } = reduce(fold(notify("only")), FIRED, 0);
    expect(state).toMatchObject({ toast: null, slot: null, timer: { kind: "off" } });
  });
});

describe("transition 5: undo", () => {
  it("5: Undo of a deferred job closes the toast and removes its rows with no POST", () => {
    const { state, effects } = reduce(fold(resolve()), UNDO, 0);
    expect(state.entries).toEqual([]);
    expect(state).toMatchObject({ toast: null, slot: null, timer: { kind: "off" } });
    expect(effects).toEqual([]);
  });

  it("5b: Undo of a pin sends the reverse pin under a new owner and keeps the first pin's row", () => {
    const { state, effects } = reduce(fold(pin(true)), UNDO, 0);
    expect(rows(state)).toEqual(["1 m1 pin:true sent", "3 m1 pin:false sent"]);
    expect(effects).toEqual([run(job(3, { kind: "pin", id: "m1", pinned: false }))]);
    expect(state.toast).toBeNull();
  });

  it("5b: the pin Undo's owner differs from the next defer's owner", () => {
    const afterUndo = reduce(fold(pin(true)), UNDO, 0).state;
    const next = reduce(afterUndo, forget(), 0).state;
    const owners = next.entries.map((e) => e.owner);
    expect(new Set(owners).size).toBe(owners.length);
    expect(jobOf(next).owner).toBe(4);
  });

  it("5c: Undo does nothing on a notice, and Ctrl+Z has nothing to swallow", () => {
    const start = fold(notify("hello"));
    expect(start.toast?.undo).toBe(false);
    expect(start.slot).toEqual({ kind: "notice" });
    expect(reduce(start, UNDO, 0).state).toBe(start);
  });
});

describe("transition 7: failed", () => {
  it("drops the owner's rows and shows the message", () => {
    const { state } = reduce(sentJob(forget()).state, failed(1, "disk full"), 0);
    expect(state.entries).toEqual([]);
    expect(state.toast).toMatchObject({ text: "disk full", undo: false });
  });

  it("queues the message behind a live Undo window", () => {
    const sent = sentJob(forget("m1")).state;
    const live = reduce(sent, wrong("m2"), 0).state;
    const { state } = reduce(live, failed(1, "disk full"), 0);
    expect(state.toast?.text).toBe("Marking memory wrong. Undo: Ctrl+Z");
    expect(state.queue).toEqual(["disk full"]);
    expect(rows(state)).toEqual(["3 m2 wrong pending"]);
  });

  it("is silent on a keepalive failure but still drops the rows", () => {
    const { state } = reduce(sentJob(forget()).state, failed(1, null), 0);
    expect(state.entries).toEqual([]);
    expect(state.toast).toBeNull();
  });

  it("changes no row for an absent owner, still notifies, and brings nothing back", () => {
    const restored = reduce(sentJob(forget()).state, RESTORED, 0).state;
    expect(restored.entries).toEqual([]);
    const { state } = reduce(restored, failed(1, "late"), 0);
    expect(state.entries).toBe(restored.entries);
    expect(state.toast?.text).toBe("late");
  });
});

describe("transition 8: settled", () => {
  it("drops the rows when the drawer shows another memory, and notifies", () => {
    const { job, state } = sentJob(forget("m1"), "m9");
    const next = reduce(state, settled(job, { message: "Saved" }), 0).state;
    expect(next.entries).toEqual([]);
    expect(next.toast?.text).toBe("Saved");
  });

  it("holds every row of the owner at the snapshot when the drawer shows one of its memories", () => {
    const { job, state } = sentJob(resolve("m1", "m2"), "m1");
    const next = reduce(state, settled(job, { snapshotId: 5 }), 0).state;
    expect(rows(next)).toEqual(["1 m1 keep settled@5", "1 m2 weaken settled@5"]);
  });

  it.each([
    ["the drawer took the detail", { taken: true }],
    ["the overview refresh gave no snapshot", { snapshotId: null }],
  ])("drops the rows when %s", (_label, over) => {
    const { job, state } = sentJob(wrong("m1"), "m1");
    expect(reduce(state, settled(job, over), 0).state.entries).toEqual([]);
  });

  it("changes no row for an absent owner, notifies anyway, and resurrects nothing", () => {
    const start = fold(bound("m1"));
    const { state } = reduce(start, settled(ABSENT, { message: "Saved" }), 0);
    expect(state.entries).toBe(start.entries);
    expect(state.toast?.text).toBe("Saved");
  });

  it("lets one owner settle while another owner's entry on the same id survives", () => {
    const first = sentJob(wrong("m1"), "m1");
    const both = reduce(first.state, forget("m1"), 0).state;
    const { state } = reduce(both, settled(first.job, { taken: true }), 0);
    expect(rows(state)).toEqual(["3 m1 forget pending"]);
  });

  it("lets one owner fail while another owner's entry on the same id survives", () => {
    const first = sentJob(wrong("m1"), "m1");
    const both = reduce(first.state, forget("m1"), 0).state;
    expect(rows(reduce(both, failed(first.job.owner), 0).state)).toEqual(["3 m1 forget pending"]);
  });
});

describe("transitions 9 and 10: drawerBound and released", () => {
  const heldResolve = () => {
    const { job, state } = sentJob(resolve("m1", "m2"), "m1");
    return reduce(state, settled(job), 0).state;
  };

  it("9: moving the drawer drops settled entries whose owner holds none on the new id", () => {
    const { state } = reduce(heldResolve(), bound("m3"), 0);
    expect(state.entries).toEqual([]);
    expect(state.drawerId).toBe("m3");
  });

  it("9: moving to the owner's other memory keeps both rows held", () => {
    expect(rows(reduce(heldResolve(), bound("m2"), 0).state)).toEqual(["1 m1 keep settled@2", "1 m2 weaken settled@2"]);
  });

  it("9: moving the drawer keeps entries that are not settled", () => {
    const live = fold(bound("m1"), forget("m1"));
    expect(rows(reduce(live, bound("m3"), 0).state)).toEqual(["1 m1 forget pending"]);
  });

  it("9: closing the drawer drops what was held", () => {
    expect(reduce(heldResolve(), bound(null), 0).state.entries).toEqual([]);
  });

  it("9: the same id returns the identical state", () => {
    const start = heldResolve();
    expect(reduce(start, bound("m1"), 0).state).toBe(start);
  });

  it("10: a release that covers the snapshot drops the whole owner, both rows", () => {
    expect(reduce(heldResolve(), { type: "released", id: "m1", snapshotId: 2 }, 0).state.entries).toEqual([]);
  });

  it("10: a release below the held snapshot, or on another id, changes nothing", () => {
    const start = heldResolve();
    expect(reduce(start, { type: "released", id: "m1", snapshotId: 1 }, 0).state).toBe(start);
    expect(reduce(start, { type: "released", id: "m3", snapshotId: 9 }, 0).state).toBe(start);
  });

  it("10: a release leaves another owner's entries on the same id", () => {
    const start = heldResolve();
    const both = reduce(start, forget("m1"), 0).state;
    expect(rows(reduce(both, { type: "released", id: "m1", snapshotId: 2 }, 0).state)).toEqual(["3 m1 forget pending"]);
  });
});

describe("transition 11: restored", () => {
  it("empties the entries, asks for a reload, and leaves the toast alone", () => {
    const start = fold(forget());
    const { state, effects } = reduce(start, RESTORED, 0);
    expect(state.entries).toEqual([]);
    expect(state.toast).toBe(start.toast);
    expect(effects).toEqual([{ type: "reload" }]);
  });

  it("still asks for a reload when there is nothing to drop, and returns the same state", () => {
    const { state, effects } = reduce(INITIAL_STATE, RESTORED, 0);
    expect(state).toBe(INITIAL_STATE);
    expect(effects).toEqual([{ type: "reload" }]);
  });
});

describe("transitions 12 and 13: pause and resume", () => {
  const started = reduce(INITIAL_STATE, forget(), 1000).state;

  it("12: pausing at 2000 ms leaves 4000, and resuming starts 4000 from the resume time", () => {
    const paused = reduce(started, PAUSED, 3000).state;
    expect(paused.timer).toEqual({ kind: "paused", left: 4000 });
    expect(reduce(paused, RESUMED, 9000).state.timer).toEqual({ kind: "running", left: 4000, startedAt: 9000 });
  });

  it("12: the time left never goes below zero", () => {
    expect(reduce(started, PAUSED, 60_000).state.timer).toEqual({ kind: "paused", left: 0 });
  });

  it("12b: pausing a timer that is off or already paused changes nothing", () => {
    expect(reduce(INITIAL_STATE, PAUSED, 0).state).toBe(INITIAL_STATE);
    const paused = reduce(started, PAUSED, 3000).state;
    expect(reduce(paused, PAUSED, 4000).state).toBe(paused);
  });

  it("13b: resuming a running timer, or with no toast, changes nothing", () => {
    expect(reduce(started, RESUMED, 2000).state).toBe(started);
    expect(reduce(INITIAL_STATE, RESUMED, 0).state).toBe(INITIAL_STATE);
  });
});

describe("transition 14: notify", () => {
  it("14: shows a notice at once when nothing is on screen and nothing waits", () => {
    const { state } = reduce(INITIAL_STATE, notify("hello"), 250);
    expect(state.toast).toEqual({ seq: 1, text: "hello", undo: false });
    expect(state.slot).toEqual({ kind: "notice" });
    expect(state.timer).toEqual({ kind: "running", left: UNDO_WINDOW_MS, startedAt: 250 });
  });

  it("14b: queues behind a toast and leaves the Undo window running", () => {
    const start = fold(forget());
    const { state } = reduce(start, notify("later"), 0);
    expect(state.queue).toEqual(["later"]);
    expect(state.toast).toBe(start.toast);
    expect(state.timer).toBe(start.timer);
  });

  it("14b: queues behind a waiting message even with the screen clear", () => {
    const start: ControllerState = { ...INITIAL_STATE, queue: ["first"] };
    expect(reduce(start, notify("second"), 0).state.queue).toEqual(["first", "second"]);
  });

  it("shows queued notices in order, one per window", () => {
    let state = fold(notify("a"), notify("b"), notify("c"));
    expect([state.toast?.text, state.queue]).toEqual(["a", ["b", "c"]]);
    state = reduce(state, FIRED, 0).state;
    expect([state.toast?.text, state.queue]).toEqual(["b", ["c"]]);
    state = reduce(state, FIRED, 0).state;
    expect([state.toast?.text, state.queue]).toEqual(["c", []]);
    expect(reduce(state, FIRED, 0).state.toast).toBeNull();
  });

  it("holds notices behind an Undo window and shows the first when Undo closes it", () => {
    const state = reduce(fold(forget(), notify("a"), notify("b")), UNDO, 0).state;
    expect(state.toast).toMatchObject({ text: "a", undo: false });
    expect(state.queue).toEqual(["b"]);
  });
});

describe("identity: no-op events return the same state, unrelated events keep the timer", () => {
  const noops: [string, ControllerState, ActionEvent][] = [
    ["3b commit with no slot", INITIAL_STATE, commit()],
    ["3b commit on a pin slot", fold(pin(true)), commit()],
    ["3b commit on a notice", fold(notify("a")), commit()],
    ["4c a stale timerFired", INITIAL_STATE, FIRED],
    ["5c undo on a notice", fold(notify("a")), UNDO],
    ["5c undo with nothing shown", INITIAL_STATE, UNDO],
    ["7 a silent failure of an absent owner", INITIAL_STATE, failed(99, null)],
    ["8 a settle of an absent owner with no message", INITIAL_STATE, settled(ABSENT)],
    ["9 drawerBound with the same id", fold(bound("m1")), bound("m1")],
    ["10 released with nothing to drop", fold(forget()), { type: "released", id: "m1", snapshotId: 9 }],
    ["12b toastPaused with the timer off", INITIAL_STATE, PAUSED],
    ["13b toastResumed with the timer running", fold(forget()), RESUMED],
  ];

  it.each(noops)("%s", (_label, state, event) => {
    expect(reduce(state, event, 0).state).toBe(state);
  });

  const running = fold(forget("m1"));
  const unrelated: [string, ActionEvent][] = [
    ["a notice that queues", notify("x")],
    ["a drawer bind", bound("m3")],
    ["a release", { type: "released", id: "m3", snapshotId: 1 }],
    ["a failure of another owner", failed(99, "x")],
    ["a settle of another owner", settled(ABSENT, { message: "x" })],
    ["a page restore", RESTORED],
    ["a resume", RESUMED],
  ];

  it.each(unrelated)("keeps the timer object through %s", (_label, event) => {
    expect(reduce(running, event, 5000).state.timer).toBe(running.timer);
  });

  it("makes a new timer object when a toast starts or the timer is paused", () => {
    expect(reduce(running, wrong("m2"), 5000).state.timer).not.toBe(running.timer);
    expect(reduce(running, PAUSED, 5000).state.timer).not.toBe(running.timer);
  });

  it("gives a toast that replaces another a different seq", () => {
    const first = fold(forget("m1"));
    const second = reduce(first, wrong("m2"), 0).state;
    expect(second.toast?.seq).not.toBe(first.toast?.seq);
  });

  it("refuses an event it does not know", () => {
    // @ts-expect-error not a member of ActionEvent
    const unknown: ActionEvent = { type: "bogus" };
    expect(() => reduce(INITIAL_STATE, unknown, 0)).toThrow("Unhandled action event");
  });
});

interface Case {
  name: string;
  event: ActionEvent;
  request: Request;
  ids: string[];
  start: string[];
  sent: string[];
  held: string[];
}

describe("per-action matrix", () => {
  const cases: Case[] = [
    {
      name: "forget",
      event: forget(),
      request: { kind: "forget", id: "m1" },
      ids: ["m1"],
      start: ["1 m1 forget pending"],
      sent: ["1 m1 forget sent"],
      held: ["1 m1 forget settled@2"],
    },
    {
      name: "wrong",
      event: wrong(),
      request: { kind: "wrong", id: "m1" },
      ids: ["m1"],
      start: ["1 m1 wrong pending"],
      sent: ["1 m1 wrong sent"],
      held: ["1 m1 wrong settled@2"],
    },
    {
      name: "resolve",
      event: resolve("m1", "m2"),
      request: { kind: "resolve", conflictId: 7, keepId: "m1", loserId: "m2" },
      ids: ["m1", "m2"],
      start: ["1 m1 keep pending", "1 m2 weaken pending"],
      sent: ["1 m1 keep sent", "1 m2 weaken sent"],
      held: ["1 m1 keep settled@2", "1 m2 weaken settled@2"],
    },
  ];

  it.each(cases)("$name: pending, Undo with no POST, expiry sends it, settling holds or drops it", (c) => {
    const start = fold(bound("m1"), c.event);
    expect(rows(start)).toEqual(c.start);
    const undone = reduce(start, UNDO, 0);
    expect([undone.state.entries, undone.state.toast, undone.effects]).toEqual([[], null, []]);

    const sent = reduce(start, FIRED, 0);
    expect(rows(sent.state)).toEqual(c.sent);
    expect(sent.effects).toEqual([run(job(1, c.request))]);
    expect(jobOf(start).ids).toEqual(c.ids);

    expect(rows(reduce(sent.state, settled(jobOf(start)), 0).state)).toEqual(c.held);
    const away = reduce(sent.state, bound("m9"), 0).state;
    expect(reduce(away, settled(jobOf(start)), 0).state.entries).toEqual([]);
  });

  it.each([true, false])("pin %s is sent at once, Undo sends the reverse, and settling drops it", (pinned) => {
    const start = reduce(INITIAL_STATE, pin(pinned), 0);
    expect(rows(start.state)).toEqual([`1 m1 pin:${pinned} sent`]);
    expect(start.effects).toMatchObject([{ type: "run", job: { request: { kind: "pin", id: "m1", pinned } } }]);

    const undone = reduce(start.state, UNDO, 0);
    expect(undone.effects).toEqual([run(job(3, { kind: "pin", id: "m1", pinned: !pinned }))]);

    expect(reduce(start.state, settled(runJobOf(start.effects)), 0).state.entries).toEqual([]);
  });
});

describe("lanes: mergeOverlay", () => {
  it("returns an empty map for no entries", () => {
    expect(mergeOverlay([]).size).toBe(0);
  });

  it("gives each entry to the lane of its own action", () => {
    const ov = mergeOverlay([entry(1, "m1", pending(FORGET)), entry(2, "m1", pending(PIN_ON))]).get("m1");
    expect(facts(ov)).toEqual({ ...IDLE, forgetting: true, pinned: true });
  });

  it("shows wrong with keep, and keep with weaken, together", () => {
    const wrongKeep = mergeOverlay([entry(1, "m1", pending(WRONG)), entry(2, "m1", pending(KEEP))]).get("m1");
    expect(facts(wrongKeep)).toMatchObject({ wrong: true, kept: true, resolved: true });
    const keepWeaken = mergeOverlay([entry(1, "m1", pending(KEEP)), entry(2, "m1", pending(WEAKEN))]).get("m1");
    expect(facts(keepWeaken)).toMatchObject({ kept: true, weakened: true, resolved: true });
  });

  it("lets the later owner win a lane, whatever the array order or the phase", () => {
    const early = entry(1, "m1", heldAt(PIN_ON, 4));
    const late = entry(2, "m1", pending(PIN_OFF));
    expect(pinnedOf(mergeOverlay([early, late]).get("m1"))).toBe(false);
    expect(pinnedOf(mergeOverlay([late, early]).get("m1"))).toBe(false);
  });

  it("never lets one lane shadow another, so a held wrong keeps its guard under a later pin", () => {
    const ov = mergeOverlay([entry(1, "m1", heldAt(WRONG, 3)), entry(2, "m1", pending(PIN_ON))]).get("m1");
    expect([isWrong(ov), pinnedOf(ov), settledAt(ov)]).toEqual([true, true, 3]);
  });

  it("takes settledAt as the highest settled snapshot and ignores entries that are not settled", () => {
    const ov = mergeOverlay([
      entry(1, "m1", heldAt(WRONG, 3)),
      entry(2, "m1", heldAt(KEEP, 7)),
      entry(3, "m1", pending(FORGET)),
    ]).get("m1");
    expect(settledAt(ov)).toBe(7);
    expect(settledAt(mergeOverlay([entry(1, "m1", pending(FORGET))]).get("m1"))).toBeUndefined();
  });

  it("keeps ids apart", () => {
    const merged = mergeOverlay([entry(1, "m1", pending(KEEP)), entry(1, "m2", pending(WEAKEN))]);
    expect(facts(merged.get("m1"))).toMatchObject({ kept: true, weakened: false });
    expect(facts(merged.get("m2"))).toMatchObject({ kept: false, weakened: true });
  });

  it("reads an id with no overlay as idle", () => {
    expect(facts(undefined)).toEqual(IDLE);
    expect(settledAt(undefined)).toBeUndefined();
  });
});

describe("types: states the lanes cannot hold", () => {
  it("rejects each illegal state at compile time", () => {
    // @ts-expect-error a settled row needs its snapshot
    const noSnapshot: RowState = { phase: "settled", action: { kind: "forget" } };
    // @ts-expect-error a phase needs an action
    const noAction: RowState = { phase: "pending" };
    // @ts-expect-error the forget lane holds only a forget action
    const wrongInForget: RowOverlay = { forget: { phase: "pending", action: { kind: "wrong" } } };
    // @ts-expect-error a lane holds one value, not a list
    const twoValues: RowOverlay = { pin: [pending(PIN_ON), pending(PIN_OFF)] };
    // @ts-expect-error resolved is derived from the keep and weaken lanes, never stored
    const stored: RowOverlay = { resolved: true };
    expect([noSnapshot, noAction, wrongInForget, twoValues, stored]).toHaveLength(5);
  });
});
