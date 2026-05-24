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
