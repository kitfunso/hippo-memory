import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ViewSwitch } from "./ViewSwitch.js";

describe("ViewSwitch", () => {
  it("V1: exposes a named radiogroup whose checked radio has aria-checked true and tabindex 0", () => {
    render(<ViewSwitch view="map" onChange={vi.fn()} />);
    expect(screen.getByRole("radiogroup", { name: "Dashboard view" })).toBeInTheDocument();

    const mapRadio = screen.getByRole("radio", { name: "Memory map" });
    const boardRadio = screen.getByRole("radio", { name: "Card board" });
    expect(mapRadio).toHaveAttribute("aria-checked", "true");
    expect(mapRadio).toHaveAttribute("tabindex", "0");
    expect(boardRadio).toHaveAttribute("aria-checked", "false");
    expect(boardRadio).toHaveAttribute("tabindex", "-1");
  });

  it("V2: clicking the unchecked radio calls onChange once; clicking the checked radio does not", () => {
    const onChange = vi.fn();
    render(<ViewSwitch view="map" onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "Memory map" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Card board" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("board");
  });

  it("V3: each arrow key on the group calls onChange with the other view", () => {
    const onChange = vi.fn();
    render(<ViewSwitch view="map" onChange={onChange} />);
    const group = screen.getByRole("radiogroup", { name: "Dashboard view" });
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      onChange.mockClear();
      fireEvent.keyDown(group, { key });
      expect(onChange).toHaveBeenCalledWith("board");
    }
  });

  it("V4: autoFocus focuses the checked radio; without it, focus stays on document.body", () => {
    const { unmount } = render(<ViewSwitch view="map" onChange={vi.fn()} autoFocus />);
    expect(screen.getByRole("radio", { name: "Memory map" })).toHaveFocus();
    unmount();

    render(<ViewSwitch view="map" onChange={vi.fn()} />);
    expect(document.body).toHaveFocus();
  });
});
