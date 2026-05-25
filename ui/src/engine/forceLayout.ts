/**
 * v0.28+ E4 — d3-force layout factory. Replaces the lossy PCA positioning
 * from projection.ts with a structure-driven 2D layout on the XZ plane.
 * Y axis is kept as the layer-stratification offset (LAYER_Y_OFFSET in
 * scene.ts) so the visual layer metaphor is preserved.
 *
 * Per-project anchor forces (v0.29 E5): optional `projectAnchors` config
 * adds forceX/forceY per node, pulling toward the project's anchor point.
 * See projectAnchors.ts for the golden-angle packing that keeps anchors
 * stable as new project tags appear.
 *
 * Pure factory. Caller drives tick() from BrainScene.animate. Disposal
 * is just dropping the returned reference (the simulation is .stop()'d
 * immediately at init).
 *
 * Link contract: d3-force MUTATES `link.source` and `link.target` in-place
 * after init, replacing the string ids with ForceNode references. Callers
 * must therefore build links fresh per populate cycle.
 *
 * Determinism: pass `randomSource` in config (e.g. `mulberry32(42)`) for
 * reproducible final positions. Default uses Math.random.
 */

import * as d3 from "d3-force";
import type { Memory } from "../types.js";
import type { AdjacencyMap } from "./localNeighborhood.js";

export interface ForceNode {
  id: string;
  x: number;
  y: number; // force-Y maps to scene-Z (XZ-plane layout)
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface ForceLayoutConfig {
  alphaMin?: number;
  alphaDecay?: number;
  maxTicks?: number;
  /** Cap ticks when runToCompletion is invoked from setReducedMotion.
   * Trades slightly-less-converged freeze pose for sub-perceptual block. */
  maxTicksOnFreeze?: number;
  linkStrength?: number;
  chargeStrength?: number;
  centerStrength?: number;
  collideRadius?: number;
  bound?: number;
  randomSource?: () => number;
  /**
   * v0.29 (E5) — per-memory anchor targets. Memory id → {x, y, strength}.
   * Memories present in this map get forceX/forceY pulls toward (x, y)
   * with the given strength. Memories absent get strength=0 (no pull).
   * Absent or empty config → no project forces (back-compat with E4).
   */
  projectAnchors?: Map<string, { x: number; y: number; strength: number }>;
}

/**
 * v0.29 (E5) — layout coordinate bound. Memories are clamped within
 * ±LAYOUT_BOUND on each axis by the simulation tick loop. Exported so
 * consumers (scene.populate, computeProjectAnchors, ProjectsPanel
 * mini-map) share the same magic number instead of re-hardcoding 30.
 */
export const LAYOUT_BOUND = 30;

const DEFAULTS = {
  alphaMin: 0.01,
  maxTicks: 300,
  maxTicksOnFreeze: 80,
  linkStrength: 0.4,
  chargeStrength: -30,
  centerStrength: 0.05,
  collideRadius: 0.6,
  bound: LAYOUT_BOUND,
} as const;

export type SettleSource = "tick" | "reduced-motion";

export interface ForceLayoutHandle {
  tick(): void;
  /** Tick synchronously until done() OR the optional cap.
   * setReducedMotion passes maxTicksOnFreeze (default 80) to bound the
   * worst-case main-thread block at ~400ms. */
  runToCompletion(maxTicks?: number): void;
  done(): boolean;
  position(id: string): { x: number; z: number } | undefined; // O(1)
  ticksRun(): number;
  /** Snapshot all node positions for use as seedPositions on the NEXT populate. */
  settledPositions(): Map<string, { x: number; z: number }>;
  /** Subscribe to settling start/stop. Fires once with `true` on first
   * tick from a not-done state, once with `false` when done flips.
   * Source param lets subscribers (e.g. BottomBar) suppress the affordance
   * when the settle was driven by setReducedMotion (no animation visible). */
  onSettleStateChange(
    cb: (settling: boolean, source: SettleSource) => void,
  ): () => void;
  /** Used by scene wrapper for replay-on-subscribe: query current state. */
  isSettling(): boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Build a d3-force simulation for the given memories + adjacency.
 *
 * Algorithm:
 *   1. ForceNode[] from memories; seed x,y from seedPositions if present
 *      (caller passes POST-jitter basePositions on first populate, or
 *      lastSettledPositions on subsequent).
 *   2. Build internal Map<id, ForceNode> for O(1) position lookup.
 *   3. Build Links[] from adjacency: {source: aId, target: bId} strings
 *      with a < b dedup; FILTER stale ids (R4 mitigation: ids in adjacency
 *      but not in memories).
 *   4. Configure simulation (link, charge, center, collide); set
 *      alphaDecay aligned with maxTicks so alpha reaches alphaMin at
 *      exactly maxTicks ticks.
 *   5. Call simulation.stop() — no auto-tick.
 */
export function buildForceLayout(
  memories: readonly Memory[],
  adjacency: AdjacencyMap,
  seedPositions: Map<string, { x: number; z: number }> | null,
  config: ForceLayoutConfig = {},
): ForceLayoutHandle {
  const alphaMin = config.alphaMin ?? DEFAULTS.alphaMin;
  const maxTicks = config.maxTicks ?? DEFAULTS.maxTicks;
  const linkStrength = config.linkStrength ?? DEFAULTS.linkStrength;
  const chargeStrength = config.chargeStrength ?? DEFAULTS.chargeStrength;
  const centerStrength = config.centerStrength ?? DEFAULTS.centerStrength;
  const collideRadius = config.collideRadius ?? DEFAULTS.collideRadius;
  const bound = config.bound ?? DEFAULTS.bound;
  const alphaDecay =
    config.alphaDecay ?? 1 - Math.pow(alphaMin, 1 / maxTicks);

  // Step 1+2: build nodes + O(1) lookup map.
  const nodes: ForceNode[] = [];
  const byId = new Map<string, ForceNode>();
  for (const m of memories) {
    const seed = seedPositions?.get(m.id);
    const node: ForceNode = seed
      ? { id: m.id, x: clamp(seed.x, -bound, bound), y: clamp(seed.z, -bound, bound) }
      : { id: m.id, x: 0, y: 0 }; // d3-force default polar init will reset
    nodes.push(node);
    byId.set(m.id, node);
  }

  // Step 3: build links from adjacency, filter stale ids.
  const links: Array<{ source: string; target: string }> = [];
  const seen = new Set<string>();
  for (const [u, neighbors] of adjacency) {
    if (!byId.has(u)) continue;
    for (const v of neighbors) {
      if (!byId.has(v)) continue;
      const a = u < v ? u : v;
      const b = u < v ? v : u;
      const key = `${a}|${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: a, target: b });
    }
  }

  // Step 4+5: configure + stop.
  const simulation = d3
    .forceSimulation<ForceNode>(nodes)
    .force(
      "link",
      d3
        .forceLink<ForceNode, { source: string; target: string }>(links)
        .id((d) => d.id)
        .strength(linkStrength)
        .distance(2.5),
    )
    .force("charge", d3.forceManyBody().strength(chargeStrength))
    .force("center", d3.forceCenter(0, 0).strength(centerStrength))
    .force("collide", d3.forceCollide(collideRadius))
    .alphaMin(alphaMin)
    .alphaDecay(alphaDecay)
    .stop();

  // v0.29 (E5) — optional per-project anchor forces. forceX/forceY accept
  // per-node accessors so memories WITHOUT an entry in projectAnchors get
  // strength=0 (no pull). Composes additively with link/charge/center.
  const projectAnchors = config.projectAnchors;
  if (projectAnchors && projectAnchors.size > 0) {
    simulation
      .force(
        "project-x",
        d3
          .forceX<ForceNode>((d) => projectAnchors.get(d.id)?.x ?? 0)
          .strength((d) => projectAnchors.get(d.id)?.strength ?? 0),
      )
      .force(
        "project-y",
        d3
          .forceY<ForceNode>((d) => projectAnchors.get(d.id)?.y ?? 0)
          .strength((d) => projectAnchors.get(d.id)?.strength ?? 0),
      );
  }

  if (config.randomSource) {
    simulation.randomSource(config.randomSource);
  }

  let ticksRun = 0;
  let lastDone = false;
  let settlingState = false; // false until first tick from not-done
  const subscribers = new Set<(settling: boolean, source: SettleSource) => void>();

  const computeDone = (): boolean => ticksRun >= maxTicks || simulation.alpha() <= alphaMin;

  const fireState = (settling: boolean, source: SettleSource): void => {
    settlingState = settling;
    for (const cb of subscribers) cb(settling, source);
  };

  const handle: ForceLayoutHandle = {
    tick(): void {
      if (computeDone()) {
        if (lastDone === false) {
          lastDone = true;
          if (settlingState) fireState(false, "tick");
        }
        return;
      }
      if (!settlingState) {
        // First tick from not-done state — fire settling=true.
        fireState(true, "tick");
      }
      simulation.tick();
      ticksRun++;
      // Clamp positions to bound.
      for (const node of nodes) {
        node.x = clamp(node.x, -bound, bound);
        node.y = clamp(node.y, -bound, bound);
      }
      if (computeDone() && lastDone === false) {
        lastDone = true;
        fireState(false, "tick");
      }
    },
    runToCompletion(maxTicksArg?: number): void {
      const startTicks = ticksRun;
      const cap = maxTicksArg ?? Infinity;
      // Fire settling=true if we're about to do work and weren't already settling.
      if (!computeDone() && !settlingState) {
        fireState(true, "reduced-motion");
      }
      while (!computeDone() && ticksRun - startTicks < cap) {
        simulation.tick();
        ticksRun++;
        for (const node of nodes) {
          node.x = clamp(node.x, -bound, bound);
          node.y = clamp(node.y, -bound, bound);
        }
      }
      if (computeDone() && lastDone === false) {
        lastDone = true;
        if (settlingState) fireState(false, "reduced-motion");
      }
    },
    done(): boolean {
      return computeDone();
    },
    position(id: string): { x: number; z: number } | undefined {
      const n = byId.get(id);
      if (!n) return undefined;
      return { x: n.x, z: n.y }; // force-Y maps to scene-Z
    },
    ticksRun(): number {
      return ticksRun;
    },
    settledPositions(): Map<string, { x: number; z: number }> {
      const out = new Map<string, { x: number; z: number }>();
      for (const node of nodes) {
        out.set(node.id, { x: node.x, z: node.y });
      }
      return out;
    },
    onSettleStateChange(cb): () => void {
      subscribers.add(cb);
      // Replay-on-subscribe: if currently settling, fire immediately.
      // (Race fix per plan-eng R4 must-fix #2.)
      if (settlingState) cb(true, "tick");
      return () => {
        subscribers.delete(cb);
      };
    },
    isSettling(): boolean {
      return settlingState;
    },
  };

  return handle;
}
