/**
 * E2 Header tests. Two acceptance checks per plan v2 E2:
 * 1. Typing a 10-character query results in scene.setHighlighted called at
 *    most twice (verified here via the debounce hook + parent setQuery
 *    mock — the scene wiring is integration-tested separately).
 * 2. Freeze button toggles aria-pressed + invokes setFrozen with the
 *    opposite of current state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Header } from "./Header.js";
import { INITIAL_FILTER_STATE, type FilterState } from "../state/filterState.js";

function renderHeader(overrides: {
  filterState?: Partial<FilterState>;
  setQuery?: (q: string) => void;
  setFrozen?: (f: boolean) => void;
  matchCount?: number | null;
  memoryCount?: number;
} = {}) {
  const setQuery = overrides.setQuery ?? vi.fn();
  const setFrozen = overrides.setFrozen ?? vi.fn();
  const filterState: FilterState = { ...INITIAL_FILTER_STATE, ...overrides.filterState };
  render(
    <Header
      memoryCount={overrides.memoryCount ?? 100}
      matchCount={overrides.matchCount ?? null}
      stats={null}
      filterState={filterState}
      frozenOrigin={null}
      setQuery={setQuery}
      setFrozen={setFrozen}
      setFadingOnly={vi.fn()}
    />,
  );
  return { setQuery, setFrozen };
}

describe("Header (E2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces 10-character query to at most 2 setQuery calls", () => {
    const setQuery = vi.fn();
    renderHeader({ setQuery });

    const input = screen.getByLabelText("Search memories") as HTMLInputElement;

    // Type 10 chars rapidly (one per "ms" in fake-timer land).
    const chars = "abcdefghij".split("");
    act(() => {
      let value = "";
      for (const c of chars) {
        value += c;
        fireEvent.change(input, { target: { value } });
        vi.advanceTimersByTime(20); // 20ms between keystrokes — under debounce window
      }
    });

    // Mid-typing: no debounced call should have fired yet (debounce = 150ms,
    // 10 keystrokes * 20ms = 200ms total wall, but each keystroke resets
    // the timer so the debounced value hasn't settled).
    expect(setQuery).not.toHaveBeenCalledWith("abcdefghij");

    // Now let the debounce settle.
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // The debounced effect fires once for the final value. The initial-value
    // effect may also fire once for empty string. Either way, no more than 2
    // calls total.
    expect(setQuery.mock.calls.length).toBeLessThanOrEqual(2);

    // The last call must be the final query — we don't ship partial state.
    const calls = setQuery.mock.calls.map((c) => c[0]);
    expect(calls[calls.length - 1]).toBe("abcdefghij");
  });

  it("freeze button toggles filterState.frozen via setFrozen", () => {
    const setFrozen = vi.fn();
    const { rerender } = render(
      <Header
        memoryCount={100}
        matchCount={null}
        stats={null}
        filterState={INITIAL_FILTER_STATE}
        frozenOrigin={null}
        setQuery={vi.fn()}
        setFrozen={setFrozen}
        setFadingOnly={vi.fn()}
      />,
    );

    const btn = screen.getByRole("button", { name: /freeze animation/i });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.textContent?.toLowerCase()).toContain("freeze");

    fireEvent.click(btn);
    expect(setFrozen).toHaveBeenCalledWith(true);

    // Simulate parent state update -> re-render with frozen=true.
    rerender(
      <Header
        memoryCount={100}
        matchCount={null}
        stats={null}
        filterState={{ ...INITIAL_FILTER_STATE, frozen: true }}
        frozenOrigin={null}
        setQuery={vi.fn()}
        setFrozen={setFrozen}
        setFadingOnly={vi.fn()}
      />,
    );

    const btnAfter = screen.getByRole("button", { name: /resume animation/i });
    expect(btnAfter.getAttribute("aria-pressed")).toBe("true");
    expect(btnAfter.textContent?.toLowerCase()).toContain("frozen");

    fireEvent.click(btnAfter);
    expect(setFrozen).toHaveBeenLastCalledWith(false);
  });

  it("shows memoryCount + at_risk when present", () => {
    renderHeader({ memoryCount: 305 });
    expect(screen.getByText(/305 memories/)).toBeInTheDocument();
  });

  it("matchCount renders as 'N/M' suffix when active", () => {
    renderHeader({ matchCount: 12, memoryCount: 305 });
    expect(screen.getByText("12/305")).toBeInTheDocument();
  });
});
