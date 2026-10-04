import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../../App";
import { type Handler, fetchRouter, json, makeDetail, makeOverview, makeProject, stubPhone } from "../../testing/fixtures";
import { makePage, makePointsDetail, makeRow, pageHandler } from "../../testing/memories";
import { makeRows, openHippo } from "../../testing/openHippo";
import { maxLogFor, plotX, plotY } from "./canvas/scatter";

const MEMORIES = "/api/projects/p%3Ahippo/memories";

beforeEach(() => {
  window.history.replaceState(null, "", "#/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "matchMedia");
});

async function rowOf(text: string): Promise<HTMLElement> {
  const row = (await screen.findByText(text)).closest<HTMLElement>("[role=row]");
  if (!row) throw new Error(`no row holds ${text}`);
  return row;
}

describe("ProjectView: table and drawer", () => {
  it("T6: drilling a project requests page 0, and Escape closes the drawer and returns focus to the opening row", async () => {
    const { calls } = openHippo(makeRows(3));
    const row = await rowOf("memory m2");
    expect(calls.some((c) => c.startsWith(`${MEMORIES}?`) && c.includes("offset=0") && c.includes("limit=100"))).toBe(true);

    fireEvent.click(row);
    const drawer = await screen.findByRole("dialog", { name: /Memory m2/ });
    expect(window.location.hash).toBe("#/p/p%3Ahippo/m/m2");
    expect(drawer).toHaveAttribute("aria-modal", "false");
    expect(await within(drawer).findByRole("button", { name: "Pin" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(window.location.hash).toBe("#/p/p%3Ahippo"));
    const grid = screen.getByRole("grid", { name: "Memories" });
    expect(grid).toHaveFocus();
    expect(grid.getAttribute("aria-activedescendant")).toBe(row.id);
  });

  it("sets aria-rowcount and aria-rowindex from the server total and shows the Age column", async () => {
    openHippo(makeRows(5));
    const grid = await screen.findByRole("grid", { name: "Memories" });
    const first = await rowOf("memory m1");
    expect(grid).toHaveAttribute("aria-rowcount", "6");
    expect(within(grid).getByRole("columnheader", { name: /^Age/ })).toBeInTheDocument();
    expect(first).toHaveAttribute("aria-rowindex", "2");
  });

  it("T13: the desktop drawer is non-modal, so table rows stay focusable and arrow keys swap the memory", async () => {
    openHippo(makeRows(3));
    fireEvent.click(await rowOf("memory m1"));
    const drawer = await screen.findByRole("dialog", { name: /Memory m1/ });
    expect(drawer).not.toHaveAttribute("inert");

    const grid = screen.getByRole("grid", { name: "Memories" });
    grid.focus();
    expect(grid).toHaveFocus();
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    await waitFor(() => expect(window.location.hash).toBe("#/p/p%3Ahippo/m/m2"));
    expect(await screen.findByRole("dialog", { name: /Memory m2/ })).toBeInTheDocument();
    expect(grid.closest("[inert]")).toBeNull();
  });

  it("shows No memories match with Clear filters, and Clear filters restores the list", async () => {
    const all = makeRows(2);
    const handler: Handler = (url) => json(makePage(url.searchParams.get("chip") === "pinned" ? [] : all, 0, 100));
    openHippo(all, { extra: { [MEMORIES]: handler } });
    await screen.findByText("memory m1");
    fireEvent.click(screen.getByRole("button", { name: /^Pinned/ }));
    expect(await screen.findByText("No memories match")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByText("memory m1")).toBeInTheDocument();
  });

  it("retries a failed page from its row", async () => {
    let fail = true;
    const handler: Handler = (url) => {
      if (!fail) return pageHandler(makeRows(2))(url);
      fail = false;
      return json({ error: "page failed" }, 500);
    };
    openHippo(makeRows(2), { extra: { [MEMORIES]: handler } });
    expect(await screen.findByText("page failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("memory m1")).toBeInTheDocument();
  });

  it("T14: a slow response for an old chip never overwrites the rows of the newer one", async () => {
    let releaseRisk: (r: Response) => void = () => {};
    const handler: Handler = (url) => {
      const chip = url.searchParams.get("chip");
      if (chip === "risk") return new Promise<Response>((resolve) => (releaseRisk = resolve));
      if (chip === "pinned") return json(makePage([makeRow("fresh1")], 0, 100));
      return json(makePage(makeRows(1), 0, 100));
    };
    openHippo(makeRows(1), { extra: { [MEMORIES]: handler } });
    await screen.findByText("memory m1");

    fireEvent.click(screen.getByRole("button", { name: /^At risk/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Pinned/ }));
    expect(await screen.findByText("memory fresh1")).toBeInTheDocument();

    await act(async () => {
      releaseRisk(json(makePage([makeRow("stale1")], 0, 100)));
    });
    expect(screen.getByText("memory fresh1")).toBeInTheDocument();
    expect(screen.queryByText("memory stale1")).toBeNull();
  });

  it("a dead memory link goes back to the project and toasts without Undo", async () => {
    openHippo(makeRows(2), { memoryId: "gone", extra: { "/api/memory/gone": () => json({ error: "not found" }, 404) } });
    await waitFor(() => expect(window.location.hash).toBe("#/p/p%3Ahippo"));
    const toast = await screen.findByText("That memory was forgotten or merged");
    expect(toast.closest("[role=status]")).not.toHaveAttribute("hidden");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("ProjectView: search", () => {
  it("T11: a project ranked below the dropdown cut still filters its table by the query", async () => {
    const others = Array.from({ length: 7 }, (_, i) => makeProject(`other${i}`));
    const hippo = makeProject("hippo", { live: 3, atRisk: 0 });
    const hits = Object.fromEntries([...others.map((p) => [p.key, 9]), [hippo.key, 1]]);
    const { stub, calls } = fetchRouter({
      "/api/overview": () => json(makeOverview([...others, hippo])),
      "/api/search": () => json({ snapshotId: 1, q: "needle", total: 64, hits, nameMatches: [] }),
      "/api/projects/p%3Ahippo": () => json(makeDetail(hippo)),
      [MEMORIES]: pageHandler(makeRows(1)),
    });
    vi.stubGlobal("fetch", stub);
    render(<App />);
    await screen.findByText("Total memories");

    fireEvent.change(screen.getByRole("combobox", { name: "Search memories" }), { target: { value: "needle" } });
    const results = within(await screen.findByRole("listbox", { name: "Search results" }));
    expect(await results.findAllByRole("option", {}, { timeout: 2000 })).toHaveLength(6);
    expect(results.queryByRole("option", { name: /hippo/ })).toBeNull();

    act(() => {
      window.location.hash = "#/p/p%3Ahippo";
    });
    expect(await screen.findByRole("heading", { level: 1, name: "hippo" })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.startsWith(`${MEMORIES}?`) && c.includes("q=needle"))).toBe(true));
    expect(screen.getByRole("button", { name: "Clear search needle" })).toBeInTheDocument();
  });
});

describe("ProjectView: scatter", () => {
  const stubRect = () =>
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 240, width: 600, height: 240, toJSON: () => ({}) });

  async function openScatter() {
    stubRect();
    const hippo = makeProject("hippo", { live: 1, atRisk: 0 });
    const detail = makePointsDetail(hippo, [[10, 0.5, 2, 1]], ["m1"]);
    openHippo(makeRows(1), { extra: { "/api/projects/p%3Ahippo": () => json(detail) } });
    const canvas = await waitFor(() => {
      const el = document.querySelector<HTMLCanvasElement>("canvas.ov");
      if (!el) throw new Error("scatter overlay canvas not rendered yet");
      return el;
    });
    const plot = { W: 600, H: 240, maxLog: maxLogFor(detail.scatter) };
    const at = { clientX: plotX(plot, 10), clientY: plotY(plot, 0.5), pointerType: "touch", button: 0 };
    return {
      tap: () => {
        fireEvent.pointerDown(canvas, at);
        fireEvent.pointerUp(canvas, at);
      },
    };
  }

  it("T8: on touch the first tap shows the tip and the second tap on the same point opens the memory", async () => {
    const { tap } = await openScatter();
    tap();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("m1");
    expect(screen.getByRole("button", { name: "Close tip" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/p/p%3Ahippo");

    tap();
    await waitFor(() => expect(window.location.hash).toBe("#/p/p%3Ahippo/m/m1"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("T8: tapping elsewhere closes the tip", async () => {
    const { tap } = await openScatter();
    tap();
    await screen.findByRole("tooltip");
    fireEvent.pointerDown(screen.getByRole("heading", { level: 1, name: "hippo" }), { pointerType: "touch" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("describes the scatter for screen readers and binds the number inputs to the filter", async () => {
    stubRect();
    const { calls } = openHippo(makeRows(2));
    const img = await screen.findByRole("img", { name: "Memory age against strength" });
    expect(document.getElementById(img.getAttribute("aria-describedby") ?? "")?.textContent).not.toBe("");

    fireEvent.click(screen.getByText("Filter by age and strength"));
    fireEvent.change(screen.getByLabelText("Age from, days"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Strength to"), { target: { value: "0.4" } });
    await waitFor(() => expect(calls.some((c) => c.includes("amin=5") && c.includes("smax=0.4"))).toBe(true), { timeout: 2000 });
  });
});

describe("ProjectView: phone", () => {
  it("renders a card list with Sort by, a direction toggle, the Brush toggle and crumbs as the first line", async () => {
    stubPhone();
    openHippo(makeRows(3));
    const list = await screen.findByRole("listbox", { name: "Memories" });
    expect(await within(list).findAllByRole("option")).toHaveLength(3);
    expect(screen.getByLabelText("Sort by")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sort direction/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Brush" })).toHaveAttribute("aria-pressed", "false");
    const view = screen.getByRole("heading", { level: 1, name: "hippo" }).closest<HTMLElement>("section");
    if (!view) throw new Error("project view section missing");
    expect(within(view).getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
    expect(view.firstElementChild).toHaveClass("pv-top");
  });

  it("has one Breadcrumb and one Refresh, with the header holding neither crumbs nor Updated", async () => {
    stubPhone();
    openHippo(makeRows(2));
    await screen.findByRole("listbox", { name: "Memories" });
    expect(screen.getAllByRole("navigation", { name: "Breadcrumb" })).toHaveLength(1);
    const refresh = screen.getAllByRole("button", { name: /^refresh/i });
    expect(refresh).toHaveLength(1);
    expect(refresh[0]).toHaveAttribute("aria-label", "Refresh");
    expect(within(document.querySelector<HTMLElement>("header.top")!).queryByText(/^Updated /)).toBeNull();
  });

  it("opens a modal bottom sheet and Escape closes it", async () => {
    stubPhone();
    openHippo(makeRows(2));
    const list = await screen.findByRole("listbox", { name: "Memories" });
    fireEvent.click((await within(list).findAllByRole("option"))[0]);
    const sheet = await screen.findByRole("dialog", { name: /Memory m1/ });
    expect(sheet).toHaveAttribute("aria-modal", "true");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(window.location.hash).toBe("#/p/p%3Ahippo"));
  });
});
