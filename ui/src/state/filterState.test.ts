/**
 * E3 deriveVisibleIds: every filter combination must produce the correct
 * visible-id set against a fixed memory fixture. This is the canonical
 * filter logic — FilterPanel.tsx just edits state; this function decides
 * what's visible.
 */

import { describe, it, expect } from "vitest";
import type { Memory } from "../types.js";
import {
  deriveVisibleIds,
  INITIAL_FILTER_STATE,
  isFading,
  isFilterActive,
  type FilterState,
  type Layer,
  type Confidence,
} from "./filterState.js";

function mem(over: Partial<Memory> & { id: string }): Memory {
  return {
    id: over.id,
    content: over.content ?? `content-${over.id}`,
    tags: over.tags ?? [],
    layer: over.layer ?? "episodic",
    strength: over.strength ?? 0.5,
    half_life_days: over.half_life_days ?? 30,
    retrieval_count: over.retrieval_count ?? 1,
    schema_fit: over.schema_fit ?? 0.5,
    emotional_valence: over.emotional_valence ?? "neutral",
    confidence: over.confidence ?? "inferred",
    pinned: over.pinned ?? false,
    created: over.created ?? "2026-05-01T00:00:00Z",
    last_retrieved: over.last_retrieved ?? "2026-05-20T00:00:00Z",
    age_days: over.age_days ?? 10,
    projected_strength_7d: over.projected_strength_7d ?? 0.5,
    projected_strength_30d: over.projected_strength_30d ?? 0.5,
  };
}

const FIXTURE: Memory[] = [
  mem({ id: "A", layer: "buffer", strength: 0.9, confidence: "verified", age_days: 5, tags: ["alpha", "beta"], content: "alpha note" }),
  mem({ id: "B", layer: "buffer", strength: 0.3, confidence: "inferred", age_days: 60, tags: ["beta"], content: "beta note" }),
  mem({ id: "C", layer: "episodic", strength: 0.6, confidence: "verified", age_days: 15, tags: ["gamma"], content: "gamma note" }),
  mem({ id: "D", layer: "episodic", strength: 0.1, confidence: "observed", age_days: 200, tags: ["alpha"], content: "old alpha" }),
  mem({ id: "E", layer: "semantic", strength: 0.8, confidence: "stale", age_days: 30, tags: ["gamma", "alpha"], content: "deep gamma" }),
];

function ids(set: Set<string>): string[] {
  return Array.from(set).sort();
}

describe("deriveVisibleIds (E3 FilterState)", () => {
  it("no filter active: returns all memory IDs", () => {
    const result = deriveVisibleIds(FIXTURE, INITIAL_FILTER_STATE);
    expect(ids(result)).toEqual(["A", "B", "C", "D", "E"]);
  });

  describe("query filter", () => {
    it("substring on content matches", () => {
      const state: FilterState = { ...INITIAL_FILTER_STATE, query: "alpha" };
      // matches: A (content "alpha note"), D (content "old alpha"), E (tag "alpha")
      expect(ids(deriveVisibleIds(FIXTURE, state))).toEqual(["A", "D", "E"]);
    });

    it("substring on tags matches", () => {
      const state: FilterState = { ...INITIAL_FILTER_STATE, query: "gamma" };
      // matches: C (content + tag), E (content + tag)
      expect(ids(deriveVisibleIds(FIXTURE, state))).toEqual(["C", "E"]);
    });

    it("case-insensitive", () => {
      const state: FilterState = { ...INITIAL_FILTER_STATE, query: "ALPHA" };
      expect(ids(deriveVisibleIds(FIXTURE, state))).toEqual(["A", "D", "E"]);
    });

    it("empty query == no filter", () => {
      const state: FilterState = { ...INITIAL_FILTER_STATE, query: "   " };
      expect(ids(deriveVisibleIds(FIXTURE, state)).length).toBe(5);
    });
  });

  describe("layer filter", () => {
    it("single layer: returns only matching memories", () => {
      const state: FilterState = { ...INITIAL_FILTER_STATE, layers: new Set<Layer>(["buffer"]) };
      expect(ids(deriveVisibleIds(FIXTURE, state))).toEqual(["A", "B"]);
    });

    it("multiple layers (union)", () => {
      const state: FilterState = { ...INITIAL_FILTER_STATE, layers: new Set<Layer>(["buffer", "semantic"]) };
      expect(ids(deriveVisibleIds(FIXTURE, state))).toEqual(["A", "B", "E"]);
    });

    it("empty layers set: no filter (all layers visible)", () => {
      const state: FilterState = { ...INITIAL_FILTER_STATE, layers: new Set() };
      expect(ids(deriveVisibleIds(FIXTURE, state)).length).toBe(5);
    });
  });

  describe("strength filter", () => {
    it("min 0.5 cuts D (0.1) and B (0.3)", () => {
      const state: FilterState = { ...INITIAL_FILTER_STATE, strengthRange: [0.5, 1] };
      expect(ids(deriveVisibleIds(FIXTURE, state))).toEqual(["A", "C", "E"]);
    });

    it("max 0.5 cuts A (0.9), C (0.6), E (0.8)", () => {
      const state: FilterState = { ...INITIAL_FILTER_STATE, strengthRange: [0, 0.5] };
      expect(ids(deriveVisibleIds(FIXTURE, state))).toEqual(["B", "D"]);
    });

    it("range [0,1] = no filter", () => {
      const state: FilterState = { ...INITIAL_FILTER_STATE, strengthRange: [0, 1] };
      expect(ids(deriveVisibleIds(FIXTURE, state)).length).toBe(5);
    });
  });

  describe("confidence filter", () => {
    it("single confidence: returns only matching", () => {
      const state: FilterState = { ...INITIAL_FILTER_STATE, confidences: new Set<Confidence>(["verified"]) };
      expect(ids(deriveVisibleIds(FIXTURE, state))).toEqual(["A", "C"]);
    });

    it("multiple confidences (union)", () => {
      const state: FilterState = { ...INITIAL_FILTER_STATE, confidences: new Set<Confidence>(["verified", "observed"]) };
      expect(ids(deriveVisibleIds(FIXTURE, state))).toEqual(["A", "C", "D"]);
    });

    it("stale confidence picks only E", () => {
      const state: FilterState = { ...INITIAL_FILTER_STATE, confidences: new Set<Confidence>(["stale"]) };
      expect(ids(deriveVisibleIds(FIXTURE, state))).toEqual(["E"]);
    });
  });

  describe("age filter", () => {
    it("ageMaxDays 30 cuts B (60d) and D (200d)", () => {
      const state: FilterState = { ...INITIAL_FILTER_STATE, ageMaxDays: 30 };
      expect(ids(deriveVisibleIds(FIXTURE, state))).toEqual(["A", "C", "E"]);
    });

    it("null = no age filter", () => {
      const state: FilterState = { ...INITIAL_FILTER_STATE, ageMaxDays: null };
      expect(ids(deriveVisibleIds(FIXTURE, state)).length).toBe(5);
    });
  });

  describe("combined filters", () => {
    it("layer + strength: AND semantics", () => {
      const state: FilterState = {
        ...INITIAL_FILTER_STATE,
        layers: new Set<Layer>(["episodic"]),
        strengthRange: [0.5, 1],
      };
      // episodic = C (0.6), D (0.1); strength >= 0.5 keeps only C.
      expect(ids(deriveVisibleIds(FIXTURE, state))).toEqual(["C"]);
    });

    it("query + layer + confidence + age (all 4): correct intersection", () => {
      const state: FilterState = {
        ...INITIAL_FILTER_STATE,
        query: "alpha",
        layers: new Set<Layer>(["semantic"]),
        confidences: new Set<Confidence>(["stale"]),
        ageMaxDays: 60,
      };
      // alpha matches: A, D, E. semantic only: E. stale only: E. <=60d: E (30d).
      expect(ids(deriveVisibleIds(FIXTURE, state))).toEqual(["E"]);
    });

    it("query + layer + strength + confidence + age: empty result", () => {
      const state: FilterState = {
        ...INITIAL_FILTER_STATE,
        query: "gamma",
        layers: new Set<Layer>(["buffer"]), // no buffer memory has gamma
        strengthRange: [0.5, 1],
        confidences: new Set<Confidence>(["verified"]),
        ageMaxDays: 10,
      };
      expect(ids(deriveVisibleIds(FIXTURE, state))).toEqual([]);
    });
  });
});

// v0.26.1 — fading-only filter tests (plan-eng-critic R1 MED #3)
describe("isFading helper (v0.26.1)", () => {
  it("true when strength < 0.1 and not pinned", () => {
    expect(isFading({ strength: 0.05, pinned: false })).toBe(true);
    expect(isFading({ strength: 0.099, pinned: false })).toBe(true);
  });

  it("false at threshold boundary (0.1)", () => {
    expect(isFading({ strength: 0.1, pinned: false })).toBe(false);
  });

  it("false when pinned (regardless of strength)", () => {
    expect(isFading({ strength: 0.001, pinned: true })).toBe(false);
    expect(isFading({ strength: 0.0, pinned: true })).toBe(false);
  });

  it("false when strength >= 0.1", () => {
    expect(isFading({ strength: 0.5, pinned: false })).toBe(false);
    expect(isFading({ strength: 1.0, pinned: false })).toBe(false);
  });
});

describe("isFilterActive + fadingOnly (v0.26.1)", () => {
  it("returns true when only fadingOnly is set, all others default", () => {
    const state: FilterState = { ...INITIAL_FILTER_STATE, fadingOnly: true };
    expect(isFilterActive(state)).toBe(true);
  });

  it("returns false on full default state", () => {
    expect(isFilterActive(INITIAL_FILTER_STATE)).toBe(false);
  });
});

describe("deriveVisibleIds + fadingOnly (v0.26.1)", () => {
  // Build a fading-aware fixture: A & B pinned (never fade), C low-strength
  // unpinned (fading), D normal strength.
  const FADING_FIXTURE: Memory[] = [
    mem({ id: "A", strength: 0.05, pinned: true, layer: "buffer" }), // low but pinned
    mem({ id: "B", strength: 0.5, pinned: true }),                   // normal pinned
    mem({ id: "C", strength: 0.05, pinned: false, layer: "buffer" }), // fading
    mem({ id: "D", strength: 0.05, pinned: false, layer: "episodic" }), // fading
    mem({ id: "E", strength: 0.8, pinned: false }),                   // normal
  ];

  it("fadingOnly true: returns only fading memories", () => {
    const state: FilterState = { ...INITIAL_FILTER_STATE, fadingOnly: true };
    expect(ids(deriveVisibleIds(FADING_FIXTURE, state))).toEqual(["C", "D"]);
  });

  it("fadingOnly true: pinned memories NEVER returned even when strength < 0.1", () => {
    const state: FilterState = { ...INITIAL_FILTER_STATE, fadingOnly: true };
    const result = ids(deriveVisibleIds(FADING_FIXTURE, state));
    expect(result).not.toContain("A"); // A has strength 0.05 but pinned
    expect(result).not.toContain("B");
  });

  it("fadingOnly composes (AND) with layer filter", () => {
    const state: FilterState = {
      ...INITIAL_FILTER_STATE,
      fadingOnly: true,
      layers: new Set<Layer>(["buffer"]),
    };
    // Only C is buffer AND fading (D is episodic)
    expect(ids(deriveVisibleIds(FADING_FIXTURE, state))).toEqual(["C"]);
  });

  it("fadingOnly composes (AND) with query filter", () => {
    const query = "content-C"; // C's default content via mem() helper
    const state: FilterState = { ...INITIAL_FILTER_STATE, fadingOnly: true, query };
    expect(ids(deriveVisibleIds(FADING_FIXTURE, state))).toEqual(["C"]);
  });

  it("fadingOnly false (default): returns all memories", () => {
    expect(ids(deriveVisibleIds(FADING_FIXTURE, INITIAL_FILTER_STATE))).toHaveLength(5);
  });
});

// v0.27 — colorMode is VIEW state, not a filter. Plan v3 S1.
describe("colorMode + isFilterActive (v0.27)", () => {
  it("INITIAL state has colorMode = 'layer'", () => {
    expect(INITIAL_FILTER_STATE.colorMode).toBe("layer");
  });

  it("isFilterActive returns false when only colorMode changes from 'layer'", () => {
    const state: FilterState = { ...INITIAL_FILTER_STATE, colorMode: "tag" };
    expect(isFilterActive(state)).toBe(false);
  });

  it("isFilterActive remains true when other filters are set alongside colorMode", () => {
    const state: FilterState = { ...INITIAL_FILTER_STATE, colorMode: "path", query: "alpha" };
    expect(isFilterActive(state)).toBe(true);
  });

  it("colorMode does NOT change deriveVisibleIds output", () => {
    const a = ids(deriveVisibleIds(FIXTURE, { ...INITIAL_FILTER_STATE, colorMode: "layer" }));
    const b = ids(deriveVisibleIds(FIXTURE, { ...INITIAL_FILTER_STATE, colorMode: "tag" }));
    const c = ids(deriveVisibleIds(FIXTURE, { ...INITIAL_FILTER_STATE, colorMode: "path" }));
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });
});
