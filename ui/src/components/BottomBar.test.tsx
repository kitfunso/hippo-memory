/**
 * v0.28 (E2 real-edges) — BottomBar dynamic affordance tests.
 *
 * Verifies the 4 affordance modes (plan-design-critic R1 must-fix #5):
 * BottomBar copy must match what actually renders right now. Tested via
 * the pure buildAffordance helper exported alongside the component.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BottomBar, buildAffordance } from "./BottomBar.js";
import type { EdgeCounts } from "../engine/scene.js";

const NO_EDGES: EdgeCounts = {
  openConflicts: 0,
  resolvedConflicts: 0,
  sharedTag: 0,
  sharedTagBailed: false,
};

describe("buildAffordance (BottomBar dynamic copy)", () => {
  it("base case: no edges, layer mode = 'size = retrievals · opacity = strength'", () => {
    const copy = buildAffordance("layer", NO_EDGES);
    expect(copy).toBe("size = retrievals · opacity = strength");
  });

  it("layer + only resolved conflicts = appends 'lines = conflicts (resolved)'", () => {
    const copy = buildAffordance("layer", { ...NO_EDGES, resolvedConflicts: 1117 });
    expect(copy).toBe("size = retrievals · opacity = strength · lines = conflicts (resolved)");
  });

  it("layer + open + resolved = lists both line classes", () => {
    const copy = buildAffordance("layer", {
      ...NO_EDGES,
      openConflicts: 3,
      resolvedConflicts: 5,
    });
    expect(copy).toBe("size = retrievals · opacity = strength · lines = conflicts (open) / conflicts (resolved)");
  });

  it("shared-tag only, no bail = lists 'shared tags' (no hint)", () => {
    const copy = buildAffordance("layer", { ...NO_EDGES, sharedTag: 50 });
    expect(copy).toBe("size = retrievals · opacity = strength · lines = shared tags");
  });

  it("BAIL HINT: resolved conflicts + sharedTagBailed + sharedTag=0", () => {
    const copy = buildAffordance("layer", {
      ...NO_EDGES,
      resolvedConflicts: 1117,
      sharedTagBailed: true,
      sharedTag: 0,
    });
    expect(copy).toBe(
      "size = retrievals · opacity = strength · lines = conflicts (resolved) · filter to <500 for tag edges",
    );
  });

  it("no hint when sharedTagBailed=true BUT sharedTag>0 (rendering happened anyway)", () => {
    const copy = buildAffordance("layer", {
      ...NO_EDGES,
      sharedTag: 25,
      sharedTagBailed: true,
    });
    expect(copy).not.toContain("filter to <500");
    expect(copy).toContain("lines = shared tags");
  });

  it("E1 carryover: color != layer appends 'color = <mode>'", () => {
    const copy = buildAffordance("tag", NO_EDGES);
    expect(copy).toBe("size = retrievals · opacity = strength · color = tag");
  });

  it("combined: tag mode + open conflicts + shared tags + no bail", () => {
    const copy = buildAffordance("path", {
      ...NO_EDGES,
      openConflicts: 2,
      sharedTag: 100,
    });
    expect(copy).toBe(
      "size = retrievals · opacity = strength · lines = conflicts (open) / shared tags · color = path",
    );
  });

  it("undefined edgeCounts: behaves like NO_EDGES + no hint", () => {
    const copy = buildAffordance("layer", undefined);
    expect(copy).toBe("size = retrievals · opacity = strength");
  });
});

describe("BottomBar component", () => {
  it("renders the dynamic affordance string", () => {
    render(
      <BottomBar
        drawerOpen={false}
        onToggleDrawer={() => {}}
        visibleCount={50}
        colorMode="tag"
        edgeCounts={{ ...NO_EDGES, resolvedConflicts: 1117, sharedTagBailed: true }}
      />,
    );
    // The hint should be in the rendered DOM.
    expect(screen.getByText(/filter to <500 for tag edges/)).toBeInTheDocument();
  });

  it("renders base affordance when no edgeCounts prop given", () => {
    render(
      <BottomBar
        drawerOpen={false}
        onToggleDrawer={() => {}}
        visibleCount={50}
      />,
    );
    // Should contain the base copy, not the bail hint.
    expect(screen.getByText("size = retrievals · opacity = strength")).toBeInTheDocument();
  });
});
