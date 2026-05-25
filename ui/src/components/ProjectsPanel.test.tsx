/**
 * v0.29 (E5 S5) — Tests for the Sidebar Projects mini-panel.
 *
 * Coverage: empty state, top-N truncation, +N more affordance, aria-label
 * (design HIGH-1), SVG aria-hidden, SVG dot position formula (design
 * HIGH-2), subtitle copy.
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ProjectsPanel } from "./ProjectsPanel.js";

const LAYOUT_BOUND = 30;

function project(tag: string, count: number, x: number, y: number) {
  return { tag, count, anchor: { x, y } };
}

describe("ProjectsPanel", () => {
  it("returns null when projects is empty", () => {
    const { container } = render(
      <ProjectsPanel projects={[]} onSelectProject={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders top-N projects in order", () => {
    const projects = [
      project("path:hippo", 173, 18, 0),
      project("path:quantamental", 247, -9, 16),
      project("path:phzse", 155, -9, -16),
    ];
    const { getAllByRole } = render(
      <ProjectsPanel projects={projects} onSelectProject={() => {}} />,
    );
    const buttons = getAllByRole("button");
    expect(buttons).toHaveLength(3);
    // Order matches input.
    expect(buttons[0].textContent).toContain("hippo");
    expect(buttons[1].textContent).toContain("quantamental");
    expect(buttons[2].textContent).toContain("phzse");
  });

  it("renders subtitle '(ordered by first-seen)'", () => {
    const projects = [project("path:hippo", 1, 0, 0)];
    const { getByText } = render(
      <ProjectsPanel projects={projects} onSelectProject={() => {}} />,
    );
    expect(getByText("(ordered by first-seen)")).toBeDefined();
  });

  it("each button has an aria-label of the form 'Filter to project X, N memories' (design HIGH-1) with grammatical pluralization (review MED)", () => {
    const projects = [
      project("path:hippo", 173, 18, 0),
      project("path:quantamental", 247, -9, 16),
      project("path:singleton", 1, 0, 0),
    ];
    const { getByLabelText } = render(
      <ProjectsPanel projects={projects} onSelectProject={() => {}} />,
    );
    expect(getByLabelText("Filter to project hippo, 173 memories")).toBeDefined();
    expect(getByLabelText("Filter to project quantamental, 247 memories")).toBeDefined();
    // Singular form for count=1 (was '1 memories' in v1 — ungrammatical SR).
    expect(getByLabelText("Filter to project singleton, 1 memory")).toBeDefined();
  });

  it("each SVG has aria-hidden='true' (decorative, screen readers skip)", () => {
    const projects = [project("path:hippo", 1, 0, 0)];
    const { container } = render(
      <ProjectsPanel projects={projects} onSelectProject={() => {}} />,
    );
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });

  it("SVG dot position computes from MINI_CENTER + (anchor.x/LAYOUT_BOUND)*MINI_INNER_RADIUS (design HIGH-2)", () => {
    // anchor.x = LAYOUT_BOUND → dotX should be at MINI_CENTER + MINI_INNER_RADIUS = 15.
    // anchor.y = -LAYOUT_BOUND → dotY at MINI_CENTER - MINI_INNER_RADIUS = 5.
    const projects = [project("path:edge", 1, LAYOUT_BOUND, -LAYOUT_BOUND)];
    const { container } = render(
      <ProjectsPanel projects={projects} onSelectProject={() => {}} />,
    );
    const circles = container.querySelectorAll("circle");
    expect(circles.length).toBe(2); // outer ring + dot
    const dot = circles[1]; // second circle = the filled dot
    expect(dot.getAttribute("cx")).toBe("15");
    expect(dot.getAttribute("cy")).toBe("5");
  });

  it("click fires onSelectProject with the tag string", () => {
    const onSelectProject = vi.fn();
    const projects = [project("path:hippo", 1, 0, 0)];
    const { getByLabelText } = render(
      <ProjectsPanel projects={projects} onSelectProject={onSelectProject} />,
    );
    fireEvent.click(getByLabelText("Filter to project hippo, 1 memory"));
    expect(onSelectProject).toHaveBeenCalledWith("path:hippo");
  });

  it("renders '+N more' affordance when projects.length > 10", () => {
    const projects = Array.from({ length: 17 }, (_, i) =>
      project(`path:proj${i}`, 1, 0, 0),
    );
    const { getByText } = render(
      <ProjectsPanel projects={projects} onSelectProject={() => {}} />,
    );
    expect(getByText("+7 more")).toBeDefined();
  });

  it("does NOT render '+N more' when projects.length <= 10", () => {
    const projects = Array.from({ length: 10 }, (_, i) =>
      project(`path:proj${i}`, 1, 0, 0),
    );
    const { queryByText } = render(
      <ProjectsPanel projects={projects} onSelectProject={() => {}} />,
    );
    expect(queryByText(/\+\d+ more/)).toBeNull();
  });

  it("button has type='button' (defensive, avoids accidental form submit)", () => {
    const projects = [project("path:hippo", 1, 0, 0)];
    const { getByLabelText } = render(
      <ProjectsPanel projects={projects} onSelectProject={() => {}} />,
    );
    const btn = getByLabelText("Filter to project hippo, 1 memory");
    expect(btn.getAttribute("type")).toBe("button");
  });
});
