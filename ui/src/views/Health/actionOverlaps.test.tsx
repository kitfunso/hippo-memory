import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { type Handler, json } from "../../testing/fixtures";
import { makeMemory, makeRow } from "../../testing/memories";
import { openHippo } from "../../testing/openHippo";
import { WRONG_OUTWEIGHED } from "./actionController";

const FORGET = "/api/memory/m1/forget";
const WRONG = "/api/memory/m1/wrong";
const PIN = "/api/memory/m1/pin";
const RESOLVE_7 = "/api/conflicts/7/resolve";
const RESOLVE_8 = "/api/conflicts/8/resolve";
const other = (id: string, content: string) => ({ id, content, strength: 0.5, retrievals: 1 });
const C7 = { id: 7, reason: "contradicts", score: 0.9, other: other("m2", "other text") };
const C8 = { id: 8, reason: "overlaps", score: 0.8, other: other("m3", "third text") };

beforeEach(() => {
  window.history.replaceState(null, "", "#/");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A POST route that records what it gets and answers only when the test says so. */
function gate() {
  const seen: { body: string; keepalive: boolean }[] = [];
  const waiting: ((r: Response) => void)[] = [];
  const handler: Handler = (_url, init) => {
    seen.push({ body: String(init?.body ?? ""), keepalive: init?.keepalive === true });
    return new Promise<Response>((resolve) => waiting.push(resolve));
  };
  return { handler, seen, answer: (r: Response) => waiting.shift()?.(r) };
}

type Step = "forget" | "wrong" | "keep" | "weaken" | "pin" | "unpin";

/** The drawer button each step presses; with two conflicts open the first match is conflict 7. */
const BUTTON: Record<Step, string> = {
  forget: "Forget",
  wrong: "Mark wrong",
  keep: "Keep this one",
  weaken: "Keep the other",
  pin: "Pin",
  unpin: "Unpin",
};
const STEPS = Object.keys(BUTTON) as Step[];
const DEFERRED: Step[] = ["forget", "wrong", "keep"];

/** m1 sits in two conflicts (with m2 and m3) and every action route holds its answer until the test gives it. */
interface SubjectOpts {
  pinned?: boolean;
  snapshot?: () => number;
  m1?: Handler;
  extra?: Record<string, Handler>;
}

function openSubject(opts: SubjectOpts = {}) {
  const pinned = opts.pinned === true;
  const gates = { forget: gate(), wrong: gate(), pin: gate(), r7: gate(), r8: gate(), m2wrong: gate() };
  const rows = [makeRow("m1", { inConflict: true, pinned }), makeRow("m2"), makeRow("m3")];
  const m1: Handler = opts.m1 ?? (() => json(makeMemory("m1", { pinned, conflicts: [C7, C8] })));
  const view = openHippo(rows, {
    snapshot: opts.snapshot,
    extra: {
      "/api/memory/m1": m1,
      [FORGET]: gates.forget.handler,
      [WRONG]: gates.wrong.handler,
      [PIN]: gates.pin.handler,
      [RESOLVE_7]: gates.r7.handler,
      [RESOLVE_8]: gates.r8.handler,
      "/api/memory/m2/wrong": gates.m2wrong.handler,
      ...opts.extra,
    },
  });
  const { forget, wrong, r7, pin } = gates;
  const posts = { forget, wrong, keep: r7, weaken: r7, pin, unpin: pin };
  const postFor = (step: Step) => posts[step];
  return { ...view, gates, postFor };
}

const toast = () => document.querySelector<HTMLElement>(".toast")!;
const grid = () => screen.getByRole("grid", { name: "Memories" });
const rowOf = (id: string) => within(grid()).getByText(`memory ${id}`).closest<HTMLElement>("[role=row]")!;
const dialogOf = (id: string) => screen.queryByRole("dialog", { name: new RegExp(`Memory ${id}`) });
const texts = (nodes: Iterable<Element>): string[] => [...nodes].map((n) => n.textContent ?? "");
const chips = (id: string): string[] => texts(rowOf(id).querySelectorAll(".flag"));
const ctrlZ = () => fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });

async function openDrawer(id = "m1") {
  const cell = await within(await screen.findByRole("grid", { name: "Memories" })).findByText(`memory ${id}`);
  fireEvent.click(cell.closest("[role=row]")!);
  const dialog = await screen.findByRole("dialog", { name: new RegExp(`Memory ${id}`) });
  await within(dialog).findByRole("button", { name: "Forget" });
  return dialog;
}

/** Presses a step's button in the open drawer; Forget closes the drawer, as in the app. */
function press(step: Step, id = "m1") {
  const dialog = dialogOf(id)!;
  fireEvent.click(within(dialog).getAllByRole("button", { name: BUTTON[step] })[0]);
}

/** The same press, opening the drawer on m1 first when a Forget closed it. */
async function perform(step: Step) {
  if (dialogOf("m1") === null) await openDrawer();
  press(step);
}

interface Seen {
  chips: string[];
  forgetting: boolean;
  flags: string[];
  pin: string;
  pressed: string;
  boxes: number;
  wrongOff: boolean;
}

/** What the row of m1 and its drawer show right now. */
async function seen(): Promise<Seen> {
  const dialog = dialogOf("m1") ?? (await openDrawer());
  const pin = within(dialog).getByRole("button", { name: /^(Pin|Unpin)$/ });
  return {
    chips: chips("m1"),
    forgetting: rowOf("m1").classList.contains("forgetting"),
    flags: texts(dialog.querySelectorAll(".dr-flags span")).filter((t) => t === "pinned" || t === "wrong"),
    pin: pin.textContent ?? "",
    pressed: pin.getAttribute("aria-pressed") ?? "",
    boxes: dialog.querySelectorAll(".cfbox").length,
    wrongOff: within(dialog).getByRole<HTMLButtonElement>("button", { name: "Mark wrong" }).disabled,
  };
}

const present = (...labels: (string | false)[]): string[] => labels.filter((l): l is string => l !== false);

/** What the base shows for m1 after these steps: each fact is its own lane and the later pin step wins the pin lane. */
function expected(steps: Step[], startsPinned: boolean): Seen {
  const lastPin = steps.filter((s) => s === "pin" || s === "unpin").at(-1);
  const pinned = lastPin === undefined ? startsPinned : lastPin === "pin";
  const resolves = steps.filter((s) => s === "keep" || s === "weaken").length;
  const wrong = steps.includes("wrong");
  return {
    chips: present(
      pinned && "pinned",
      resolves === 0 && "conflict",
      wrong && "wrong",
      steps.includes("keep") && "kept",
      steps.includes("weaken") && "weakened",
      steps.includes("forget") && "forgetting",
    ),
    forgetting: steps.includes("forget"),
    flags: present(pinned && "pinned", wrong && "wrong"),
    pin: pinned ? "Unpin" : "Pin",
    pressed: String(pinned),
    boxes: 2 - resolves,
    wrongOff: wrong,
  };
}

/** Fake setTimeout and clearTimeout, with `Date.now` moved in step so a pause measures the same time the timers run. */
function fakeClock() {
  let t = 1_700_000_000_000;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(Date, "now").mockImplementation(() => t);
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    },
    flush: () =>
      act(async () => {
        for (let i = 0; i < 8; i++) {
          t += 5;
          await vi.advanceTimersByTimeAsync(5);
        }
      }),
  };
}

describe("overlaps: the row and the drawer before any action", () => {
  it("shows a conflicted, unpinned, unmarked memory", async () => {
    openSubject();
    await openDrawer();
    expect(await seen()).toEqual({
      chips: ["conflict"],
      forgetting: false,
      flags: [],
      pin: "Pin",
      pressed: "false",
      boxes: 2,
      wrongOff: false,
    });
  });
});

describe("overlaps: every pair of actions on one memory shows both facts, in both orders", () => {
  const pairs = STEPS.flatMap((a) => STEPS.filter((b) => b !== a).map((b): [Step, Step] => [a, b]));

  it.each(pairs)("%s, then %s", async (a, b) => {
    const startsPinned = a === "unpin" || (b === "unpin" && a !== "pin");
    openSubject({ pinned: startsPinned });
    await openDrawer();
    await perform(a);
    await perform(b);
    expect(await seen()).toEqual(expected([a, b], startsPinned));
  });
});

describe("overlaps: pairs the audit named", () => {
  it("a pinned memory with a forget pending shows both chips, and Unpin stays enabled in the drawer", async () => {
    openSubject();
    await openDrawer();
    await perform("pin");
    await perform("forget");
    const now = await seen();
    expect(now.chips).toEqual(["pinned", "conflict", "forgetting"]);
    expect(now).toMatchObject({ forgetting: true, flags: ["pinned"], pin: "Unpin", pressed: "true" });
    expect(within(dialogOf("m1")!).getByRole("button", { name: "Unpin" })).toBeEnabled();
  });

  it("a forget first and a pin second show the same two facts, and Unpin is enabled", async () => {
    openSubject();
    await openDrawer();
    await perform("forget");
    await perform("pin");
    expect((await seen()).chips).toEqual(["pinned", "conflict", "forgetting"]);
    expect(within(dialogOf("m1")!).getByRole("button", { name: "Unpin" })).toBeEnabled();
  });

  it("two resolves on one memory show kept and weakened together and hide both conflict boxes", async () => {
    openSubject();
    await openDrawer();
    await perform("keep");
    await perform("weaken");
    expect(await seen()).toMatchObject({ chips: ["kept", "weakened"], boxes: 0 });
    expect(chips("m2")).toEqual(["weakened"]);
    expect(chips("m3")).toEqual(["kept"]);
  });

  it("a wrong and a resolve together keep the wrong chip, the kept chip and Mark wrong disabled", async () => {
    openSubject();
    await openDrawer();
    await perform("wrong");
    await perform("keep");
    expect(await seen()).toMatchObject({ chips: ["wrong", "kept"], flags: ["wrong"], wrongOff: true, boxes: 1 });
  });

  it("an unpin over a pinned row drops the pinned chip and the drawer flag but keeps a pending forget", async () => {
    openSubject({ pinned: true });
    await openDrawer();
    await perform("unpin");
    await perform("forget");
    expect(await seen()).toMatchObject({ chips: ["conflict", "forgetting"], flags: [], pin: "Pin", pressed: "false" });
  });
});

describe("overlaps: timing when a second action starts", () => {
  it.each(DEFERRED)("pin, then %s: the pin goes at once and %s waits out its 6 s window", async (step) => {
    const { gates, postFor } = openSubject();
    await openDrawer();
    const clock = fakeClock();
    press("pin");
    await clock.flush();
    expect(gates.pin.seen).toHaveLength(1);

    press(step);
    expect(toast()).toHaveTextContent("Undo");
    clock.advance(5900);
    expect(postFor(step).seen).toHaveLength(0);
    clock.advance(200);
    await clock.flush();
    expect(postFor(step).seen).toHaveLength(1);
  });

  it.each(DEFERRED)("%s, then pin: the first action is sent at once, before its window ends", async (step) => {
    const { gates, postFor } = openSubject();
    await openDrawer();
    await perform(step);
    expect(postFor(step).seen).toHaveLength(0);
    await perform("pin");

    await waitFor(() => expect(postFor(step).seen).toHaveLength(1));
    await waitFor(() => expect(gates.pin.seen).toHaveLength(1));
    expect(toast()).toHaveTextContent("Pinned memory");
  });

  it("a second action on another memory sends the first at once and its Undo cancels only the second", async () => {
    const { gates } = openSubject();
    await openDrawer();
    await perform("forget");
    await openDrawer("m2");
    press("wrong", "m2");

    await waitFor(() => expect(gates.forget.seen).toHaveLength(1));
    expect(gates.m2wrong.seen).toHaveLength(0);
    expect(toast()).toHaveTextContent("Marking memory wrong");
    expect(chips("m1")).toEqual(["conflict", "forgetting"]);
    expect(chips("m2")).toEqual(["wrong"]);

    fireEvent.click(within(toast()).getByRole("button", { name: "Undo" }));
    expect(toast()).toHaveAttribute("hidden");
    expect(chips("m2")).toEqual([]);
    expect(chips("m1")).toEqual(["conflict", "forgetting"]);
  });

  it("pausing at 2 s and resuming leaves the remaining 4 s of the window", async () => {
    const { gates } = openSubject();
    await openDrawer();
    const clock = fakeClock();
    press("forget");
    clock.advance(2000);
    fireEvent.mouseEnter(toast());
    clock.advance(20_000);
    expect(gates.forget.seen).toHaveLength(0);

    fireEvent.mouseLeave(toast());
    clock.advance(3900);
    expect(gates.forget.seen).toHaveLength(0);
    clock.advance(200);
    await clock.flush();
    expect(gates.forget.seen).toHaveLength(1);
  });

  it("a settle and a drawer bind at 3 s do not move the commit from 6 s", async () => {
    const { gates } = openSubject();
    await openDrawer();
    const clock = fakeClock();
    press("wrong");
    clock.advance(6100);
    await clock.flush();
    expect(gates.wrong.seen).toHaveLength(1);

    const start = clock.now();
    press("forget");
    clock.advance(3000);
    gates.wrong.answer(json(makeMemory("m1", { wrong: false })));
    fireEvent.click(rowOf("m2"));
    await clock.flush();
    expect(toast()).toHaveTextContent("Forgetting memory");

    clock.advance(start + 5950 - clock.now());
    expect(gates.forget.seen).toHaveLength(0);
    clock.advance(start + 6050 - clock.now());
    await clock.flush();
    expect(gates.forget.seen).toHaveLength(1);
    expect(toast()).toHaveTextContent(WRONG_OUTWEIGHED);
  });
});

describe("overlaps: notices and Ctrl+Z", () => {
  it("queues notices behind an Undo window in order, and Ctrl+Z is swallowed only while an Undo shows", async () => {
    const { gates } = openSubject();
    await openDrawer();
    const clock = fakeClock();
    press("pin");
    press("wrong");
    await clock.flush();
    gates.pin.answer(json({ error: "pin failed" }, 500));
    press("forget");
    await clock.flush();
    gates.wrong.answer(json({ error: "wrong failed" }, 500));
    await clock.flush();

    expect(toast()).toHaveTextContent("Forgetting memory");
    expect(toast()).not.toHaveTextContent("failed");
    clock.advance(5000);
    expect(toast()).toHaveTextContent("Forgetting memory");

    expect(ctrlZ()).toBe(false);
    expect(toast()).toHaveTextContent("pin failed");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(ctrlZ()).toBe(true);

    clock.advance(5900);
    expect(toast()).toHaveTextContent("pin failed");
    clock.advance(200);
    expect(toast()).toHaveTextContent("wrong failed");
    clock.advance(6100);
    expect(toast()).toHaveAttribute("hidden");
    expect(gates.forget.seen).toHaveLength(0);
  });

  it("a keepalive failure on pagehide is silent", async () => {
    const { gates } = openSubject();
    await openDrawer();
    press("forget");
    window.dispatchEvent(new Event("pagehide"));
    await waitFor(() => expect(gates.forget.seen).toHaveLength(1));
    expect(gates.forget.seen[0].keepalive).toBe(true);
    expect(toast()).toHaveAttribute("hidden");

    await act(async () => gates.forget.answer(json({ error: "disk full" }, 500)));
    await waitFor(() => expect(document.querySelector(".forgetting")).toBeNull());
    expect(screen.queryByText("disk full")).toBeNull();
    expect(toast()).toHaveAttribute("hidden");
  });
});

/** The server moves to snapshot 2 when an action lands, and the next read of m1 waits until `answerGet`. */
function movingServer(m1At: (snap: number) => Response) {
  let snap = 1;
  let hold = false;
  let answerGet: () => void = () => {};
  const m1: Handler = () => {
    if (!hold) return m1At(snap);
    hold = false;
    return new Promise<Response>((resolve) => (answerGet = () => resolve(m1At(snap))));
  };
  const lands =
    (answer: Response): Handler =>
    () => {
      snap = 2;
      hold = true;
      return answer;
    };
  return { snapshot: () => snap, m1, lands, answerGet: () => act(async () => answerGet()) };
}

const heldGet = (calls: string[], path: string, n: number) =>
  waitFor(() => expect(calls.filter((c) => c === path)).toHaveLength(n));

/** Presses a step and lets its 6 s window close, then hands the clock back to real time. */
function pressAndSend(step: Step): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  press(step);
  act(() => {
    vi.advanceTimersByTime(6100);
  });
  vi.useRealTimers();
}

describe("overlaps: a settled action held for the drawer's fresh detail", () => {
  const afterResolve = () =>
    movingServer((snap) => json(makeMemory("m1", { snapshotId: snap, conflicts: snap === 1 ? [C7, C8] : [C8] })));
  const landed = () => json({ ok: true, conflictId: 7, keptId: "m1", weakenedId: "m2" });

  it("a held wrong followed by a resolve keeps Mark wrong disabled until the fresh detail lands", async () => {
    const server = movingServer((snap) =>
      json(makeMemory("m1", { snapshotId: snap, wrong: snap === 2, conflicts: [C7, C8] })),
    );
    // Snapshot 0 is older than the drawer's data, so the drawer refuses this detail and the entry is held.
    const { calls } = openSubject({
      snapshot: server.snapshot,
      m1: server.m1,
      extra: { [WRONG]: server.lands(json(makeMemory("m1", { snapshotId: 0, wrong: true }))) },
    });
    await openDrawer();
    pressAndSend("wrong");
    await heldGet(calls, "/api/memory/m1", 2);
    const markWrong = () => within(dialogOf("m1")!).getByRole("button", { name: "Mark wrong" });
    expect(markWrong()).toBeDisabled();

    press("keep");
    expect(markWrong()).toBeDisabled();
    expect(chips("m1")).toEqual(["wrong", "kept"]);

    await server.answerGet();
    await waitFor(() => expect(chips("m1")).toEqual(["kept"]));
    expect(markWrong()).toBeDisabled();
  });

  it("a held resolve under a live pin keeps its guard until fresh detail lands, then drops both rows", async () => {
    const server = afterResolve();
    const extra = { [RESOLVE_7]: server.lands(landed()) };
    const { calls } = openSubject({ snapshot: server.snapshot, m1: server.m1, extra });
    await openDrawer();
    pressAndSend("keep");
    await heldGet(calls, "/api/memory/m1", 2);
    expect(chips("m1")).toEqual(["kept"]);
    expect(chips("m2")).toEqual(["weakened"]);
    expect(dialogOf("m1")!.querySelectorAll(".cfbox")).toHaveLength(1);

    press("pin");
    expect(chips("m1")).toEqual(["pinned", "kept"]);
    expect(dialogOf("m1")!.querySelectorAll(".cfbox")).toHaveLength(1);

    await server.answerGet();
    await waitFor(() => expect(chips("m1")).toEqual(["pinned", "conflict"]));
    expect(chips("m2")).toEqual([]);
  });

  it("moving the drawer to a memory unrelated to the held action drops its rows at once", async () => {
    const server = afterResolve();
    const m3 = () => new Promise<Response>(() => {});
    const { calls } = openSubject({
      snapshot: server.snapshot,
      m1: server.m1,
      extra: { [RESOLVE_7]: server.lands(landed()), "/api/memory/m3": m3 },
    });
    await openDrawer();
    pressAndSend("keep");
    await heldGet(calls, "/api/memory/m1", 2);
    expect(chips("m1")).toEqual(["kept"]);

    fireEvent.click(rowOf("m3"));
    await heldGet(calls, "/api/memory/m3", 1);
    await waitFor(() => expect(chips("m1")).toEqual(["conflict"]));
    expect(chips("m2")).toEqual([]);
  });

  it("moving the drawer to the resolve's other memory keeps both rows held", async () => {
    const server = afterResolve();
    const m2 = () => new Promise<Response>(() => {});
    const { calls } = openSubject({
      snapshot: server.snapshot,
      m1: server.m1,
      extra: { [RESOLVE_7]: server.lands(landed()), "/api/memory/m2": m2 },
    });
    await openDrawer();
    pressAndSend("keep");
    await heldGet(calls, "/api/memory/m1", 2);

    fireEvent.click(rowOf("m2"));
    await heldGet(calls, "/api/memory/m2", 1);
    await act(async () => {});
    expect(chips("m1")).toEqual(["kept"]);
    expect(chips("m2")).toEqual(["weakened"]);
  });
});
