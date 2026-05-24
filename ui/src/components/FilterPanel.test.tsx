/**
 * E3 FilterPanel UI tests. Verify checkbox toggles + range slider changes
 * + age slider 'any' state forward to the right setter.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilterPanel } from "./FilterPanel.js";
import { INITIAL_FILTER_STATE, type FilterState } from "../state/filterState.js";

function renderPanel(overrides: { filterState?: Partial<FilterState> } = {}) {
  const setLayers = vi.fn();
  const setStrengthRange = vi.fn();
  const setConfidences = vi.fn();
  const setAgeMaxDays = vi.fn();
  const filterState: FilterState = { ...INITIAL_FILTER_STATE, ...overrides.filterState };
  render(
    <FilterPanel
      filterState={filterState}
      setLayers={setLayers}
      setStrengthRange={setStrengthRange}
      setConfidences={setConfidences}
      setAgeMaxDays={setAgeMaxDays}
    />,
  );
  return { setLayers, setStrengthRange, setConfidences, setAgeMaxDays };
}

describe("FilterPanel (E3)", () => {
  it("clicking 'buffer' from the all-active state EXCLUDES it (other two get checked)", () => {
    // Code-review-critic HIGH #2 fix. The old behavior was: click buffer
    // when no filter active -> set becomes {buffer} -> filter shows ONLY
    // buffer = inverse of user intent. New: seed the set with the other
    // two layers so unchecking buffer leaves episodic + semantic checked.
    const { setLayers } = renderPanel();
    const buffer = screen.getByLabelText("Filter buffer") as HTMLInputElement;
    fireEvent.click(buffer);
    expect(setLayers).toHaveBeenCalledTimes(1);
    const arg = setLayers.mock.calls[0]![0] as Set<string>;
    expect(arg.has("buffer")).toBe(false);
    expect(arg.has("episodic")).toBe(true);
    expect(arg.has("semantic")).toBe(true);
    expect(arg.size).toBe(2);
  });

  it("unchecking the last filtered layer resets to 'all' (avoids zero-vis state)", () => {
    const { setLayers } = renderPanel({ filterState: { layers: new Set(["episodic"]) } });
    const episodic = screen.getByLabelText("Filter episodic") as HTMLInputElement;
    fireEvent.click(episodic);
    const arg = setLayers.mock.calls[0]![0] as Set<string>;
    expect(arg.size).toBe(0); // back to "all"
  });

  it("strength min slider calls setStrengthRange with clamped value", () => {
    const { setStrengthRange } = renderPanel();
    const minSlider = screen.getByLabelText("Strength minimum") as HTMLInputElement;
    fireEvent.change(minSlider, { target: { value: "0.4" } });
    expect(setStrengthRange).toHaveBeenCalledWith([0.4, 1]);
  });

  it("strength min crossing max SWAPS rather than collapsing to a point", () => {
    // Code-review-critic HIGH #3 fix. Old behavior was clamp-to-max, which
    // produced a [0.3, 0.3] zero-width range that hid every memory whose
    // strength wasn't exactly 0.3. New behavior swaps so the range stays
    // meaningful — dragging min up past max gives [max, new_min] (i.e. the
    // values are reordered).
    const { setStrengthRange } = renderPanel({ filterState: { strengthRange: [0, 0.3] } });
    const minSlider = screen.getByLabelText("Strength minimum") as HTMLInputElement;
    fireEvent.change(minSlider, { target: { value: "0.9" } });
    expect(setStrengthRange).toHaveBeenCalledWith([0.3, 0.9]);
  });

  it("strength max crossing min SWAPS rather than collapsing", () => {
    const { setStrengthRange } = renderPanel({ filterState: { strengthRange: [0.5, 1] } });
    const maxSlider = screen.getByLabelText("Strength maximum") as HTMLInputElement;
    fireEvent.change(maxSlider, { target: { value: "0.1" } });
    expect(setStrengthRange).toHaveBeenCalledWith([0.1, 0.5]);
  });

  it("clicking 'verified' from all-active state EXCLUDES it (other three checked)", () => {
    // Same HIGH #2 fix as layers — first uncheck from "all" seeds the rest.
    const { setConfidences } = renderPanel();
    const verified = screen.getByLabelText("Filter verified") as HTMLInputElement;
    fireEvent.click(verified);
    const arg = setConfidences.mock.calls[0]![0] as Set<string>;
    expect(arg.has("verified")).toBe(false);
    expect(arg.size).toBe(3);
    expect(arg.has("observed")).toBe(true);
    expect(arg.has("inferred")).toBe(true);
    expect(arg.has("stale")).toBe(true);
  });

  it("age slider at max (365) calls setAgeMaxDays with null (= 'any')", () => {
    const { setAgeMaxDays } = renderPanel({ filterState: { ageMaxDays: 100 } });
    const ageSlider = screen.getByLabelText("Max age in days") as HTMLInputElement;
    fireEvent.change(ageSlider, { target: { value: "365" } });
    expect(setAgeMaxDays).toHaveBeenCalledWith(null);
  });

  it("age slider below 365 calls setAgeMaxDays with the number", () => {
    const { setAgeMaxDays } = renderPanel({ filterState: { ageMaxDays: null } });
    const ageSlider = screen.getByLabelText("Max age in days") as HTMLInputElement;
    fireEvent.change(ageSlider, { target: { value: "30" } });
    expect(setAgeMaxDays).toHaveBeenCalledWith(30);
  });

  it("displays current strength range numerically", () => {
    renderPanel({ filterState: { strengthRange: [0.25, 0.75] } });
    expect(screen.getByText(/0\.25.*0\.75/)).toBeInTheDocument();
  });

  it("displays 'all' when layers set is empty", () => {
    renderPanel({ filterState: { layers: new Set() } });
    const layerSection = screen.getByText("Layer").parentElement!;
    expect(layerSection.textContent).toContain("all");
  });

  it("displays '2/3' when 2 layers checked", () => {
    renderPanel({ filterState: { layers: new Set(["buffer", "episodic"]) } });
    expect(screen.getByText("2/3")).toBeInTheDocument();
  });
});
