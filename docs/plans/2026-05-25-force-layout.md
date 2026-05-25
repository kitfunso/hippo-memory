# 2026-05-25 — Force-directed layout (E4 of Obsidian-inspired graph upgrades stack)

**Status:** Draft v3 (lean scope after R2 cap-3 risk; per-project anchors spun out to E5; absorbs the 6 core E4 must-fixes from R2)
**Episode:** 01KSFNTGDZQHMFYW7BPJG800R8
**Branch:** feat-force-layout (off feat-local-view; rebases when E3 PR #63 lands)
**Owner:** Claude (Keith review)

## Changes from v2 (R2 must-fix + scope split)

**Scope cut: per-project anchors spun out to E5.** R2 surfaced 3 anchor-specific HIGH issues (sort-index mass-resettle, no in-app legend, settling-clause refresh-vs-initial). Each needs its own design decision (persisted append-only ordering, legend UI, signaling). Bundling them with the core force-layout work raised plan-cap-3 escalation risk. v3 = lean d3-force replacement of PCA. E5 (task #106) tracks anchors with own design budget.

**v3 engineering fixes (6 of 7 R2 must-fix; the anchor sort-index one is gone with the scope):**
- **Warm-start contradiction RESOLVED** — single source: seedPositions are taken from POST-jitter basePositions on first populate, lastSettledPositions on subsequent. The line-13 "node.x = pos[0] * bound" vestige removed. S1 step 1 has one concrete formula.
- **runToCompletion freeze BOUNDED** — new `maxTicksOnFreeze = 80` config (default). `runToCompletion(maxTicks?)` accepts an optional cap. setReducedMotion calls it with the freeze cap. Worst-case main-thread block: 80 × 5ms = 400ms instead of 1.5s. Below the perceptual "instant" threshold for typical hardware.
- **forceSettling delivery PICKED** — `onSettleStateChange((settling: boolean) => void)` callback fires once at start and once at done. NOT per-tick render. LivingMap stores in state via the existing onSceneReady pattern.
- **alphaDecay formula SYNTAX FIXED** — `.alphaDecay(alphaDecay ?? (1 - Math.pow(alphaMin, 1 / maxTicks)))` (parens added; `Math.pow` replaces `^`).
- **PRNG SPECIFIED** — `mulberry32(seed: number)` (already used in localNeighborhood.test.ts perf fixture; reuse pattern). Test seed = 42. simulation.randomSource(mulberry32(42)) ensures determinism for the perf fixture.
- **Settling clause discriminator** — even without project anchors, `· layout: settling (initial)` vs `· layout: settling (refresh)` distinguishes first-load from memory-refresh. Discriminator = `lastSettledPositions === null`. **NEW R4 fix:** suppressed entirely when `prefers-reduced-motion` is active (or any caller of setReducedMotion completed the layout via runToCompletion). Reduced-motion users never see a clause for animation they don't experience. useCanvasEngine subscription receives `(settling, source)` — when `source === 'reduced-motion'`, skip the React state update.

**v3 LOW fixes folded:**
- jsdoc note on factory: d3-force mutates link source/target strings to ForceNode refs after init; callers must build links fresh per populate.
- lastSettledPositions monotonic-growth note + prune step at populate-tail (delete ids not in current memories set).
- Density math arithmetic corrected (43%, not 97%).

**Removed from v2 (anchor scope deferred to E5):**
- `projectAnchor` field on `ForceNode`, `projectAnchorStrength` config, `projectAnchorRadius` config
- forceX/forceY per-node anchor accessors
- pickPathTag helper (no longer needed)
- Sort-index angle assignment + R7 collision risk (with hash alternative)
- S6 per-project-anchor section
- AC15, AC16 (project-anchor specific)
- R7, R8, R9 (project-anchor specific)

## Changes from v1

**Engineering (plan-eng-critic R1, 6 must-fix):**
- **S1 collide FIXED.** Shrunk `collideRadius` from 1.5 → **0.6** (matches max node visual radius ~0.5 + 20% buffer). Grew `bound` from 20 → **30**. Density now 1373 × π × 0.6² ≈ 1552 / (60×60) = 1600 → 97% packed but achievable. Adds new AC asserting alpha decays below alphaMin AND no node within ε=0.5 of `±bound` at `done()`.
- **S2(a) layer-Y EXPLICIT.** Scene populate edit named: `scene.ts:275 y = pos[1] * SPREAD * 0.5 + layerY + jitter` becomes `y = layerY + jitter`. PCA's y-component dropped. New AC8b verifies.
- **S1 step 1 CONCRETE formula.** PCA returns positions normalized to [-1, 1]. Warm-start: `node.x = pos[0] * bound` (clamped just in case); `node.y = pos[2] * bound` (force-Y = scene-Z). No undefined `spread`.
- **S1 contract gains `position(id)` O(1).** Internal `Map<string, ForceNode>` built at factory time. AC validates lookup at 10K-call microbench under 1ms total.
- **S2(a) populate perf AC added.** Total populate (existing teardown + node build + buildConflictLines + buildSharedTagEdges + buildAdjacency + buildForceLayout + setColorMode tail) **<400ms on 1373-fixture**. If real measurement exceeds, plan commits to moving force factory call to a `queueMicrotask` after populate returns synchronously (force-tick then skips frame 1 until init finishes). The MUST-STAY-SYNCHRONOUS contract for getEdgeCounts is preserved either way because edge counts don't depend on force layout.
- **S1 step 2 link shape EXPLICIT.** Links are `{source: aId, target: bId}` strings. Note added: d3-force mutates these to ForceNode refs after init. New test: adjacency entries with stale (memory-deleted) ids filter cleanly without throw.

**Design (plan-design-critic R1, 7 must-fix):**
- **First-frame snap FIXED.** Force factory now seeds from POST-jitter basePositions, not raw PCA. populate sets basePosition with jitter as today, THEN reads those into the seedPositions arg passed to buildForceLayout. First force-tick mutates basePosition to a value epsilon-close to where it already was. No snap.
- **Memory-refresh re-settle PREVENTED.** Scene caches the previous forceLayout's converged positions in `lastSettledPositions: Map<string, {x, z}>`. On subsequent populates, the SEED for the new layout is `lastSettledPositions ?? jitteredBasePositions ?? PCA`. Result: an existing memory's position barely moves; only the truly new/deleted memories trigger meaningful settle. `done()` typically reached in ~20-40 ticks instead of 300.
- **Freeze mid-settle FIXED.** New `forceLayout.runToCompletion()` ticks the simulation to `done()` synchronously without rAF. `setReducedMotion(true)` calls it BEFORE `snapParticlesToFinal` so the snapped pose is the converged final layout, not the mid-settle interim.
- **NEW S6: BottomBar settling affordance.** `buildAffordance` gains `forceSettling?: boolean` arg; appends `· layout: settling` while non-null AND true. Drops when done. Eliminates the "is this a bug or a feature" first-impression gap.
- **R6 compounding-wobble FIXED.** Drift physics gates on `forceLayout?.done() !== false`. Drift PAUSES while force is settling (clean motion = pure settle); resumes on convergence (subtle wobble around stable basePositions).
- **buildAdjacency MEMOIZED at useCanvasEngine.** Single useMemo over `[memories, conflicts]` produces the adjacency; passed BOTH to `scene.populate` (for force layout) AND to LivingMap (for E3 localNeighborhood). Eliminates the AC11 duplication.
- **PCA-divergence resolved by accepting + signaling.** Plan keeps PCA warm-start (avoids random-init flash). Acknowledges first-load settle could move memories far (force is structure-driven, PCA is variance-driven; they disagree). The BottomBar settling affordance (S6) IS the user signal. On subsequent populates, lastSettledPositions seed makes divergence near-zero.

**Anchors scope removed in v3:** per-project anchors are now a separate episode (E5, task #106). v3 is lean d3-force only.

## Why this exists

E1 added color differentiation. E2 added explicit edges. E3 added local-view collapse. All three worked around — but did not fix — the original "blue blob" cause: **PCA projection destroys 99%+ of embedding info**. E4 replaces PCA with a force-directed layout driven by E2's edges + (NEW) per-project anchors so memories cluster by both structural relationships and project membership.

E4 is the final episode of the Obsidian-inspired stack.

## Goal

Replace `projectTo3D` PCA-based positioning with d3-force layout driven by:
1. E3's `buildAdjacency` (conflict + shared-tag pairs) as attractive links
2. Node repulsion (forceManyBody) + collision (forceCollide) + weak center pull

Plus 2D-on-XZ + layer-Y preserved (E1/E5 metaphor), animated settle, freeze halts mid-stream without losing the final layout (bounded at 80 ticks of catch-up), BottomBar surfaces "layout: settling (initial|refresh)" affordance.

Per-project anchor forces are deferred to E5 (separate episode). See task #106.

## Discover findings

```
d3-force ^3.0.0 + @types/d3-force ^3.0.0 in ui/package.json + node_modules. CONFIRMED.
d3-force is 2D; for 3D either install d3-force-3d OR use 2D-on-XZ + LAYER_Y_OFFSET.
Decision: 2D + layer-Y; no new dep; preserves E1/E5.

scene.ts L19: LAYER_Y_OFFSET = {buffer:6, episodic:0, semantic:-6}
scene.ts L225-227: positions consumed in populate with SPREAD=20 multiplier.
scene.ts L275: y = pos[1]*SPREAD*0.5 + layerY + jitter   ← MUST CHANGE (S2a)
scene.ts L663-700: animate loop (rAF + paused gate)
scene.ts L720-731: setReducedMotion / snapParticlesToFinal   ← MUST CALL runToCompletion (S2c)
useCanvasEngine.ts L78: projectTo3D(embeddings) call site   ← unchanged
useCanvasEngine.ts L96-106: populate effect deps [memories, embeddings, conflicts]   ← unchanged

Edge source: ui/src/engine/localNeighborhood.buildAdjacency (E3).
  REUSE exactly (hoisted to useCanvasEngine useMemo per memoization fix).

Path tag distribution (from real fixture):
  Unique path:* values: ~12 (path:skf_s, path:quantamental, path:hippo, path:phzse,
    path:mure, path:luminus, path:luminus-dashboard, path:resona, path:production,
    path:clawd, path:2chain, and a few rarer ones).
  90% of memories carry at least one path:* tag.

Performance constraints:
  60fps = 16.7ms/frame budget.
  THREE.render baseline ~6-8ms post-E2.
  Force-tick budget: ~6-8ms (d3-force quadtree O(N log N) on 1373 ≈ 14K ops/tick ≈ 3-5ms).
  Plus per-tick basePosition update over 1373 nodes ≈ 0.5ms.
  Plus per-tick O(1) position lookup ≈ negligible.
  Total tick budget achievable.
  populate budget: <400ms on 1373-fixture (existing populate ~50-100ms + buildAdjacency ~150ms + buildForceLayout init ~50ms).
```

## Scope

### S1 — Pure factory: `forceLayout.ts`

NEW file `ui/src/engine/forceLayout.ts`:

```typescript
import * as d3 from "d3-force";
import type { Memory } from "../types.js";
import type { AdjacencyMap } from "./localNeighborhood.js";

export interface ForceNode {
  id: string;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  // (v2's projectAnchor field deferred to E5; ForceNode shape stays lean here)
}

export interface ForceLayoutConfig {
  alphaMin?: number;          // default 0.01
  alphaDecay?: number;        // default 1 - alphaMin^(1/maxTicks) (auto-aligned)
  maxTicks?: number;          // default 300
  /** v3 — cap ticks when runToCompletion is called from setReducedMotion.
   * Trades a slightly-less-converged freeze pose for sub-perceptual block. */
  maxTicksOnFreeze?: number;  // default 80 (~400ms block worst case)
  linkStrength?: number;      // default 0.4
  chargeStrength?: number;    // default -30
  centerStrength?: number;    // default 0.05
  collideRadius?: number;     // default 0.6  (v1 was 1.5; over-saturated)
  bound?: number;             // default 30   (v1 was 20; tight for collide)
}

const DEFAULTS = {
  alphaMin: 0.01,
  maxTicks: 300,
  maxTicksOnFreeze: 80,
  linkStrength: 0.4,
  chargeStrength: -30,
  centerStrength: 0.05,
  collideRadius: 0.6,
  bound: 30,
};

/**
 * v0.28+ E4 — pure force-layout factory.
 *
 * Returns {tick, runToCompletion, done, position, ticksRun, settledPositions,
 * onSettleStateChange}. Caller drives tick() from BrainScene.animate.
 * Disposal = drop reference.
 *
 * Warm-start (v3): seedPositions takes XZ coords per memory id. Callers
 * pass POST-jitter basePosition values on FIRST populate (no PCA at all
 * at this layer; PCA still seeds basePosition in scene.populate via the
 * existing `positions` arg, then the jitter is added). On subsequent
 * populates, lastSettledPositions is passed instead, so existing memories
 * barely move and settle converges in ~30-50 ticks.
 *
 * Link contract: d3-force MUTATES link.source/link.target in-place after
 * init, replacing the string ids with ForceNode references. Callers must
 * therefore build links fresh per populate cycle; do not reuse the link
 * array across cycles.
 *
 * Determinism: pass `randomSource: mulberry32(seed)` in config to get
 * reproducible final positions. Default uses Math.random.
 */
export function buildForceLayout(
  memories: readonly Memory[],
  adjacency: AdjacencyMap,
  seedPositions: Map<string, { x: number; z: number }> | null,
  config: ForceLayoutConfig = {},
): {
  tick(): void;
  /** Tick synchronously until done() OR the optional cap. Used by
   * setReducedMotion with maxTicksOnFreeze to bound the freeze block. */
  runToCompletion(maxTicks?: number): void;
  done(): boolean;
  position(id: string): { x: number; z: number } | undefined;  // O(1)
  ticksRun(): number;
  /** Snapshot all node positions for use as seedPositions on the NEXT populate. */
  settledPositions(): Map<string, { x: number; z: number }>;
  /** Subscribe to settling start/stop events. Fires once with `true` when
   * tick() is first called from a not-done state, once with `false` when
   * done() flips. Returns unsubscribe. */
  onSettleStateChange(cb: (settling: boolean) => void): () => void;
} { /* impl */ }
```

**Algorithm:**

1. **Build `ForceNode[]`** from memories.
   - For each memory: `id = m.id`.
   - Seed `x, y` from `seedPositions.get(m.id)`:
     - If present → `x = clamp(seed.x, -bound, bound)`, `y = clamp(seed.z, -bound, bound)` (force-Y maps to scene-Z).
     - Else → use d3-force default polar init.
   - There is NO raw-PCA-from-vectors path here. The caller (scene.populate) is responsible for choosing what to put in seedPositions: post-jitter basePositions on first populate, lastSettledPositions on subsequent.

2. **Build `Links[]`** from adjacency.
   - For each `(u, neighbors)` in adjacency: for each `v` in neighbors, if `u < v` (lex) emit `{source: u, target: v}` (string ids; deduped).
   - Filter out links whose source OR target id is NOT in the ForceNode set (handles stale adjacency referencing deleted memories — R4 mitigation).

3. **Build internal `Map<string, ForceNode>`** for O(1) `position(id)` lookup.

4. **Configure simulation:**
   - `forceLink(links).id(d => d.id).strength(linkStrength).distance(2.5)`
   - `forceManyBody().strength(chargeStrength)` — Barnes-Hut quadtree repulsion
   - `forceCenter(0, 0).strength(centerStrength)` — weak origin pull
   - `forceCollide(collideRadius)` — prevent overlap (0.6, matches max node radius + buffer)
   - `.alphaDecay(alphaDecay ?? (1 - Math.pow(alphaMin, 1 / maxTicks)))` — auto-aligned so alpha reaches alphaMin at exactly maxTicks. Parens matter; `Math.pow` not `^` (JS XOR).
   - If `config.randomSource` provided, call `simulation.randomSource(config.randomSource)` — used by perf-fixture test with `mulberry32(42)` for determinism.
   - Call `.stop()` immediately (no auto-tick).

5. **`tick()`**: if `done()`, no-op. Otherwise call `simulation.tick()`, increment `ticksRun`, clamp each node to `[-bound, bound]`. If this is the first tick since not-done, fire `onSettleStateChange(true)` listeners.

6. **`runToCompletion(maxTicks?)`**: `while (!done() && ticksRun < (start + (maxTicks ?? Infinity))) tick();` — synchronous, no rAF. setReducedMotion passes `maxTicksOnFreeze` (default 80) to cap the worst-case main-thread block at ~400ms.

7. **`done()`**: `ticksRun >= config.maxTicks || simulation.alpha() <= alphaMin`. After flipping true for the first time, fire `onSettleStateChange(false)` listeners.

8. **`settledPositions()`**: returns `Map<id, {x, z}>` from current node state.

9. **`onSettleStateChange(cb)`**: subscribe; fires once with `true` on first tick from not-done, once with `false` when done flips. Returns unsubscribe. Used by LivingMap → BottomBar for the "layout: settling" affordance with no per-tick React renders.

### S2 — Scene engine integration

**(a) populate edits + layer-Y drop + forceLayout build:**

`scene.ts` populate (~L275 + tail):

```typescript
// L275 OLD: y = pos[1] * SPREAD * 0.5 + layerY + (Math.random() - 0.5) * 2;
// L275 NEW (drops PCA-y contribution):
const y = layerY + (Math.random() - 0.5) * 2;
```

After populate body (nodes built with jittered basePositions), at the tail:

```typescript
// v0.28+ E4 — build force layout. seedPositions = the JITTERED basePositions
// we just set (NOT raw PCA), so first force-tick mutates positions epsilon-close
// to where they already are. On subsequent populates, lastSettledPositions
// (from previous forceLayout) takes priority over jittered seeds so existing
// memories barely move.
const seedPositions = new Map<string, { x: number; z: number }>();
for (const node of this.nodes) {
  const prior = this.lastSettledPositions?.get(node.id);
  if (prior) {
    seedPositions.set(node.id, prior);
  } else {
    seedPositions.set(node.id, { x: node.basePosition.x, z: node.basePosition.z });
  }
}
this.forceLayout = buildForceLayout(memories, adjacency, seedPositions);

// existing tail (unchanged):
this.setColorMode(this.currentColorMode, memories);
```

**Note on adjacency**: populate now takes adjacency as a NEW arg (passed from useCanvasEngine memoized build) instead of computing internally. New signature:

```typescript
populate(
  memories: Memory[],
  positions: Record<string, [number, number, number]>,
  conflicts: Conflict[],
  adjacency: AdjacencyMap,   // NEW v0.28+ E4 — memoized at useCanvasEngine
): void { ... }
```

**(b) animate force-tick + R6 drift-pause:**

`scene.ts` animate (~L663-700):

```typescript
animate = (): void => {
  if (this.disposed || this.paused) return;
  this.rafId = requestAnimationFrame(this.animate);

  // v0.28+ E4 force-tick BEFORE drift physics so drift oscillates
  // around the new basePositions in the same frame.
  const forceSettling = this.forceLayout !== null && !this.forceLayout.done();
  if (forceSettling) {
    this.forceLayout!.tick();
    for (const node of this.nodes) {
      const p = this.forceLayout!.position(node.id);
      if (!p) continue;
      node.basePosition.x = p.x;
      node.basePosition.z = p.z;
      // basePosition.y intentionally UNCHANGED (layer-Y preserved per S2a).
    }
    // Snapshot for next populate when settle completes this frame.
    if (this.forceLayout!.done()) {
      this.lastSettledPositions = this.forceLayout!.settledPositions();
    }
  }

  // v0.28+ E4 R6 — pause drift while force is settling. Resumes on convergence.
  if (!forceSettling) {
    // ...existing drift physics body unchanged...
  }

  // ...existing fading-ring billboard...
  // ...existing onRender callbacks...
  // ...composer.render()...
};
```

**(c) `setReducedMotion` runs simulation to completion (bounded) before snap:**

```typescript
setReducedMotion(reduced: boolean): void {
  this.paused = reduced;
  if (reduced) {
    // v3 — PRESERVE existing rafId cleanup (scene.ts:723-726) so the
    // unfreeze guard below (`this.rafId === 0`) can correctly detect the
    // need to restart the loop. plan-eng-critic R3 HIGH catch: dropping
    // this cleanup stranded freeze→unfreeze cycles after the first toggle.
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    // Finish force settle BEFORE snapping. Bounded to maxTicksOnFreeze
    // (default 80) so the freeze isn't a multi-second main-thread block on
    // first-load reduced-motion users. Worst case: 80 × ~5ms = ~400ms.
    // Trade: freeze pose may be slightly under-converged on first load,
    // but converges fully on next unfreeze + tick.
    if (this.forceLayout && !this.forceLayout.done()) {
      this.forceLayout.runToCompletion(80); // maxTicksOnFreeze
      for (const node of this.nodes) {
        const p = this.forceLayout.position(node.id);
        if (!p) continue;
        node.basePosition.x = p.x;
        node.basePosition.z = p.z;
      }
      if (this.forceLayout.done()) {
        this.lastSettledPositions = this.forceLayout.settledPositions();
      }
    }
    this.snapParticlesToFinal();
  } else if (this.rafId === 0) {
    this.animate();
  }
}
```

**(d) New scene field: `lastSettledPositions`**

```typescript
private lastSettledPositions: Map<string, { x: number; z: number }> | null = null;
```

Survives across populate calls (intentional). Reset only when memory id-set fundamentally changes — but the cleanest signal is just `if (!seedPositions.get(id)) fall back to jittered basePosition` per S2(a). No explicit cache-invalidation needed.

### S3 — useCanvasEngine memoizes adjacency + threads through

`ui/src/views/LivingMap/useCanvasEngine.ts`:

```typescript
// NEW: memoize adjacency over [memories, conflicts] so both scene.populate
// (for force layout) and LivingMap (for E3 localNeighborhood) consume one
// computation. Eliminates the AC11 duplication.
const adjacency = useMemo(
  () => buildAdjacency(memories, conflicts),
  [memories, conflicts],
);

useEffect(() => {
  const scene = sceneRef.current;
  if (!scene || memories.length === 0) return;
  const positions = projectTo3D(embeddings);
  scene.populate(memories, positions, conflicts, adjacency);  // ← adjacency added
  setEdgeCounts(scene.getEdgeCounts());
}, [memories, embeddings, conflicts, adjacency]);

// Existing return — caller (LivingMap) already destructures edgeCounts.
// Add `adjacency` to the return so LivingMap uses the SAME instance.
return { containerRef, handleMouseMove, handleClick, handleKeyDown, edgeCounts, adjacency };
```

`ui/src/views/LivingMap/LivingMap.tsx`: replace its own `buildAdjacency` useMemo with the one returned from useCanvasEngine:

```typescript
const { containerRef, /* ... */, adjacency } = useCanvasEngine({ /* ... */ });
// REMOVE: const adjacency = useMemo(() => buildAdjacency(memories, conflicts), [memories, conflicts]);
// (keep the localNeighborhood useMemo, which now consumes the hoisted adjacency)
```

### S4 — `setReducedMotion` composes (already implemented in S2c)

Already addressed.

### S5 — BottomBar settling affordance

`ui/src/components/BottomBar.tsx`:

```typescript
interface BottomBarProps {
  // ...existing...
  /** v3 — when 'initial', append ` · layout: settling (initial)` (first
   * populate after page load — user expects mass drift). When 'refresh',
   * append ` · layout: settling (refresh)` (subsequent populate — signals
   * "your action triggered this"). Undefined = no clause. */
  forceSettling?: "initial" | "refresh";
}

export function buildAffordance(
  colorMode: ColorMode,
  edges: EdgeCounts | undefined,
  localView?: { size: number; cappedFrom?: number },
  forceSettling?: "initial" | "refresh",
): string {
  // ...existing parts...
  if (forceSettling) parts.push(`layout: settling (${forceSettling})`);
  // ...
}
```

**BottomBar overflow note (R4 design HIGH):** with 9 clauses stacked (size, opacity, lines/3 kinds, color, view, layout-settling), affordance string can exceed the right-region width at narrow viewports. v3 ships with the string as-is and explicit `text-overflow: ellipsis` on the affordance div. Responsive break / relocation deferred to v0.3.0 polish ticket. AC13b new: `affordance div has CSS text-overflow: ellipsis + overflow: hidden + max-width: 50% of BottomBar width`.

**Delivery mechanism (locked v3):** `BrainScene.onSettleStateChange((settling: boolean, source?: 'tick' | 'reduced-motion') => void)` subscription. Source param lets the React subscriber suppress the settling clause when the settle was driven by setReducedMotion (no actual animation visible). useCanvasEngine wires:

```typescript
const [forceSettling, setForceSettling] = useState<"initial" | "refresh" | undefined>(undefined);
const settlingKindRef = useRef<"initial" | "refresh">("initial"); // first populate = "initial"

useEffect(() => {
  if (!scene) return;
  return scene.onSettleStateChange((settling) => {
    if (settling) {
      setForceSettling(settlingKindRef.current);
    } else {
      setForceSettling(undefined);
      settlingKindRef.current = "refresh"; // all subsequent settles = "refresh"
    }
  });
}, [scene]);
```

LivingMap destructures `forceSettling` from useCanvasEngine + passes to BottomBar prop. Two React re-renders per settle cycle (start + stop) — minimal cost, no per-tick render.

### S6 — (Removed in v3)

Per-project anchor forces deferred to E5 (task #106) with own design budget for legend + anchor-order persistence + refresh signaling.

### S7 — Tests

NEW `ui/src/engine/forceLayout.test.ts`:
- `buildForceLayout` factory returns the contract (tick / runToCompletion / done / position / ticksRun / settledPositions).
- Warm-start: seedPositions taken, initial position(id) matches (within bound clamp).
- No-warm-start: positions populated from d3-force default polar init.
- `tick()` increments ticksRun by 1.
- `done()` true when ticksRun >= maxTicks (even if alpha hasn't converged).
- `done()` true when alpha <= alphaMin (even if ticksRun < maxTicks).
- `runToCompletion()` makes `done()` true synchronously.
- Settled positions stay within `[±bound]` (clamp enforced).
- Connected nodes (in adjacency) end up closer than two unconnected nodes (loose assertion; force is stochastic — use sufficient ticks).
- **Stale adjacency**: when adjacency contains an id NOT in memories, factory filters it from links and does not throw (R4 mitigation).
- **Convergence**: alpha decays below alphaMin within maxTicks on the 1373-node synthesized fixture (NEW AC4b).
- **No node at bound clamp at done()**: after runToCompletion, every node's |x| AND |y| < bound − 0.5 (NEW AC4c). Validates the collide-radius fix.
- **O(1) position lookup**: 10000 sequential position(id) calls on a 1373-node sim complete in <1ms total (NEW AC5).
- **AC PERF**: 300 ticks on 1373-node + 2100-edge synthesized fixture <2.0s (existing AC12).
- **Determinism**: same seed → same final positions (via simulation.randomSource(seededRng)).

Extend `ui/src/state/filterState.test.ts`, `ui/src/components/BottomBar.test.tsx`: add cases for the new `forceSettling` arg in buildAffordance.

(No new direct scene test — same approach as E3.)

### S8 — Adjacency single-instance through useCanvasEngine (memoization)

Covered in S3 above.

## Acceptance criteria

| # | Criterion | Verifies |
|---|---|---|
| AC1 | `forceLayout.ts` pure factory; no auto-tick | S1 |
| AC2 | Warm-start: seedPositions honored | S1 |
| AC3 | `done()` true at alphaMin OR maxTicks | S1 |
| AC4 | Settled positions within ±bound clamp | S1 |
| AC4b | Alpha decays to alphaMin within maxTicks on 1373-fixture | S7 |
| AC4c | At done(), every node \|x\| AND \|y\| < bound − 0.5 (collide fits) | S7 |
| AC5 | `position(id)` O(1) — 10K sequential calls <1ms | S7 |
| AC6 | scene.populate calls buildForceLayout(memories, adjacency, seedPositions) | S2a |
| AC7 | scene.animate ticks forceLayout when !done; updates basePosition.x AND .z (NOT .y) | S2b |
| AC8 | done() → animate skip; zero force-tick cost per frame | S2b |
| AC8b | scene.populate sets basePosition.y = LAYER_Y_OFFSET[layer] + jitter ONLY; no pos[1] contribution | S2a |
| AC9 | First force-tick after first populate produces basePosition within epsilon of jittered seed (no snap) | S2a |
| AC10 | Subsequent populates use lastSettledPositions as seed; settle converges in ≤50 ticks for unchanged memory set | S2a |
| AC11 | setReducedMotion(true) runs forceLayout to completion BEFORE snapParticlesToFinal | S2c |
| AC12 | Drift physics pauses while forceSettling; resumes on done() | S2b R6 |
| AC13 | BottomBar appends `· layout: settling (initial)` on first populate, `(refresh)` thereafter; drops on done | S5 |
| AC14 | useCanvasEngine memoizes adjacency over [memories, conflicts]; LivingMap consumes hoisted instance | S3 |
| AC15 | runToCompletion accepts optional maxTicks cap; setReducedMotion calls with 80; worst-case main-thread block <500ms on 1373-fixture | S2c |
| AC16 | Stale adjacency (id not in memories) does not throw; link filtered cleanly | S1 R4 |
| AC17 | populate() including new buildForceLayout + setColorMode tail <400ms on 1373-fixture | S2a |
| AC18 | 300 ticks on 1373-node + 2100-edge fixture <2.0s (perf test with mulberry32(42) for determinism) | S7 |
| AC19 | Force-tick perf: <8ms per tick on 1373-node fixture | S7 |
| AC20 | lastSettledPositions prunes ids not in current memories at populate-tail | S2a |
| AC21 | E1+E2+E3 features (color modes, edges, local view, BottomBar) all still work | regression |
| AC22 | No test regressions: full ui/ + repo-root suites green | regression |

## Risks (revised)

| # | Risk | Lik. | Mitigation |
|---|---|---|---|
| R1 | Force-tick exceeds 8ms on slow hardware | M | done() stops cost; lastSettledPositions seed makes subsequent settles ≤50 ticks; if main thread jank visible in smoke, drop maxTicks to 150 + recompute alphaDecay |
| R2 | First-load mass drift distracting (large divergence between PCA seed and structure-driven equilibrium) | M | BottomBar settling affordance gives the cue. R6 drift-pause keeps motion clean. If still jarring, drop chargeStrength to -15 (gentler push). |
| R3 | Subsequent populate where memory set unchanged but conflicts updated triggers full re-settle | L | lastSettledPositions seed means existing memories barely move (~30 ticks); only force-tick cost is per-tick BFS-like quadtree operation, ~0.5-1s acceptable |
| R4 | Stale adjacency throws on init | L | Link-filter in S1 step 3 removes; tested |
| R5 | Determinism via simulation.randomSource only covers d3 jiggle; warm-start path takes seedPositions which IS deterministic | L | Document; no-warm-start branch acceptably non-deterministic (only test fixtures hit it) |
| R6 | Compounding drift+force wobble | L | FIXED: drift gated on done() |
| R7 | runToCompletion freeze pause noticeable on slow hardware | L | maxTicksOnFreeze=80 caps at ~400ms; sub-perceptual on typical hardware; first-unfreeze finishes the remaining settle naturally |
| R8 | populate >400ms blocks main thread | M | AC17 enforces; if exceeded, plan commits to `queueMicrotask(() => this.forceLayout = buildForceLayout(...))` after populate returns; force-tick skips first frame until init done |

## Out of scope (named, deferred)

- **3D force (d3-force-3d)** — needs new dep + breaks layer-Y. Defer.
- **Web Worker offload** — only if R1 manifests in smoke; profile-driven.
- **Throttled tick (every-other-frame)** — defer.
- **User-adjustable force parameters** (sliders) — lock taste first.
- **Animate transition INTO local view from full graph** — separate animation system; defer.
- **Animation when project anchors change** (e.g. user adds a new project to a memory) — relies on the next populate-driven re-settle; smooth animation deferred.
- **Drag-to-pin** (sticky node positions) — d3-force supports via fx/fy; defer.
- **Sidebar legend of project anchors** (show which color = which project at which anchor) — useful future addition; defer to v0.3.0.
- **Random-init flash UX** — keeping PCA warm-start so this isn't a concern.
- **`projection.ts` deletion** — still used as warm-start.
- **scene.ts direct unit tests** — needs WebGL stubs; defer to v0.3.0 ticket.

## Rollback

Single PR, revertible:
- Revert → forceLayout.ts removed; scene.populate signature reverts (drops adjacency arg); scene.animate's force-tick branch removed; scene.populate restores `y = pos[1]*SPREAD*0.5 + layerY + jitter`; setReducedMotion drops runToCompletion call; useCanvasEngine drops adjacency useMemo + adjacency return; LivingMap restores its own buildAdjacency useMemo; BottomBar drops forceSettling prop/clause.
- No data migration; pure positioning + ergonomics change.

## Cost estimate

- Coding: ~6-8 hours (forceLayout.ts + scene 4-block edit + useCanvasEngine memo hoist + LivingMap refactor + BottomBar settling clause + tests + tuning)
- Critic rounds: ~1.5-2 hours
- Visual smoke: ~30-45 min (full settle + project clustering + freeze mid-settle)
- Total: ~1.5-2 days

## Resolved open questions (from v1)

1. ~~maxTicks=300 default?~~ → **Kept; with auto-aligned alphaDecay = 1 - alphaMin^(1/300) the simulation converges at exactly maxTicks.** lastSettledPositions seed makes subsequent populates settle in ≤50 ticks (AC10).
2. ~~chargeStrength=-30 default?~~ → **Kept** as starting point; tunable; visual smoke confirms.
3. ~~Force-tick BEFORE drift or AFTER?~~ → **Before (locked in S2b).** Drift PAUSED while settling per R6 fix, so order matters less but before is cleaner.
4. ~~PCA stays or scope-cut?~~ → **Stays as warm-start.** With S2a seedPositions taking POST-jitter basePositions on first populate AND lastSettledPositions on subsequent, the divergence concern is bounded. BottomBar settling affordance handles the first-load case.
5. ~~forceLayout field public or private?~~ → **Private**, no external accessor.
