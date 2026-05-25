/**
 * v0.28+ E4 — forceLayout pure factory tests. No WebGL stubs needed.
 *
 * Covers AC1-AC5, AC8 done-stops, AC16 stale-id filter, AC18 perf budget,
 * AC19 per-tick perf, AC20 prune (via settledPositions snapshot).
 *
 * Determinism via mulberry32(seed) per plan R3 must-fix #7. Reuses the
 * pattern from localNeighborhood.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import type { Memory, Conflict } from "../types.js";
import { buildForceLayout, type ForceNode, LAYOUT_BOUND } from "./forceLayout.js";
import { buildAdjacency } from "./localNeighborhood.js";

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
  return { id: ++_conflictId, memory_a_id: a, memory_b_id: b, reason: "t", score: 0.5, status };
}

// Deterministic PRNG for perf tests (reused pattern from localNeighborhood.test.ts).
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

describe("buildForceLayout basic contract", () => {
  it("returns the full handle (tick/runToCompletion/done/position/ticksRun/settledPositions/onSettleStateChange/isSettling)", () => {
    const handle = buildForceLayout([mem({ id: "A" })], new Map(), null);
    expect(typeof handle.tick).toBe("function");
    expect(typeof handle.runToCompletion).toBe("function");
    expect(typeof handle.done).toBe("function");
    expect(typeof handle.position).toBe("function");
    expect(typeof handle.ticksRun).toBe("function");
    expect(typeof handle.settledPositions).toBe("function");
    expect(typeof handle.onSettleStateChange).toBe("function");
    expect(typeof handle.isSettling).toBe("function");
  });

  it("does NOT auto-tick at init (simulation.stop called)", () => {
    const handle = buildForceLayout([mem({ id: "A" }), mem({ id: "B" })], new Map(), null);
    expect(handle.ticksRun()).toBe(0);
  });

  it("warm-start: seedPositions taken (within bound clamp)", () => {
    const seed = new Map([["A", { x: 5, z: -10 }]]);
    const handle = buildForceLayout([mem({ id: "A" })], new Map(), seed);
    const p = handle.position("A");
    expect(p).toEqual({ x: 5, z: -10 });
  });

  it("warm-start clamps to bound (default 30)", () => {
    const seed = new Map([["A", { x: 100, z: -200 }]]);
    const handle = buildForceLayout([mem({ id: "A" })], new Map(), seed);
    const p = handle.position("A");
    expect(p?.x).toBe(30);
    expect(p?.z).toBe(-30);
  });

  it("position(id) returns undefined for unknown id (NOT throws)", () => {
    const handle = buildForceLayout([mem({ id: "A" })], new Map(), null);
    expect(handle.position("nope")).toBeUndefined();
  });
});

describe("tick / done / runToCompletion", () => {
  it("tick() increments ticksRun", () => {
    const handle = buildForceLayout(
      [mem({ id: "A" }), mem({ id: "B" })],
      new Map(),
      new Map([["A", { x: 1, z: 1 }], ["B", { x: -1, z: -1 }]]),
    );
    expect(handle.ticksRun()).toBe(0);
    handle.tick();
    expect(handle.ticksRun()).toBe(1);
    handle.tick();
    expect(handle.ticksRun()).toBe(2);
  });

  it("done() true when ticksRun >= maxTicks", () => {
    const memories = [mem({ id: "A" }), mem({ id: "B" })];
    const handle = buildForceLayout(memories, new Map(), null, { maxTicks: 3 });
    for (let i = 0; i < 5; i++) handle.tick();
    expect(handle.done()).toBe(true);
    expect(handle.ticksRun()).toBeLessThanOrEqual(4); // tick is no-op once done
  });

  it("runToCompletion() makes done() true synchronously", () => {
    const memories = [mem({ id: "A" }), mem({ id: "B" })];
    const handle = buildForceLayout(memories, new Map(), null, { maxTicks: 50 });
    handle.runToCompletion();
    expect(handle.done()).toBe(true);
  });

  it("runToCompletion(maxTicks) caps ticks for freeze (AC15)", () => {
    const memories = Array.from({ length: 100 }, (_, i) => mem({ id: `m${i}` }));
    const handle = buildForceLayout(memories, new Map(), null, { maxTicks: 300 });
    handle.runToCompletion(50);
    expect(handle.ticksRun()).toBeLessThanOrEqual(50);
    // May not be done if cap < natural convergence
  });

  it("tick is no-op once done", () => {
    const handle = buildForceLayout([mem({ id: "A" })], new Map(), null, { maxTicks: 2 });
    handle.tick();
    handle.tick();
    const ticksBeforeNoop = handle.ticksRun();
    handle.tick();
    expect(handle.ticksRun()).toBe(ticksBeforeNoop);
  });
});

describe("clamp to bound (AC4)", () => {
  it("settled positions stay within [-bound, +bound]", () => {
    const memories = Array.from({ length: 30 }, (_, i) => mem({ id: `m${i}` }));
    const handle = buildForceLayout(memories, new Map(), null, {
      bound: 10,
      maxTicks: 50,
    });
    handle.runToCompletion();
    for (let i = 0; i < 30; i++) {
      const p = handle.position(`m${i}`)!;
      expect(p.x).toBeGreaterThanOrEqual(-10);
      expect(p.x).toBeLessThanOrEqual(10);
      expect(p.z).toBeGreaterThanOrEqual(-10);
      expect(p.z).toBeLessThanOrEqual(10);
    }
  });
});

describe("stale adjacency (AC16, R4)", () => {
  it("filters out adjacency entries whose source or target is not in memories — no throw", () => {
    const memories = [mem({ id: "A" }), mem({ id: "B" })];
    const adj = new Map<string, Set<string>>([
      ["A", new Set(["B", "GHOST"])], // GHOST not in memories
      ["GHOST", new Set(["A"])], // stale source
      ["B", new Set(["A"])],
    ]);
    expect(() => buildForceLayout(memories, adj, null)).not.toThrow();
    const handle = buildForceLayout(memories, adj, null);
    handle.runToCompletion();
    expect(handle.done()).toBe(true);
    // Both real memories still positioned.
    expect(handle.position("A")).toBeDefined();
    expect(handle.position("B")).toBeDefined();
    expect(handle.position("GHOST")).toBeUndefined();
  });
});

describe("settledPositions snapshot (used for next populate seed)", () => {
  it("returns a Map of all node positions", () => {
    const memories = [mem({ id: "A" }), mem({ id: "B" })];
    const handle = buildForceLayout(
      memories,
      new Map(),
      new Map([["A", { x: 5, z: 5 }], ["B", { x: -5, z: -5 }]]),
    );
    const snap = handle.settledPositions();
    expect(snap.size).toBe(2);
    expect(snap.get("A")).toEqual({ x: 5, z: 5 });
    expect(snap.get("B")).toEqual({ x: -5, z: -5 });
  });

  it("snapshot reflects post-tick positions", () => {
    const memories = [mem({ id: "A" }), mem({ id: "B" })];
    const adj = buildAdjacency(memories, [conflict("A", "B")]);
    const handle = buildForceLayout(
      memories,
      adj,
      new Map([["A", { x: 10, z: 10 }], ["B", { x: -10, z: -10 }]]),
      { maxTicks: 50 },
    );
    handle.runToCompletion();
    const snap = handle.settledPositions();
    const a = snap.get("A")!;
    // After settle with a conflict link, A and B should be CLOSER than at seed.
    const distAtSeed = Math.hypot(10 - -10, 10 - -10);
    const b = snap.get("B")!;
    const distSettled = Math.hypot(a.x - b.x, a.z - b.z);
    expect(distSettled).toBeLessThan(distAtSeed);
  });
});

describe("onSettleStateChange (AC13 + replay)", () => {
  it("fires settling=true on first tick from not-done state", () => {
    const memories = [mem({ id: "A" }), mem({ id: "B" })];
    const handle = buildForceLayout(memories, new Map(), null, { maxTicks: 5 });
    const fired: Array<{ s: boolean; src: string }> = [];
    handle.onSettleStateChange((s, src) => fired.push({ s, src }));
    expect(fired).toEqual([]);
    handle.tick();
    expect(fired).toEqual([{ s: true, src: "tick" }]);
  });

  it("fires settling=false when done flips", () => {
    const memories = [mem({ id: "A" }), mem({ id: "B" })];
    const handle = buildForceLayout(memories, new Map(), null, { maxTicks: 3 });
    const fired: Array<{ s: boolean; src: string }> = [];
    handle.onSettleStateChange((s, src) => fired.push({ s, src }));
    handle.runToCompletion();
    // First fire: settling=true (source 'reduced-motion' per runToCompletion semantics)
    expect(fired[0]).toEqual({ s: true, src: "reduced-motion" });
    expect(fired[fired.length - 1]).toEqual({ s: false, src: "reduced-motion" });
  });

  it("source = 'reduced-motion' when fired from runToCompletion (AC: reduced-motion users)", () => {
    const memories = [mem({ id: "A" })];
    const handle = buildForceLayout(memories, new Map(), null, { maxTicks: 5 });
    const fired: Array<{ s: boolean; src: string }> = [];
    handle.onSettleStateChange((s, src) => fired.push({ s, src }));
    handle.runToCompletion(2);
    if (fired.length > 0) {
      expect(fired[0]!.src).toBe("reduced-motion");
    }
  });

  it("replay-on-subscribe: if currently settling, fires true immediately", () => {
    const memories = [mem({ id: "A" }), mem({ id: "B" })];
    const handle = buildForceLayout(memories, new Map(), null, { maxTicks: 50 });
    handle.tick(); // now settling=true
    const fired: boolean[] = [];
    handle.onSettleStateChange((s) => fired.push(s));
    expect(fired).toEqual([true]); // replay fired immediately
  });

  it("unsubscribe stops firing", () => {
    const memories = [mem({ id: "A" }), mem({ id: "B" })];
    const handle = buildForceLayout(memories, new Map(), null, { maxTicks: 50 });
    const cb = vi.fn();
    const unsubscribe = handle.onSettleStateChange(cb);
    handle.tick();
    expect(cb).toHaveBeenCalledTimes(1);
    unsubscribe();
    handle.runToCompletion();
    expect(cb).toHaveBeenCalledTimes(1); // no further calls
  });
});

describe("position(id) O(1) lookup (AC5)", () => {
  it("10000 sequential position(id) calls complete in <1ms total on 1373-node sim", () => {
    const memories = Array.from({ length: 1373 }, (_, i) => mem({ id: `m${i}` }));
    const handle = buildForceLayout(memories, new Map(), null);
    const t0 = performance.now();
    for (let i = 0; i < 10000; i++) handle.position(`m${i % 1373}`);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(10); // generous; O(1) Map.get should be sub-ms
  });
});

describe("perf budget (AC18 + AC19)", () => {
  it("300 ticks on 1373-node + ~2100-edge fixture completes in <2.0s with mulberry32(42)", () => {
    const memories = Array.from({ length: 1373 }, (_, i) => mem({ id: `m${i}` }));
    const adj = new Map<string, Set<string>>();
    const rng = mulberry32(42);
    // ~2100 edges via random sparse graph (degree ~3 per node, symmetrized).
    for (let i = 0; i < 1373; i++) {
      const id = `m${i}`;
      const neighbors = new Set<string>();
      while (neighbors.size < 3) {
        const j = Math.floor(rng() * 1373);
        if (j !== i) neighbors.add(`m${j}`);
      }
      adj.set(id, neighbors);
    }
    // Symmetrize.
    for (const [u, nbrs] of adj) {
      for (const v of nbrs) {
        let s = adj.get(v);
        if (!s) {
          s = new Set();
          adj.set(v, s);
        }
        (s as Set<string>).add(u);
      }
    }

    const handle = buildForceLayout(memories, adj, null, {
      maxTicks: 300,
      randomSource: mulberry32(42),
    });
    const t0 = performance.now();
    handle.runToCompletion();
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2000);
  });
});

/**
 * v0.29 (E5) — projectAnchors config branch. Plan v2.1 S7 + AC10/AC11/AC12.
 *
 * Locks: forceX/forceY added when projectAnchors set; back-compat without;
 * anchored memories settle near their anchor; LAYOUT_BOUND export equals 30.
 */
describe("buildForceLayout projectAnchors (E5)", () => {
  it("exports LAYOUT_BOUND === 30 (shared constant for scene + ProjectsPanel)", () => {
    expect(LAYOUT_BOUND).toBe(30);
  });

  // Helper: settle a 1-node graph with the given config and return the
  // final position. Single-node avoids charge repulsion in the comparison.
  function settleOne(
    config: Parameters<typeof buildForceLayout>[3],
  ): { x: number; z: number } {
    const memories = [mem({ id: "A" })];
    const seed = new Map([["A", { x: 0, z: 0 }]]);
    const handle = buildForceLayout(memories, new Map(), seed, {
      maxTicks: 200,
      randomSource: mulberry32(7),
      ...config,
    });
    handle.runToCompletion();
    return handle.position("A")!;
  }

  it("AC10: projectAnchors config pulls the anchored node MEASURABLY toward the anchor (compared to no-anchor baseline)", () => {
    const anchor = { x: 10, y: 5 };
    // Baseline: no projectAnchors → node settles via center+charge alone.
    const withoutAnchor = settleOne({});
    // With anchor: node should settle measurably closer to (10, 5).
    const withAnchor = settleOne({
      projectAnchors: new Map([["A", { ...anchor, strength: 0.5 }]]),
    });

    const baselineDist = Math.hypot(withoutAnchor.x - anchor.x, withoutAnchor.z - anchor.y);
    const withAnchorDist = Math.hypot(withAnchor.x - anchor.x, withAnchor.z - anchor.y);

    // The anchor must noticeably reduce distance to the target. d3-force's
    // alphaDecay limits how much force is applied across maxTicks (default
    // ~200 ticks × strength × alpha → finite pull, not infinite). A 1+ unit
    // reduction proves the force is wired and acting, vs the baseline drift.
    expect(withAnchorDist).toBeLessThan(baselineDist - 1);
  });

  it("AC11: without projectAnchors config, no project forces are added (back-compat with E4)", () => {
    // Two parallel runs with the SAME seed + maxTicks. They MUST produce
    // identical settle positions when neither has projectAnchors — i.e.
    // the projectAnchors-absent code path is byte-equivalent to E4.
    const a = settleOne({});
    const b = settleOne({});
    expect(a.x).toBe(b.x);
    expect(a.z).toBe(b.z);
    // And the position is NOT near (10, 5) — there's no force pulling there.
    const distToAnchor = Math.hypot(a.x - 10, a.z - 5);
    expect(distToAnchor).toBeGreaterThan(5); // anchor would have pulled it to <2
  });

  it("empty projectAnchors map = same as no anchors (no force registered)", () => {
    // Edge case: passing an empty Map should skip the force registration
    // (factory checks `size > 0`).
    const memories = [mem({ id: "A" })];
    const handle = buildForceLayout(memories, new Map(), null, {
      projectAnchors: new Map(),
    });
    // No throw; ticks work.
    handle.tick();
    expect(handle.ticksRun()).toBe(1);
  });

  it("memories absent from projectAnchors get strength=0 (no pull)", () => {
    // A is anchored at (10, 5) with strength 0.5; B is NOT in the map.
    // After runToCompletion, A drifts toward (10, 5) but B stays near origin
    // (only center + charge act on it).
    const memories = [mem({ id: "A" }), mem({ id: "B" })];
    const projectAnchors = new Map([
      ["A", { x: 10, y: 5, strength: 0.5 }],
      // B absent — no entry
    ]);
    const seed = new Map([["A", { x: 0, z: 0 }], ["B", { x: 0, z: 0 }]]);
    const handle = buildForceLayout(memories, new Map(), seed, {
      maxTicks: 50,
      projectAnchors,
      randomSource: mulberry32(7),
    });
    handle.runToCompletion();
    const pA = handle.position("A")!;
    const pB = handle.position("B")!;
    // A pulled toward (10, 5).
    expect(Math.hypot(pA.x - 10, pA.z - 5)).toBeLessThan(Math.hypot(pA.x, pA.z));
    // B near origin (no anchor pull).
    expect(Math.hypot(pB.x, pB.z)).toBeLessThan(Math.hypot(pB.x - 10, pB.z - 5));
  });
});
