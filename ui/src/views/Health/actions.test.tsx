import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { json, makeOverview, makeProject } from "../../testing/fixtures";
import { makeMemory } from "../../testing/memories";
import { counted, makeRows, openHippo } from "../../testing/openHippo";

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
