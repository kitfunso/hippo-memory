/**
 * v0.28 — sharedTagPairs pure-helper tests (E2 real-edges).
 *
 * Tested independently of BrainScene/WebGL.
 */

import { describe, it, expect } from "vitest";
import type { Memory } from "../types.js";
import { computeSharedTagPairs } from "./sharedTagPairs.js";

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
    created: over.created ?? "2026-05-25T00:00:00Z",
    last_retrieved: over.last_retrieved ?? "2026-05-25T00:00:00Z",
    age_days: over.age_days ?? 1,
    projected_strength_7d: over.projected_strength_7d ?? 0.5,
    projected_strength_30d: over.projected_strength_30d ?? 0.5,
  };
}

describe("computeSharedTagPairs basics", () => {
  it("returns empty when no pair shares >=2 tags", () => {
    const fixture = [
      mem({ id: "a", tags: ["x"] }),
      mem({ id: "b", tags: ["x"] }),
      mem({ id: "c", tags: ["y"] }),
    ];
    expect(computeSharedTagPairs(fixture)).toEqual([]);
  });

  it("emits a pair when two memories share exactly 2 tags", () => {
    const fixture = [
      mem({ id: "a", tags: ["x", "y"] }),
      mem({ id: "b", tags: ["x", "y"] }),
    ];
    const pairs = computeSharedTagPairs(fixture);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: "a", b: "b", count: 2 });
  });

  it("emits multiple pairs for a triangle sharing 2 tags each", () => {
    const fixture = [
      mem({ id: "a", tags: ["x", "y"] }),
      mem({ id: "b", tags: ["x", "y"] }),
      mem({ id: "c", tags: ["x", "y"] }),
    ];
    const pairs = computeSharedTagPairs(fixture);
    // C(3,2) = 3 pairs, all with count=2
    expect(pairs).toHaveLength(3);
    expect(pairs.every((p) => p.count === 2)).toBe(true);
  });

  it("excludes a tag-prefix when excludePrefix is set", () => {
    const fixture = [
      mem({ id: "a", tags: ["path:hippo", "error", "rule"] }),
      mem({ id: "b", tags: ["path:hippo", "error", "rule"] }),
    ];
    const pairs = computeSharedTagPairs(fixture, { excludePrefix: "path:" });
    // path:hippo dropped from index; a+b still share error+rule = count=2
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.count).toBe(2);
  });

  it("excludePrefix drops single-pair entirely when only path tags remain", () => {
    const fixture = [
      mem({ id: "a", tags: ["path:hippo", "path:quantamental"] }),
      mem({ id: "b", tags: ["path:hippo", "path:quantamental"] }),
    ];
    const pairs = computeSharedTagPairs(fixture, { excludePrefix: "path:" });
    expect(pairs).toEqual([]);
  });

  it("respects minShared (drops singleton pairs)", () => {
    const fixture = [
      mem({ id: "a", tags: ["x"] }),
      mem({ id: "b", tags: ["x"] }),
    ];
    const pairs = computeSharedTagPairs(fixture, { minShared: 2 });
    expect(pairs).toEqual([]);
    const single = computeSharedTagPairs(fixture, { minShared: 1 });
    expect(single).toHaveLength(1);
    expect(single[0]?.count).toBe(1);
  });

  it("output sorted: count DESC, a-id ASC, b-id ASC (deterministic)", () => {
    const fixture = [
      mem({ id: "z", tags: ["x", "y", "w"] }),
      mem({ id: "a", tags: ["x", "y", "w"] }),
      mem({ id: "b", tags: ["x", "y"] }),
      mem({ id: "c", tags: ["x", "y"] }),
    ];
    const pairs = computeSharedTagPairs(fixture);
    // pair(a,z) shares 3 → top; pair(a,b)/(a,c)/(b,c)/(b,z)/(c,z) share 2
    expect(pairs[0]).toMatchObject({ a: "a", b: "z", count: 3 });
    // count=2 pairs sorted by a-id ASC then b-id ASC
    expect(pairs.slice(1)).toEqual([
      { a: "a", b: "b", count: 2 },
      { a: "a", b: "c", count: 2 },
      { a: "b", b: "c", count: 2 },
      { a: "b", b: "z", count: 2 },
      { a: "c", b: "z", count: 2 },
    ]);
  });
});

describe("computeSharedTagPairs tiered cap (plan-eng-critic R1 #4)", () => {
  function tagWithUsers(tag: string, count: number, otherTag: string): Memory[] {
    return Array.from({ length: count }, (_, i) =>
      mem({ id: `${tag}_${i}`, tags: [tag, otherTag] }),
    );
  }

  it("hardCap: tags with >=hardCap users are skipped entirely", () => {
    // 400 users for 'huge' (>=hardCap=300) + 5 users for 'small'.
    // 'huge' should be skipped; 'small' should produce C(5,2)=10 pairs.
    const huge = tagWithUsers("huge", 400, "common");
    const small = tagWithUsers("small", 5, "common");
    // Both 'huge' members and 'small' members share 'common' (405 users
    // total — which is >=hardCap, so 'common' also skipped). So no pairs at all.
    const fixture = [...huge, ...small];
    const pairs = computeSharedTagPairs(fixture, { softCap: 50, hardCap: 300 });
    expect(pairs).toEqual([]);
  });

  it("softCap: medium-band tags (50 <= users < 300) emit only top-K pairs", () => {
    // Create 60 memories all sharing 'medium' tag + a few sharing a small tag
    // to seed the running intersection score.
    const fixture: Memory[] = [];
    for (let i = 0; i < 60; i++) {
      fixture.push(mem({ id: `m${i}`, tags: ["medium"] }));
    }
    // Seed 3 of them with extra shared 'priority' tag
    fixture[0]!.tags.push("priority");
    fixture[1]!.tags.push("priority");
    fixture[2]!.tags.push("priority");
    // 'medium' has 60 users (>=softCap=50, <hardCap=300) — top-K=5 emitted.
    // 'priority' has 3 users — fully enumerated → C(3,2)=3 pairs with count=1.
    // Then 'medium' contributes: per-tag top-5 by current score → pairs (m0,m1),
    // (m0,m2), (m1,m2) all have current=1 from priority; remaining ~1772 candidates
    // have current=0. Top-5 = those 3 score=1 + 2 score=0 (deterministic by alpha
    // tiebreak).
    const pairs = computeSharedTagPairs(fixture, { softCap: 50, hardCap: 300, perTagTopK: 5 });
    // The 3 priority pairs get +1 from medium → count=2 ; emitted.
    // Two other tiebreak pairs get +1 from medium → count=1, filtered by minShared=2.
    expect(pairs.length).toBe(3);
    expect(pairs.every((p) => p.count === 2)).toBe(true);
    const ids = pairs.map((p) => [p.a, p.b].join("|")).sort();
    expect(ids).toEqual(["m0|m1", "m0|m2", "m1|m2"]);
  });

  it("under-softCap tags (users < softCap) enumerate all pairs", () => {
    // 30 memories all sharing tags 'a' and 'b'. Both tags under softCap=50.
    // 'a' contributes C(30,2)=435 pairs each count=1; 'b' adds count=2.
    const fixture = Array.from({ length: 30 }, (_, i) =>
      mem({ id: `m${i.toString().padStart(2, "0")}`, tags: ["a", "b"] }),
    );
    const pairs = computeSharedTagPairs(fixture, { softCap: 50, hardCap: 300 });
    expect(pairs.length).toBe(435);
    expect(pairs.every((p) => p.count === 2)).toBe(true);
  });
});

describe("computeSharedTagPairs perf budget (AC7)", () => {
  // Realistic fixture: 500 memories x 10 tags each from a 100-tag vocab.
  // The live hippo fixture (1391 memories, 156 unique tags) averages
  // roughly 5-10 tags per memory; 10 is a slightly aggressive but
  // grounded stress test. (30 tags/memory was the v0.28 test draft and
  // overstated the live-fixture cost by ~3x.)
  it("completes in <50ms on a 500-memory fixture with 10 random tags per memory", () => {
    const TAG_VOCAB = Array.from({ length: 100 }, (_, i) => `tag-${i}`);
    const fixture: Memory[] = [];
    const rng = () => Math.floor(Math.random() * TAG_VOCAB.length);
    for (let i = 0; i < 500; i++) {
      const tags = new Set<string>();
      while (tags.size < 10) tags.add(TAG_VOCAB[rng()]!);
      fixture.push(mem({ id: `m${i}`, tags: [...tags] }));
    }

    // 3-run average per S6 test spec
    const runs: number[] = [];
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      computeSharedTagPairs(fixture, { softCap: 50, hardCap: 300, perTagTopK: 15, minShared: 2 });
      runs.push(performance.now() - t0);
    }
    const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
    expect(avg).toBeLessThan(50);
  });
});
