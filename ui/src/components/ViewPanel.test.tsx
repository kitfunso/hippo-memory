/**
 * v0.27 — ViewPanel tests. Verifies the 3-button segmented radio:
 *
 *   - 3 buttons render (layer | tag | path), no confidence button
 *   - aria-checked reflects filterState.colorMode
 *   - Click invokes setColorMode with the matching ColorMode
 *   - aria-labels are present on each radio
 *   - radiogroup role + aria-label present on group
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ViewPanel } from "./ViewPanel.js";
import { INITIAL_FILTER_STATE, type FilterState } from "../state/filterState.js";

function buildState(overrides: Partial<FilterState> = {}): FilterState {
  return { ...INITIAL_FILTER_STATE, ...overrides };
}

describe("ViewPanel", () => {
  it("renders 3 radio buttons (layer, tag, path)", () => {
    render(<ViewPanel filterState={buildState()} setColorMode={() => {}} />);
    const buttons = screen.getAllByRole("radio");
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toHaveTextContent("layer");
    expect(buttons[1]).toHaveTextContent("tag");
    expect(buttons[2]).toHaveTextContent("path");
  });

  it("aria-checked matches the active colorMode (layer default)", () => {
    render(<ViewPanel filterState={buildState({ colorMode: "layer" })} setColorMode={() => {}} />);
    const buttons = screen.getAllByRole("radio");
    expect(buttons[0]?.getAttribute("aria-checked")).toBe("true");
    expect(buttons[1]?.getAttribute("aria-checked")).toBe("false");
    expect(buttons[2]?.getAttribute("aria-checked")).toBe("false");
  });

  it("aria-checked shifts when colorMode is 'tag'", () => {
    render(<ViewPanel filterState={buildState({ colorMode: "tag" })} setColorMode={() => {}} />);
    const buttons = screen.getAllByRole("radio");
    expect(buttons[0]?.getAttribute("aria-checked")).toBe("false");
    expect(buttons[1]?.getAttribute("aria-checked")).toBe("true");
    expect(buttons[2]?.getAttribute("aria-checked")).toBe("false");
  });

  it("clicking a button invokes setColorMode with the matching ColorMode", () => {
    const setColorMode = vi.fn();
    render(<ViewPanel filterState={buildState()} setColorMode={setColorMode} />);
    const buttons = screen.getAllByRole("radio");
    fireEvent.click(buttons[2]!); // path
    expect(setColorMode).toHaveBeenCalledWith("path");
    fireEvent.click(buttons[1]!); // tag
    expect(setColorMode).toHaveBeenCalledWith("tag");
    fireEvent.click(buttons[0]!); // layer
    expect(setColorMode).toHaveBeenCalledWith("layer");
    expect(setColorMode).toHaveBeenCalledTimes(3);
  });

  it("renders the active mode in the filterValue chip (not just the radio label)", () => {
    // The filterValue chip is in the label row, NOT a radio role. Use the
    // structural assertion that "tag" appears more than once in tag mode
    // (once on the radio button label, once in the filterValue chip).
    const { rerender } = render(
      <ViewPanel filterState={buildState({ colorMode: "tag" })} setColorMode={() => {}} />,
    );
    expect(screen.getAllByText("tag").length).toBeGreaterThanOrEqual(2);
    rerender(<ViewPanel filterState={buildState({ colorMode: "path" })} setColorMode={() => {}} />);
    expect(screen.getAllByText("path").length).toBeGreaterThanOrEqual(2);
  });

  it("radiogroup has aria-label", () => {
    render(<ViewPanel filterState={buildState()} setColorMode={() => {}} />);
    const group = screen.getByRole("radiogroup");
    expect(group).toHaveAttribute("aria-label", "Color mode");
  });

  it("each radio has a descriptive aria-label", () => {
    render(<ViewPanel filterState={buildState()} setColorMode={() => {}} />);
    expect(screen.getByRole("radio", { name: /buffer, episodic, semantic/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /top topic tag/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /project path/i })).toBeInTheDocument();
  });
});
