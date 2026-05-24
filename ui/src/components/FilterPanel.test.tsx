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
  it("clicking a layer checkbox calls setLayers with the toggled set", () => {
    const { setLayers } = renderPanel();
    const buffer = screen.getByLabelText("Filter buffer") as HTMLInputElement;
    fireEvent.click(buffer);
    expect(setLayers).toHaveBeenCalledTimes(1);
    const arg = setLayers.mock.calls[0]![0] as Set<string>;
    expect(arg.has("buffer")).toBe(true);
    expect(arg.size).toBe(1);
  });

  it("strength min slider calls setStrengthRange with clamped value", () => {
    const { setStrengthRange } = renderPanel();
    const minSlider = screen.getByLabelText("Strength minimum") as HTMLInputElement;
    fireEvent.change(minSlider, { target: { value: "0.4" } });
    expect(setStrengthRange).toHaveBeenCalledWith([0.4, 1]);
  });

  it("strength min cannot exceed max", () => {
    const { setStrengthRange } = renderPanel({ filterState: { strengthRange: [0, 0.3] } });
    const minSlider = screen.getByLabelText("Strength minimum") as HTMLInputElement;
    // Try to push min above current max (0.3); should clamp to 0.3.
    fireEvent.change(minSlider, { target: { value: "0.9" } });
    expect(setStrengthRange).toHaveBeenCalledWith([0.3, 0.3]);
  });

  it("clicking confidence checkbox calls setConfidences", () => {
    const { setConfidences } = renderPanel();
    const verified = screen.getByLabelText("Filter verified") as HTMLInputElement;
    fireEvent.click(verified);
    const arg = setConfidences.mock.calls[0]![0] as Set<string>;
    expect(arg.has("verified")).toBe(true);
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
