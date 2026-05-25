/**
 * v0.28+ (E3 local graph view) — pure helper for the "Focus on
 * neighborhood" feature.
 *
 * Two responsibilities:
 *   1. `buildAdjacency` — combines conflict pairs + shared-tag pairs into
 *      an undirected adjacency map. Hoisted to a useMemo in LivingMap so
 *      it rebuilds only when `memories` or `conflicts` change (not per
 *      localView toggle).
 *   2. `computeLocalNeighborhood` — BFS from `centerId` depth-limited,
 *      with a hard cap on neighborhood size (60 nodes; falls back to
 *      depth-1 if exceeded).
 *
 * Pure + deterministic. Same inputs => same outputs across calls.
 */

import type { Memory, Conflict } from "../types.js";
import { computeSharedTagPairs } from "./sharedTagPairs.js";

/** Sanity guard against bad input. v1 default depth=2; this prevents
 * catastrophic BFS on a degenerate caller passing depth=999. */
const HARD_DEPTH_CAP = 5;
/** When BFS at requested depth yields > NEIGHBORHOOD_CAP, fall back to
 * depth-1. "Local" view ceases to feel local above ~60 nodes per
 * plan-design-critic R1 HIGH. */
const NEIGHBORHOOD_CAP = 60;

export interface LocalViewResult {
  /** The memory IDs to keep visible. Always includes centerId. */
  memoryIds: Set<string>;
  /** The depth actually used. May be less than requested if the cap
   * triggered a depth-1 fallback. */
  depthUsed: number;
  /** Set ONLY when the helper fell back from a higher requested depth.
   * BottomBar uses this to show the "view = local (N, capped from M)"
   * hint so the user understands why their depth-2 click produced fewer
   * nodes than expected. */
  cappedFrom?: { requestedDepth: number; wouldHaveBeen: number };
}

/**
 * Undirected adjacency over the union of conflict-pairs + shared-tag
 * pairs. Built once per (memories, conflicts) change in LivingMap.tsx.
 */
export type AdjacencyMap = ReadonlyMap<string, ReadonlySet<string>>;

/** Build adjacency from conflicts (both directions) + shared-tag pairs
 * (computeSharedTagPairs from E2 — tiered cap-bounded, callable on
 * any-n memories). */
export function buildAdjacency(
  memories: readonly Memory[],
  conflicts: readonly Conflict[],
): AdjacencyMap {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (a === b) return;
    let s = adj.get(a);
    if (s === undefined) {
      s = new Set();
      adj.set(a, s);
    }
    s.add(b);
  };

  // Conflict edges — both directions.
  for (const c of conflicts) {
    link(c.memory_a_id, c.memory_b_id);
    link(c.memory_b_id, c.memory_a_id);
  }

  // Shared-tag edges — same tiered-cap options as scene.buildSharedTagEdges
  // so the local-view adjacency matches what the canvas renders.
  const sharedPairs = computeSharedTagPairs(memories, {
    excludePrefix: "path:",
    softCap: 50,
    hardCap: 300,
    perTagTopK: 15,
    minShared: 2,
  });
  for (const p of sharedPairs) {
    link(p.a, p.b);
    link(p.b, p.a);
  }

  return adj;
}

/**
 * BFS from `centerId` over the prebuilt adjacency. Returns the visited
 * set + depth used + cap-fallback metadata.
 *
 * Algorithm:
 *   - Visited marked on ENQUEUE (not dequeue) so well-connected hubs
 *     don't re-expand. (plan-eng-critic R1 MED.)
 *   - depth capped at HARD_DEPTH_CAP=5 internally.
 *   - If visited.size > NEIGHBORHOOD_CAP AND depth > 1: re-run at
 *     depth-1 (single recursive call). Returns the smaller result with
 *     cappedFrom set so the UI can surface "(N, capped from M)".
 *
 * Performance: BFS is O(V+E) over adjacency; on the live 1373-memory
 * fixture with ~1117 conflicts + ~1000 shared-tag pairs, expect <5ms at
 * depth=2. Adjacency build cost is not part of this budget (hoisted).
 */
export function computeLocalNeighborhood(
  adjacency: AdjacencyMap,
  centerId: string,
  depth: number,
): LocalViewResult {
  const cappedDepth = Math.min(Math.max(0, depth), HARD_DEPTH_CAP);
  const visited = bfs(adjacency, centerId, cappedDepth);

  if (visited.size > NEIGHBORHOOD_CAP && cappedDepth > 1) {
    // Cap triggered — fall back to depth-1 and report the would-have-been.
    const fallback = bfs(adjacency, centerId, 1);
    return {
      memoryIds: fallback,
      depthUsed: 1,
      cappedFrom: { requestedDepth: cappedDepth, wouldHaveBeen: visited.size },
    };
  }
  return {
    memoryIds: visited,
    depthUsed: cappedDepth,
  };
}

/** Pure BFS: visited-on-enqueue, depth-limited, always includes centerId. */
function bfs(adjacency: AdjacencyMap, centerId: string, depth: number): Set<string> {
  const visited = new Set<string>([centerId]);
  if (depth <= 0) return visited;
  let frontier: string[] = [centerId];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const u of frontier) {
      const neighbors = adjacency.get(u);
      if (!neighbors) continue;
      for (const v of neighbors) {
        if (visited.has(v)) continue;
        visited.add(v); // mark on ENQUEUE
        next.push(v);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return visited;
}
