import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { VTable } from "./VTable";

const COLUMNS = [{ key: "name", label: "Name", width: "1fr" }] as const;
const ROW = 44;
const HEAD = 45;
const VIEW = 300;

function stubGeometry() {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("vt") ? VIEW : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("vt-head") ? HEAD : 0;
  });
}

function mount(count = 100, empty: ReactNode = "nothing") {
  const onActivate = vi.fn();
  render(
    <VTable
      id="t"
      label="Rows"
      columns={COLUMNS}
      count={count}
      rowHeight={ROW}
      renderRow={(i) => <div role="gridcell">row {i}</div>}
      onActivate={onActivate}
      empty={empty}
    />,
  );
  const grid = screen.getByRole("grid", { name: "Rows" });
  // jsdom keeps scrollTop at 0, so back it with a plain value the hook can write.
  let top = 0;
  Object.defineProperty(grid, "scrollTop", { configurable: true, get: () => top, set: (v: number) => void (top = v) });
  return { grid, onActivate };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VTable scroller", () => {
  it("is the focusable grid itself, with only the header row and the rowgroup as children", () => {
    const { grid } = mount();
    expect(grid).toHaveAttribute("tabindex", "0");
    expect(Array.from(grid.children).map((c) => c.getAttribute("role"))).toEqual(["row", "rowgroup"]);
    expect(document.querySelector(".vt-body")).toBeNull();
  });

  it("keeps the active row below the sticky header when the keyboard scrolls down", () => {
    stubGeometry();
    const { grid } = mount();
    grid.focus();
    fireEvent.keyDown(grid, { key: "End" });
    expect(grid.scrollTop).toBe(100 * ROW - (VIEW - HEAD));
  });

  it("leaves the scroll position and opens the clicked row when a press focuses the root", async () => {
    stubGeometry();
    const { grid, onActivate } = mount(400);
    grid.scrollTop = 200 * ROW;
    fireEvent.scroll(grid);
    vi.spyOn(grid, "matches").mockReturnValue(false);

    fireEvent.focus(grid);
    fireEvent.click(await screen.findByText("row 205"));

    expect(grid.scrollTop).toBe(200 * ROW);
    expect(onActivate).toHaveBeenCalledWith(205);
  });

  it("picks the first visible row, not row 0, when the keyboard focuses the root", () => {
    stubGeometry();
    const { grid } = mount(400);
    grid.scrollTop = 200 * ROW + 10;
    fireEvent.scroll(grid);
    vi.spyOn(grid, "matches").mockImplementation((query) => query === ":focus-visible");

    fireEvent.focus(grid);

    expect(grid).toHaveAttribute("aria-activedescendant", "t-r201");
    expect(grid.scrollTop).toBe(200 * ROW + 10);
  });

  it("renders only the rows that fit below the header plus overscan", () => {
    stubGeometry();
    mount();
    expect(screen.getAllByRole("row").length - 1).toBe(Math.ceil((VIEW - HEAD) / ROW) + 4);
  });

  it("keeps the empty-state buttons outside the grid", () => {
    const { grid } = mount(0, <button type="button">Clear filters</button>);
    expect(Array.from(grid.children).map((c) => c.getAttribute("role"))).toEqual(["row", "rowgroup"]);
    expect(within(grid).queryByRole("button", { name: "Clear filters" })).toBeNull();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
  });
});
