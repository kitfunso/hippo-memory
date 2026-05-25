/**
 * v0.28+ (E3 local view) — buildAdjacency + computeLocalNeighborhood tests.
 *
 * Pure-helper tests (no WebGL). Cover the BFS correctness, depth-cap
 * fallback, stale-centerId edge case, and the perf budget on a
 * synthesized 1373-memory fixture.
 */

import { describe, it, expect } from "vitest";
import type { Memory, Conflict } from "../types.js";
import { buildAdjacency, computeLocalNeighborhood } from "./localNeighborhood.js";

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

let _conflictId = 0;
function conflict(a: string, b: string, status: "open" | "resolved" = "open"): Conflict {
  return { id: ++_conflictId, memory_a_id: a, memory_b_id: b, reason: "test", score: 0.5, status };
}

describe("buildAdjacency", () => {
  it("includes conflict edges in both directions", () => {
    const memories: Memory[] = [mem({ id: "A" }), mem({ id: "B" })];
    const conflicts = [conflict("A", "B")];
    const adj = buildAdjacency(memories, conflicts);
    expect(adj.get("A")).toEqual(new Set(["B"]));
    expect(adj.get("B")).toEqual(new Set(["A"]));
  });

  it("includes shared-tag edges (>=2 non-path tags)", () => {
    const memories: Memory[] = [
      mem({ id: "A", tags: ["x", "y"] }),
      mem({ id: "B", tags: ["x", "y"] }),
    ];
    const adj = buildAdjacency(memories, []);
    expect(adj.get("A")?.has("B")).toBe(true);
    expect(adj.get("B")?.has("A")).toBe(true);
  });

  it("unions conflict + shared-tag edges", () => {
    const memories: Memory[] = [
      mem({ id: "A", tags: ["x", "y"] }),
      mem({ id: "B", tags: ["x", "y"] }),
      mem({ id: "C" }),
    ];
    const adj = buildAdjacency(memories, [conflict("A", "C")]);
    expect(adj.get("A")).toEqual(new Set(["B", "C"]));
    expect(adj.get("C")).toEqual(new Set(["A"]));
  });

  it("path:* tags do not contribute to shared-tag adjacency", () => {
    const memories: Memory[] = [
      mem({ id: "A", tags: ["path:hippo", "path:foo"] }),
      mem({ id: "B", tags: ["path:hippo", "path:foo"] }),
    ];
    const adj = buildAdjacency(memories, []);
    expect(adj.size).toBe(0);
  });
});

describe("computeLocalNeighborhood", () => {
  it("centerId not in adjacency: returns {Set([centerId]), depthUsed=cappedDepth}", () => {
    const adj = new Map();
    const result = computeLocalNeighborhood(adj, "X", 2);
    expect(result.memoryIds).toEqual(new Set(["X"]));
    expect(result.cappedFrom).toBeUndefined();
  });

  it("depth=0 returns only the center", () => {
    const adj = new Map([["A", new Set(["B"])]]);
    const result = computeLocalNeighborhood(adj, "A", 0);
    expect(result.memoryIds).toEqual(new Set(["A"]));
    expect(result.depthUsed).toBe(0);
  });

  it("depth=1 over a 3-node line graph A-B-C from A returns {A, B}", () => {
    const adj = new Map<string, Set<string>>([
      ["A", new Set(["B"])],
      ["B", new Set(["A", "C"])],
      ["C", new Set(["B"])],
    ]);
    const result = computeLocalNeighborhood(adj, "A", 1);
    expect(result.memoryIds).toEqual(new Set(["A", "B"]));
    expect(result.depthUsed).toBe(1);
  });

  it("depth=2 over a 3-node line graph A-B-C from A returns {A, B, C}", () => {
    const adj = new Map<string, Set<string>>([
      ["A", new Set(["B"])],
      ["B", new Set(["A", "C"])],
      ["C", new Set(["B"])],
    ]);
    const result = computeLocalNeighborhood(adj, "A", 2);
    expect(result.memoryIds).toEqual(new Set(["A", "B", "C"]));
    expect(result.depthUsed).toBe(2);
  });

  it("triangle (A-B-C all connected) from any node returns all 3", () => {
    const adj = new Map<string, Set<string>>([
      ["A", new Set(["B", "C"])],
      ["B", new Set(["A", "C"])],
      ["C", new Set(["A", "B"])],
    ]);
    expect(computeLocalNeighborhood(adj, "A", 1).memoryIds).toEqual(new Set(["A", "B", "C"]));
    expect(computeLocalNeighborhood(adj, "B", 2).memoryIds).toEqual(new Set(["A", "B", "C"]));
  });

  it("deterministic: same input -> same output", () => {
    const adj = new Map<string, Set<string>>([
      ["A", new Set(["B"])],
      ["B", new Set(["A", "C"])],
      ["C", new Set(["B"])],
    ]);
    const r1 = computeLocalNeighborhood(adj, "B", 2);
    const r2 = computeLocalNeighborhood(adj, "B", 2);
    expect([...r1.memoryIds].sort()).toEqual([...r2.memoryIds].sort());
  });

  it("depth >= HARD_DEPTH_CAP (5) is internally capped", () => {
    // 7-node line; depth=10 capped at 5, so only 6 nodes reachable
    const adj = new Map<string, Set<string>>([
      ["A", new Set(["B"])],
      ["B", new Set(["A", "C"])],
      ["C", new Set(["B", "D"])],
      ["D", new Set(["C", "E"])],
      ["E", new Set(["D", "F"])],
      ["F", new Set(["E", "G"])],
      ["G", new Set(["F"])],
    ]);
    const result = computeLocalNeighborhood(adj, "A", 10);
    // depth capped at 5; A->B->C->D->E->F is 5 hops = 6 nodes
    expect(result.memoryIds.size).toBe(6);
    expect(result.depthUsed).toBe(5);
  });

  describe("neighborhood cap fallback (plan-design R1 must-fix #4)", () => {
    it("depth=1 with 100 neighbors returns all 100 (no fallback available)", () => {
      // Star: center connected to 100 leaves at depth 1
      const adj = new Map<string, Set<string>>();
      const leaves = new Set<string>();
      for (let i = 0; i < 100; i++) leaves.add(`leaf-${i}`);
      adj.set("center", leaves);
      for (const leaf of leaves) adj.set(leaf, new Set(["center"]));

      const result = computeLocalNeighborhood(adj, "center", 1);
      // depth=1, can't fall back lower; accept the result
      expect(result.memoryIds.size).toBe(101);
      expect(result.depthUsed).toBe(1);
      expect(result.cappedFrom).toBeUndefined();
    });

    it("depth=2 with >60 nodes falls back to depth=1 with cappedFrom set", () => {
      // Center connected to 5 hubs at depth 1; each hub connected to 20
      // distinct leaves at depth 2. Total depth-2 = 1+5+100 = 106; depth-1 = 6.
      const adj = new Map<string, Set<string>>();
      const hubs = ["h1", "h2", "h3", "h4", "h5"];
      adj.set("center", new Set(hubs));
      for (const hub of hubs) {
        const hubNeighbors = new Set<string>(["center"]);
        for (let i = 0; i < 20; i++) {
          const leaf = `${hub}-leaf-${i}`;
          hubNeighbors.add(leaf);
          adj.set(leaf, new Set([hub]));
        }
        adj.set(hub, hubNeighbors);
      }

      const result = computeLocalNeighborhood(adj, "center", 2);
      // 106 > 60 -> fall back to depth=1
      expect(result.depthUsed).toBe(1);
      expect(result.memoryIds.size).toBe(6); // center + 5 hubs
      expect(result.cappedFrom).toBeDefined();
      expect(result.cappedFrom?.requestedDepth).toBe(2);
      expect(result.cappedFrom?.wouldHaveBeen).toBe(106);
    });

    it("depth=2 with <60 nodes does not fall back", () => {
      // Center -> 3 hubs -> 3 leaves each. Depth-2 = 1+3+9 = 13.
      const adj = new Map<string, Set<string>>();
      const hubs = ["h1", "h2", "h3"];
      adj.set("center", new Set(hubs));
      for (const hub of hubs) {
        const hubNeighbors = new Set<string>(["center"]);
        for (let i = 0; i < 3; i++) {
          const leaf = `${hub}-leaf-${i}`;
          hubNeighbors.add(leaf);
          adj.set(leaf, new Set([hub]));
        }
        adj.set(hub, hubNeighbors);
      }

      const result = computeLocalNeighborhood(adj, "center", 2);
      expect(result.depthUsed).toBe(2);
      expect(result.memoryIds.size).toBe(13);
      expect(result.cappedFrom).toBeUndefined();
    });
  });

  describe("performance (AC8)", () => {
    it("BFS <5ms at depth=2 on a synthesized 1373-memory + ~3000-edge adjacency", () => {
      // Build a realistic-ish adjacency: 1373 nodes, each with 2-5 random
      // neighbors. Total edges ~3000-4000.
      const adj = new Map<string, Set<string>>();
      const N = 1373;
      const rng = mulberry32(42);
      for (let i = 0; i < N; i++) {
        const id = `m${i}`;
        const degree = 2 + Math.floor(rng() * 4); // 2-5 neighbors
        const neighbors = new Set<string>();
        while (neighbors.size < degree) {
          const j = Math.floor(rng() * N);
          if (j !== i) neighbors.add(`m${j}`);
        }
        adj.set(id, neighbors);
      }
      // Symmetrize
      for (const [u, nbrs] of adj) {
        for (const v of nbrs) {
          let vSet = adj.get(v);
          if (!vSet) {
            vSet = new Set();
            adj.set(v, vSet);
          }
          (vSet as Set<string>).add(u);
        }
      }

      const runs: number[] = [];
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        computeLocalNeighborhood(adj, "m0", 2);
        runs.push(performance.now() - t0);
      }
      const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
      expect(avg).toBeLessThan(5);
    });
  });
});

// Deterministic seeded RNG for reproducible perf tests
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
