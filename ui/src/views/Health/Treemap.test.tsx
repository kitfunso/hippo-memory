import { createRef, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { makeProject } from "../../testing/fixtures";
import { HOME_CAMERA } from "./canvas/camera";
import { Tip, type TipHandle } from "./Tip";
import { Treemap, type TreemapMemory } from "./Treemap";

function mount() {
  const tip = createRef<TipHandle>();
  const memory: RefObject<TreemapMemory> = { current: { cam: HOME_CAMERA, selKey: null } };
  const projects = [makeProject("alpha", { live: 300 }), makeProject("beta", { live: 100 })];
  render(
    <>
      <Treemap projects={projects} hits={null} query="" memory={memory} tip={tip} onOpen={vi.fn()} />
      <Tip ref={tip} />
    </>,
  );
  return screen.getByRole("application");
}

function tap(canvas: HTMLElement) {
  const at = { clientX: 40, clientY: 40, pointerType: "touch", button: 0 };
  fireEvent.pointerDown(canvas, at);
  fireEvent.pointerUp(canvas, at);
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 400));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Treemap tap tip", () => {
  it("keeps the closable tap tip when the canvas takes pointer focus after pointerup", () => {
    const canvas = mount();
    tap(canvas);
    expect(screen.getByRole("button", { name: "Close tip" })).toBeInTheDocument();

    fireEvent.focus(canvas);
    expect(screen.getByRole("button", { name: "Close tip" })).toBeInTheDocument();
    expect(screen.getByTestId("treemap-live")).not.toBeEmptyDOMElement();
  });

  it("closes the tap tip with its Close button", () => {
    const canvas = mount();
    tap(canvas);
    fireEvent.focus(canvas);
    fireEvent.click(screen.getByRole("button", { name: "Close tip" }));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows the tile tip on keyboard focus", () => {
    const canvas = mount();
    vi.spyOn(canvas, "matches").mockImplementation((q) => q === ":focus-visible");
    fireEvent.focus(canvas);
    expect(screen.getByRole("tooltip")).toHaveTextContent("memories");
    expect(screen.queryByRole("button", { name: "Close tip" })).toBeNull();
  });

  it("replaces the tap tip when an arrow key moves the selection", () => {
    const canvas = mount();
    tap(canvas);
    expect(screen.getByRole("button", { name: "Close tip" })).toBeInTheDocument();
    for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"]) fireEvent.keyDown(canvas, { key });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close tip" })).toBeNull();
  });
});
