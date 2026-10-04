import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App";
import { fetchRouter, json, makeDetail, makeOverview, makeProject } from "./testing/fixtures";

const hippo = makeProject("hippo", { live: 500, atRisk: 50 });
const mure = makeProject("mure", { live: 200, atRisk: 4 });

beforeEach(() => {
  window.history.replaceState(null, "", "#/");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function overviewRoutes() {
  return fetchRouter({
    "/api/overview": () => json(makeOverview([hippo, mure])),
    "/api/projects/p%3Ahippo": () => json(makeDetail(hippo)),
  });
}

describe("App: Health overview", () => {
  it("T6: renders from /api/overview under an h1, and a project click goes to #/p/<key>", async () => {
    vi.stubGlobal("fetch", overviewRoutes().stub);
    render(<App />);

    expect(screen.getByRole("main").firstElementChild?.tagName).toBe("H1");
    expect(screen.getByRole("heading", { level: 1, name: "Memory health" })).toBeInTheDocument();
    expect(await screen.findByText("Total memories")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /hippo/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/p/p%3Ahippo"));
    expect(await screen.findByRole("heading", { level: 1, name: "hippo" })).toBeInTheDocument();
  });

  it("shows the loading status while the overview is in flight", () => {
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
    render(<App />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading memories");
  });

  it("shows the server message, the running hint and Retry on a failed overview, and Retry refetches", async () => {
    let n = 0;
    const { stub, calls } = fetchRouter({
      "/api/overview": () => (n++ === 0 ? json({ error: "db locked" }, 500) : json(makeOverview([hippo]))),
    });
    vi.stubGlobal("fetch", stub);
    render(<App />);

    expect(await screen.findByText("db locked")).toBeInTheDocument();
    expect(screen.getByText("Is hippo dashboard still running?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Total memories")).toBeInTheDocument();
    expect(calls.filter((c) => c === "/api/overview")).toHaveLength(2);
  });

  it("shows the empty-store card when there are no memories", async () => {
    const { stub } = fetchRouter({ "/api/overview": () => json(makeOverview([], { total: 0 })) });
    vi.stubGlobal("fetch", stub);
    render(<App />);
    expect(await screen.findByText(/No memories yet/)).toHaveTextContent("Run hippo remember to add one.");
    expect(screen.getByRole("heading", { level: 1, name: "Memory health" })).toBeInTheDocument();
  });

  it("switches between the map and the projects table", async () => {
    vi.stubGlobal("fetch", overviewRoutes().stub);
    render(<App />);
    await screen.findByText("Total memories");
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    const grid = await screen.findByRole("grid", { name: "Projects table" });
    expect(grid).toHaveAttribute("aria-rowcount", "3");
    expect(screen.queryByRole("columnheader", { name: /team/i })).toBeNull();
  });

  it("Updated label and exactly one Refresh show on the Health view", async () => {
    vi.stubGlobal("fetch", overviewRoutes().stub);
    render(<App />);
    expect(await screen.findByText(/^Updated /)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^refresh/i })).toHaveLength(1);
  });
});

describe("App: snapshot clock", () => {
  it("Refresh sends one ?fresh=1 overview fetch and shows the new data", async () => {
    let id = 0;
    const { stub, calls } = fetchRouter({
      "/api/overview": () => {
        id++;
        return json(makeOverview([makeProject("hippo", { live: id === 1 ? 500 : 777, atRisk: 5 })], { snapshotId: id }));
      },
    });
    vi.stubGlobal("fetch", stub);
    render(<App />);
    await screen.findByText("Total memories");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("777")).toBeInTheDocument();
    expect(calls.filter((c) => c.includes("fresh=1"))).toEqual(["/api/overview?fresh=1"]);
  });

  it("a newer snapshotId refetches the project panel without fresh", async () => {
    window.history.replaceState(null, "", "#/p/p%3Ahippo");
    let overviewId = 0;
    let detailId = 0;
    const { stub, calls } = fetchRouter({
      "/api/overview": () => json(makeOverview([hippo], { snapshotId: ++overviewId })),
      "/api/projects/p%3Ahippo": () => json(makeDetail(hippo, ++detailId)),
    });
    vi.stubGlobal("fetch", stub);
    render(<App />);
    await waitFor(() => expect(screen.queryByText("loading")).toBeNull());
    const before = calls.filter((c) => c.startsWith("/api/projects/")).length;

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls.filter((c) => c.startsWith("/api/projects/")).length).toBe(before + 1));
    expect(calls.filter((c) => c.startsWith("/api/projects/") && c.includes("fresh"))).toHaveLength(0);
  });

  it("refetches the overview when the tab becomes visible and the data is over 30 s old", async () => {
    const { stub, calls } = overviewRoutes();
    vi.stubGlobal("fetch", stub);
    render(<App />);
    await screen.findByText("Total memories");
    const real = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(real + 31_000);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(calls.filter((c) => c === "/api/overview")).toHaveLength(2));
    spy.mockRestore();
  });
});

describe("App: dead links", () => {
  it("T12: a dead #/p/<key> link lands on the overview with the banner and a replaced hash", async () => {
    window.history.replaceState(null, "", "#/p/p%3Agone");
    const { stub } = fetchRouter({
      "/api/overview": () => json(makeOverview([hippo])),
      "/api/projects/p%3Agone": () => json({ error: "no such project" }, 404),
    });
    vi.stubGlobal("fetch", stub);
    render(<App />);

    expect(await screen.findByText("That project has no memories any more")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/");
    expect(await screen.findByText("Total memories")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Memory health" })).toBeInTheDocument();
  });
});

describe("App: search", () => {
  it("T14: a slow first response never overwrites the second query's hits", async () => {
    const searchSignals: AbortSignal[] = [];
    let releaseFirst: (r: Response) => void = () => {};
    const { stub } = fetchRouter({
      "/api/overview": () => json(makeOverview([hippo, mure])),
      "/api/search": (url, init) => {
        const q = url.searchParams.get("q") ?? "";
        if (init?.signal) searchSignals.push(init.signal);
        if (q === "ab") return new Promise<Response>((resolve) => (releaseFirst = resolve));
        return json({ snapshotId: 1, q, total: 2, hits: { "p:mure": 2 }, nameMatches: [] });
      },
    });
    vi.stubGlobal("fetch", stub);
    render(<App />);
    await screen.findByText("Total memories");

    const box = screen.getByRole("combobox", { name: "Search memories" });
    fireEvent.change(box, { target: { value: "ab" } });
    await waitFor(() => expect(searchSignals).toHaveLength(1), { timeout: 2000 });
    expect(await screen.findByText("Searching")).toBeInTheDocument();

    fireEvent.change(box, { target: { value: "abc" } });
    expect(await screen.findByRole("option", { name: /mure/ }, { timeout: 2000 })).toBeInTheDocument();
    expect(searchSignals[0].aborted).toBe(true);

    await act(async () => {
      releaseFirst(json({ snapshotId: 1, q: "ab", total: 9, hits: { "p:hippo": 9 }, nameMatches: [] }));
    });
    const list = within(screen.getByRole("listbox", { name: "Search results" }));
    expect(list.getAllByRole("option")).toHaveLength(1);
    expect(list.queryByRole("option", { name: /hippo/ })).toBeNull();
  });
});

describe("App: Board", () => {
  it("T9: #/board shows the Board with exactly one Refresh and no Health search", async () => {
    window.history.replaceState(null, "", "#/board");
    const { stub } = fetchRouter({ "/api/cards": () => json({ cards: [] }) });
    vi.stubGlobal("fetch", stub);
    render(<App />);

    expect(await screen.findByText("no cards yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^refresh/i })).toHaveLength(1);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText(/^Updated /)).toBeNull();
  });

  it("switches from Health to the Board and back through the view switch", async () => {
    const router = fetchRouter({
      "/api/overview": () => json(makeOverview([hippo])),
      "/api/cards": () => json({ cards: [] }),
    });
    vi.stubGlobal("fetch", router.stub);
    render(<App />);
    await screen.findByText("Total memories");

    fireEvent.click(screen.getByRole("radio", { name: "Card board" }));
    expect(await screen.findByText("no cards yet")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/board");

    fireEvent.click(screen.getByRole("radio", { name: "Memory health" }));
    expect(await screen.findByText("Total memories")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/");
  });
});
