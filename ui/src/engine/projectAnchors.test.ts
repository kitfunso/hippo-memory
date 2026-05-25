/**
 * v0.29 (E5 S2 + S8) — Tests for per-project anchor computation.
 *
 * Highlights:
 *   - AC20 byte-identical stability: existing anchors unchanged when a
 *     new tag is added (the core E4 R2 fix).
 *   - path:skf_s filtered out.
 *   - Golden-angle formula: angle = i × GOLDEN_ANGLE per index.
 *   - orderedTags includes only actually-anchored tags (HIGH-4 fix).
 *   - Memories pick shortest path tag (alpha tiebreak) via shared helper.
 */

import { describe, it, expect } from "vitest";
import {
  computeProjectAnchors,
  GOLDEN_ANGLE,
} from "./projectAnchors.js";
import type { ProjectAnchorOrder } from "../state/projectAnchorOrder.js";
import type { Memory } from "../types.js";

const LAYOUT_BOUND = 30;
const RADIUS = LAYOUT_BOUND * 0.6;

function mem(id: string, tags: string[]): Memory {
  return {
    id,
    content: "",
    layer: "episodic",
    strength: 0.5,
    half_life_days: 30,
    retrieval_count: 1,
    age_days: 1,
    schema_fit: 0,
    emotional_valence: "neutral",
    confidence: "observed",
    pinned: false,
    projected_strength_7d: 0.5,
    projected_strength_30d: 0.5,
    created: "2026-01-01T00:00:00Z",
    last_retrieved: "2026-01-01T00:00:00Z",
    tags,
  };
}

function order(entries: Array<[string, number]>): ProjectAnchorOrder {
  const indexByTag = new Map(entries);
  const nextIndex = entries.length === 0 ? 0 : Math.max(...entries.map(([, i]) => i)) + 1;
  return { indexByTag, nextIndex };
}

describe("computeProjectAnchors", () => {
  it("filters path:skf_s (filesystem root, not a project)", () => {
    const memories = [mem("a", ["path:skf_s"]), mem("b", ["path:hippo"])];
    const ord = order([["path:skf_s", 0], ["path:hippo", 1]]);
    const layout = computeProjectAnchors(memories, ord, LAYOUT_BOUND);
    expect(layout.byTag.has("path:skf_s")).toBe(false);
    expect(layout.byTag.has("path:hippo")).toBe(true);
    // Memory `a` had ONLY path:skf_s → no anchor.
    expect(layout.byMemoryId.has("a")).toBe(false);
    expect(layout.byMemoryId.has("b")).toBe(true);
  });

  it("places each anchor at (cos(i*GOLDEN_ANGLE)*r, sin(i*GOLDEN_ANGLE)*r)", () => {
    const memories = [
      mem("a", ["path:hippo"]),
      mem("b", ["path:quantamental"]),
      mem("c", ["path:phzse"]),
    ];
    const ord = order([
      ["path:hippo", 0],
      ["path:quantamental", 1],
      ["path:phzse", 2],
    ]);
    const layout = computeProjectAnchors(memories, ord, LAYOUT_BOUND);

    const anchor0 = layout.byTag.get("path:hippo")!;
    expect(anchor0.x).toBeCloseTo(Math.cos(0) * RADIUS, 10);
    expect(anchor0.y).toBeCloseTo(Math.sin(0) * RADIUS, 10);

    const anchor1 = layout.byTag.get("path:quantamental")!;
    expect(anchor1.x).toBeCloseTo(Math.cos(GOLDEN_ANGLE) * RADIUS, 10);
    expect(anchor1.y).toBeCloseTo(Math.sin(GOLDEN_ANGLE) * RADIUS, 10);

    const anchor2 = layout.byTag.get("path:phzse")!;
    const angle2 = (2 * GOLDEN_ANGLE) % (2 * Math.PI);
    expect(anchor2.x).toBeCloseTo(Math.cos(angle2) * RADIUS, 10);
    expect(anchor2.y).toBeCloseTo(Math.sin(angle2) * RADIUS, 10);
  });

  it("AC20 — byte-identical positions for existing tags after a new tag is added (the core E4 R2 fix)", () => {
    const memoriesV1 = [
      mem("a", ["path:hippo"]),
      mem("b", ["path:quantamental"]),
      mem("c", ["path:phzse"]),
    ];
    const orderV1 = order([
      ["path:hippo", 0],
      ["path:quantamental", 1],
      ["path:phzse", 2],
    ]);
    const layoutV1 = computeProjectAnchors(memoriesV1, orderV1, LAYOUT_BOUND);
    const hippo1 = layoutV1.byTag.get("path:hippo")!;
    const quant1 = layoutV1.byTag.get("path:quantamental")!;
    const phzse1 = layoutV1.byTag.get("path:phzse")!;

    // Add a new tag at index 3.
    const memoriesV2 = [...memoriesV1, mem("d", ["path:resona"])];
    const orderV2 = order([
      ["path:hippo", 0],
      ["path:quantamental", 1],
      ["path:phzse", 2],
      ["path:resona", 3],
    ]);
    const layoutV2 = computeProjectAnchors(memoriesV2, orderV2, LAYOUT_BOUND);
    const hippo2 = layoutV2.byTag.get("path:hippo")!;
    const quant2 = layoutV2.byTag.get("path:quantamental")!;
    const phzse2 = layoutV2.byTag.get("path:phzse")!;

    // Byte-identical (strict equality, not toBeCloseTo) — golden-angle
    // makes existing indices' angles independent of total count N.
    expect(hippo2.x).toBe(hippo1.x);
    expect(hippo2.y).toBe(hippo1.y);
    expect(quant2.x).toBe(quant1.x);
    expect(quant2.y).toBe(quant1.y);
    expect(phzse2.x).toBe(phzse1.x);
    expect(phzse2.y).toBe(phzse1.y);

    // And the newcomer is wherever golden-angle puts it.
    const resona2 = layoutV2.byTag.get("path:resona")!;
    expect(resona2).toBeDefined();
  });

  it("memories with no qualifying path tag are not in byMemoryId", () => {
    const memories = [mem("a", ["topic:foo"])];
    const ord = order([]);
    const layout = computeProjectAnchors(memories, ord, LAYOUT_BOUND);
    expect(layout.byMemoryId.has("a")).toBe(false);
  });

  it("memories with multiple path tags pick the shortest (alpha tiebreak)", () => {
    const memories = [mem("a", ["path:hippo-tests", "path:hippo"])];
    const ord = order([
      ["path:hippo", 0],
      ["path:hippo-tests", 1],
    ]);
    const layout = computeProjectAnchors(memories, ord, LAYOUT_BOUND);
    const anchor = layout.byMemoryId.get("a")!;
    const hippoAnchor = layout.byTag.get("path:hippo")!;
    expect(anchor).toBe(hippoAnchor); // reference equality
  });

  it("orderedTags returns tags in persistent-index order", () => {
    const memories = [
      mem("a", ["path:c-late"]),
      mem("b", ["path:a-early"]),
      mem("c", ["path:b-mid"]),
    ];
    const ord = order([
      ["path:c-late", 5],
      ["path:a-early", 0],
      ["path:b-mid", 2],
    ]);
    const layout = computeProjectAnchors(memories, ord, LAYOUT_BOUND);
    expect(layout.orderedTags).toEqual(["path:a-early", "path:b-mid", "path:c-late"]);
  });

  it("orderedTags includes ONLY tags actually picked as an anchored tag (HIGH-4 fix)", () => {
    // Memory carries both path:hippo and path:hippo-tests, but
    // pickShortestPathTag picks path:hippo (shorter). path:hippo-tests
    // exists in the order but anchors zero memories → should NOT appear
    // in orderedTags.
    const memories = [mem("a", ["path:hippo", "path:hippo-tests"])];
    const ord = order([
      ["path:hippo", 0],
      ["path:hippo-tests", 1],
    ]);
    const layout = computeProjectAnchors(memories, ord, LAYOUT_BOUND);
    expect(layout.orderedTags).toEqual(["path:hippo"]);
    // byTag still has both (positions computed for all known indices) —
    // it's the Sidebar legend that filters.
    expect(layout.byTag.has("path:hippo-tests")).toBe(true);
  });

  it("respects anchorStrength override", () => {
    const memories = [mem("a", ["path:hippo"])];
    const ord = order([["path:hippo", 0]]);
    const layout = computeProjectAnchors(memories, ord, LAYOUT_BOUND, 0.04);
    expect(layout.byTag.get("path:hippo")!.strength).toBe(0.04);
  });

  it("default anchorStrength is 0.08", () => {
    const memories = [mem("a", ["path:hippo"])];
    const ord = order([["path:hippo", 0]]);
    const layout = computeProjectAnchors(memories, ord, LAYOUT_BOUND);
    expect(layout.byTag.get("path:hippo")!.strength).toBe(0.08);
  });
});
