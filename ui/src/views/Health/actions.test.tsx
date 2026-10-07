import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { type Handler, json, makeOverview, makeProject } from "../../testing/fixtures";
import { makeMemory } from "../../testing/memories";
import { counted, makeRows, openHippo } from "../../testing/openHippo";
import { WRONG_OUTWEIGHED } from "./actionController";

const FORGET = "/api/memory/m1/forget";

beforeEach(() => {
  window.history.replaceState(null, "", "#/");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openDrawer() {
  fireEvent.click((await screen.findByText("memory m1")).closest("[role=row]")!);
  await screen.findByRole("button", { name: "Forget" });
}

const toast = () => document.querySelector<HTMLElement>(".toast")!;

describe("actions: forget", () => {
  it("T7: Undo inside the 6 s window sends no POST", async () => {
    const forget = counted(() => ({ ok: true, id: "m1" }));
    openHippo(makeRows(2), { extra: { [FORGET]: forget.handler } });
    await openDrawer();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(toast()).toHaveTextContent("Forgetting memory");
    act(() => {
      vi.advanceTimersByTime(5900);
    });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    vi.useRealTimers();

    expect(forget.seen).toHaveLength(0);
    expect(toast()).toHaveAttribute("hidden");
    expect(document.querySelector(".forgetting")).toBeNull();
  });

  it("T7: without Undo exactly one POST is sent when the window closes, then the overview is refetched", async () => {
    const forget = counted(() => ({ ok: true, id: "m1" }));
    const { calls } = openHippo(makeRows(2), { extra: { [FORGET]: forget.handler } });
    await openDrawer();
    const overviewBefore = calls.filter((c) => c === "/api/overview").length;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(document.querySelector(".forgetting")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(5900);
    });
    expect(forget.seen).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    vi.useRealTimers();

    await waitFor(() => expect(forget.seen).toHaveLength(1));
    await waitFor(() => expect(calls.filter((c) => c === "/api/overview").length).toBe(overviewBefore + 1));
    expect(forget.seen).toHaveLength(1);
  });

  it("T13: Ctrl+Z outside a text input cancels a pending forget, and inside one it does not", async () => {
    const forget = counted(() => ({ ok: true, id: "m1" }));
    openHippo(makeRows(2), { extra: { [FORGET]: forget.handler } });
    await openDrawer();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    const box = screen.getByRole("combobox", { name: "Search memories" });
    fireEvent.keyDown(box, { key: "z", ctrlKey: true });
    expect(toast()).not.toHaveAttribute("hidden");

    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    expect(toast()).toHaveAttribute("hidden");
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    vi.useRealTimers();
    expect(forget.seen).toHaveLength(0);
  });

  it("holds the timer while the pointer is over the toast", async () => {
    const forget = counted(() => ({ ok: true, id: "m1" }));
    openHippo(makeRows(2), { extra: { [FORGET]: forget.handler } });
    await openDrawer();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    fireEvent.mouseEnter(toast());
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(forget.seen).toHaveLength(0);
    fireEvent.mouseLeave(toast());
    act(() => {
      vi.advanceTimersByTime(6100);
    });
    vi.useRealTimers();
    await waitFor(() => expect(forget.seen).toHaveLength(1));
  });

  it("sends a pending forget with keepalive on pagehide", async () => {
    const forget = counted(() => ({ ok: true, id: "m1" }));
    openHippo(makeRows(2), { extra: { [FORGET]: forget.handler } });
    await openDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    window.dispatchEvent(new Event("pagehide"));
    await waitFor(() => expect(forget.seen).toHaveLength(1));
    expect(forget.seen[0].keepalive).toBe(true);
  });

  it("rolls back and shows the server message when the POST fails", async () => {
    openHippo(makeRows(2), { extra: { [FORGET]: () => json({ error: "disk full" }, 500) } });
    await openDrawer();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    act(() => {
      vi.advanceTimersByTime(6100);
    });
    vi.useRealTimers();

    expect(await screen.findByText("disk full")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".forgetting")).toBeNull());
  });

  it("goes to the overview when a forget leaves the project empty", async () => {
    const forget = counted(() => ({ ok: true, id: "m1" }));
    const empty = makeProject("hippo", { live: 0, atRisk: 0 });
    openHippo(makeRows(1), { extra: { [FORGET]: forget.handler } });
    await openDrawer();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === FORGET) return forget.handler(url, init);
      return json({ ...makeOverview([empty]), snapshotId: 2 });
    });
    act(() => {
      vi.advanceTimersByTime(6100);
    });
    vi.useRealTimers();

    await waitFor(() => expect(window.location.hash).toBe("#/"));
  });
});

/** Mark wrong on m1 has been sent and its answer is held; Forget on m2 is pending with a fresh 6 s window. */
async function wrongInFlightThenForget() {
  const forget = counted(() => ({ ok: true, id: "m2" }));
  let release: (r: Response) => void = () => {};
  const wrong = () => new Promise<Response>((resolve) => (release = resolve));
  openHippo(makeRows(3), { extra: { "/api/memory/m1/wrong": wrong, "/api/memory/m2/forget": forget.handler } });
  await openDrawer();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.click(screen.getByRole("button", { name: "Mark wrong" }));
  act(() => {
    vi.advanceTimersByTime(6100);
  });
  vi.useRealTimers();

  fireEvent.click((await screen.findByText("memory m2")).closest("[role=row]")!);
  await within(await screen.findByRole("dialog", { name: /Memory m2/ })).findByText("memory m2");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.click(screen.getByRole("button", { name: "Forget" }));
  return {
    forget,
    answerWrong: () =>
      act(async () => {
        release(json(makeMemory("m1", { wrong: false })));
        for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10);
      }),
  };
}

describe("actions: a late result from an earlier action", () => {
  it("never commits the pending forget and leaves its Undo working", async () => {
    const { forget, answerWrong } = await wrongInFlightThenForget();
    await answerWrong();

    expect(forget.seen).toHaveLength(0);
    expect(toast()).toHaveTextContent("Forgetting memory");
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(forget.seen).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(toast()).toHaveTextContent(WRONG_OUTWEIGHED);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(forget.seen).toHaveLength(0);
  });

  it("shows its message once the pending forget's own 6 s window closes", async () => {
    const { forget, answerWrong } = await wrongInFlightThenForget();
    await answerWrong();
    expect(toast()).not.toHaveTextContent(WRONG_OUTWEIGHED);

    act(() => {
      vi.advanceTimersByTime(6000);
    });
    vi.useRealTimers();
    await waitFor(() => expect(forget.seen).toHaveLength(1));
    expect(toast()).toHaveTextContent(WRONG_OUTWEIGHED);
  });
});

/** The server moves to snapshot 2 on the action; the next GET of m1 is held until `answerGet` is called. */
function afterActionDetailHeld(actionPath: string, answer: Response, m1At: (snap: number) => Response) {
  let snap = 1;
  let hold = false;
  let answerGet: () => void = () => {};
  const getM1: Handler = () => {
    if (!hold) return m1At(snap);
    hold = false;
    return new Promise<Response>((resolve) => (answerGet = () => resolve(m1At(snap))));
  };
  const action: Handler = () => {
    snap = 2;
    hold = true;
    return answer;
  };
  const view = openHippo(makeRows(2), { snapshot: () => snap, extra: { "/api/memory/m1": getM1, [actionPath]: action } });
  const waitForHeldGet = () => waitFor(() => expect(view.calls.filter((c) => c === "/api/memory/m1")).toHaveLength(2));
  return { ...view, waitForHeldGet, answerGet: () => act(async () => answerGet()) };
}

const CONFLICT = { id: 7, reason: "contradicts", score: 0.9, other: { id: "m2", content: "other text", strength: 0.5, retrievals: 1 } };

describe("actions: the drawer never shows stale detail after an action lands", () => {
  it("keeps the resolved conflict hidden until the drawer's own detail refreshes", async () => {
    const { waitForHeldGet, answerGet } = afterActionDetailHeld(
      "/api/conflicts/7/resolve",
      json({ ok: true, conflictId: 7, keptId: "m1", weakenedId: "m2" }),
      (snap) => json(makeMemory("m1", { snapshotId: snap, conflicts: snap === 1 ? [CONFLICT] : [] })),
    );
    await openDrawer();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Keep this one" }));
    act(() => {
      vi.advanceTimersByTime(6100);
    });
    vi.useRealTimers();

    await waitForHeldGet();
    expect(screen.queryByRole("button", { name: "Keep this one" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep the other" })).toBeNull();
    await answerGet();
    await waitFor(() => expect(screen.queryByText("kept")).toBeNull());
    expect(screen.queryByRole("button", { name: "Keep this one" })).toBeNull();
  });

  it("puts the detail a mark-wrong returns into the drawer at once and keeps Mark wrong disabled", async () => {
    const { waitForHeldGet, answerGet } = afterActionDetailHeld(
      "/api/memory/m1/wrong",
      json(makeMemory("m1", { snapshotId: 1, wrong: true, strength: 0.31 })),
      (snap) => json(makeMemory("m1", { snapshotId: snap, wrong: snap === 2, strength: snap === 2 ? 0.31 : 0.8 })),
    );
    await openDrawer();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Mark wrong" }));
    act(() => {
      vi.advanceTimersByTime(6100);
    });
    vi.useRealTimers();

    await waitForHeldGet();
    expect(within(screen.getByRole("dialog", { name: /Memory m1/ })).getByText("0.31")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark wrong" })).toBeDisabled();
    await answerGet();
    expect(screen.getByRole("button", { name: "Mark wrong" })).toBeDisabled();
  });
});

describe("actions: overlay ownership and page restore", () => {
  it("keeps each action's row flags apart, so an earlier action settling clears only its own", async () => {
    const forget = counted(() => ({ ok: true, id: "m1" }));
    let release: (r: Response) => void = () => {};
    const wrong = () => new Promise<Response>((resolve) => (release = resolve));
    openHippo(makeRows(2), { extra: { "/api/memory/m1/wrong": wrong, [FORGET]: forget.handler } });
    await openDrawer();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Mark wrong" }));
    act(() => {
      vi.advanceTimersByTime(6100);
    });
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    await act(async () => {
      release(json(makeMemory("m1", { wrong: false })));
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10);
    });

    const row = screen.getByText("memory m1").closest<HTMLElement>("[role=row]")!;
    expect(within(row).getByText("forgetting")).toBeInTheDocument();
    expect(within(row).queryByText("wrong")).toBeNull();
  });

  it("drops row flags and refetches the overview when the page returns from the back-forward cache", async () => {
    const forget = counted(() => ({ ok: true, id: "m1" }));
    const { calls } = openHippo(makeRows(2), { extra: { [FORGET]: forget.handler } });
    await openDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    window.dispatchEvent(new Event("pagehide"));
    await waitFor(() => expect(forget.seen).toHaveLength(1));
    const overviewBefore = calls.filter((c) => c === "/api/overview").length;

    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    expect(document.querySelector(".forgetting")).not.toBeNull();
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await waitFor(() => expect(document.querySelector(".forgetting")).toBeNull());
    await waitFor(() => expect(calls.filter((c) => c === "/api/overview").length).toBe(overviewBefore + 1));
  });
});

describe("actions: pin and wrong", () => {
  it("Pin applies at once and Undo sends the reverse pin", async () => {
    const pins: boolean[] = [];
    const pin = (url: URL, init?: RequestInit) => {
      const pinned = JSON.parse(String(init?.body)).pinned === true;
      pins.push(pinned);
      return json(makeMemory(url.pathname.split("/")[3], { pinned, snapshotId: 1 }));
    };
    openHippo(makeRows(2), { extra: { "/api/memory/m1/pin": pin } });
    await openDrawer();
    expect(screen.getByText(/Pinned memories never decay/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(pins).toEqual([true]));
    expect(toast()).toHaveTextContent("Pinned memory");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(pins).toEqual([true, false]));
  });

  it("Mark wrong is optimistic, sends once after the window and says so when good outcomes still outweigh it", async () => {
    const wrong = counted(() => makeMemory("m1", { wrong: false }));
    openHippo(makeRows(2), { extra: { "/api/memory/m1/wrong": wrong.handler } });
    await openDrawer();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Mark wrong" }));
    expect(screen.getByRole("button", { name: "Mark wrong" })).toBeDisabled();
    act(() => {
      vi.advanceTimersByTime(6100);
    });
    vi.useRealTimers();

    await waitFor(() => expect(wrong.seen).toHaveLength(1));
    expect(await screen.findByText(/earlier good outcomes still outweigh it/)).toBeInTheDocument();
  });
});
