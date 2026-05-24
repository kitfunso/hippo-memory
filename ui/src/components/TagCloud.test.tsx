/**
 * E3 TagCloud tests. Verify frequency-sort + top-N truncation + click handler.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TagCloud, deriveTagFrequencies } from "./TagCloud.js";
import type { Memory } from "../types.js";

function mem(id: string, tags: string[]): Memory {
  return {
    id, content: `c-${id}`, tags, layer: "episodic", strength: 0.5,
    half_life_days: 30, retrieval_count: 1, schema_fit: 0.5,
    emotional_valence: "neutral", confidence: "inferred", pinned: false,
    created: "2026-05-01T00:00:00Z", last_retrieved: "2026-05-20T00:00:00Z",
    age_days: 10, projected_strength_7d: 0.5, projected_strength_30d: 0.5,
  };
}

describe("deriveTagFrequencies", () => {
  it("counts tags across visible memories, sorts by frequency desc", () => {
    const memories = [
      mem("A", ["foo", "bar"]),
      mem("B", ["foo"]),
      mem("C", ["foo", "baz"]),
      mem("D", ["bar"]),
    ];
    const result = deriveTagFrequencies(memories, new Set());
    expect(result).toEqual([["foo", 3], ["bar", 2], ["baz", 1]]);
  });

  it("ties broken by tag name asc (deterministic)", () => {
    const memories = [
      mem("A", ["zeta"]),
      mem("B", ["alpha"]),
      mem("C", ["mu"]),
    ];
    const result = deriveTagFrequencies(memories, new Set());
    expect(result).toEqual([["alpha", 1], ["mu", 1], ["zeta", 1]]);
  });

  it("visibleIds filter restricts counts to that subset", () => {
    const memories = [
      mem("A", ["foo"]),
      mem("B", ["foo"]),
      mem("C", ["bar"]),
    ];
    // Only count A and B's tags.
    const result = deriveTagFrequencies(memories, new Set(["A", "B"]));
    expect(result).toEqual([["foo", 2]]);
  });

  it("empty memories: returns empty array", () => {
    expect(deriveTagFrequencies([], new Set())).toEqual([]);
  });
});

describe("TagCloud component", () => {
  const memories = [
    mem("A", ["foo", "bar"]),
    mem("B", ["foo"]),
    mem("C", ["foo", "baz"]),
    mem("D", ["bar"]),
    mem("E", ["other"]),
  ];

  it("renders tags in frequency order", () => {
    render(<TagCloud memories={memories} visibleIds={new Set()} onTagClick={vi.fn()} />);
    const buttons = screen.getAllByRole("button");
    const tagOrder = buttons.map((b) => b.textContent?.split(/\d/)[0]?.trim());
    expect(tagOrder.slice(0, 3)).toEqual(["foo", "bar", "baz"]);
  });

  it("topN truncates the rendered list", () => {
    render(<TagCloud memories={memories} visibleIds={new Set()} onTagClick={vi.fn()} topN={2} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
  });

  it("click invokes onTagClick with the tag string", () => {
    const onTagClick = vi.fn();
    render(<TagCloud memories={memories} visibleIds={new Set()} onTagClick={onTagClick} />);
    const fooBtn = screen.getByRole("button", { name: /Filter to tag foo/i });
    fireEvent.click(fooBtn);
    expect(onTagClick).toHaveBeenCalledWith("foo");
  });

  it("shows count next to each tag", () => {
    render(<TagCloud memories={memories} visibleIds={new Set()} onTagClick={vi.fn()} />);
    const fooBtn = screen.getByRole("button", { name: /Filter to tag foo/i });
    expect(fooBtn.textContent).toMatch(/foo.*3/);
  });

  it("zero tags: renders 'no tags' empty state", () => {
    const empty: Memory[] = [];
    render(<TagCloud memories={empty} visibleIds={new Set()} onTagClick={vi.fn()} />);
    expect(screen.getByText(/no tags in the current view/i)).toBeInTheDocument();
  });
});
