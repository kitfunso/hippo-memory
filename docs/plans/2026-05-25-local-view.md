# 2026-05-25 — Local graph view (E3 of Obsidian-inspired graph upgrades stack)

**Status:** Draft v2 (addressing R1 must-fix from plan-eng-critic + plan-design-critic)
**Episode:** 01KSFCYZDM6JG73N0C3XZNZ9WX
**Branch:** feat-local-view (off feat-real-edges, rebases when E2 PR #62 lands)
**Owner:** Claude (Keith review)

## Changes from v1 (R1 must-fix incorporated)

Engineering (plan-eng-critic R1, 5 must-fix):
- **S6 Esc wire FIXED** — `setLocalView(null)` lives at the `onClickMemory(null)` convergence point in `LivingMap.tsx`, NOT in DetailPanel `onClose`. All three selection-clear paths (Escape key, esc button, click-empty-space) route through this point — so all three clear both selection and localView consistently. AC3 verifiable.
- **S6 Esc handler site CORRECTED** — actual location is `useCanvasEngine.ts:177-179` (`scene.handleKeyDown` returned + attached at `LivingMap.tsx:213 onKeyDown`). NOT App.tsx (which has F-key handler at L110-118 only).
- **S2/S5 perf budget RESOLVED** — adjacency is hoisted to a `useMemo` over `[memories, conflicts]` in `LivingMap.tsx`. `computeSharedTagPairs` runs ONCE per memories/conflicts change (not per localView change). Helper `computeLocalNeighborhood` takes prebuilt adjacency + does only BFS. New perf budget: BFS <5ms on 1373-memory adjacency at depth=2 (helper); adjacency build <100ms one-shot (covered by E2's existing perf test, NOT a new gate).
- **S2 BFS visited-on-enqueue SPECIFIED** — visited set marked when node enters queue, not on dequeue. Prevents re-expansion of well-connected hubs.
- **S4(b) tendril invariant** — tendril lines also iterated with same endpoint-id guard. Tendrils don't currently get `userData.aId/bId` (they bail on n>500 so never built on live fixture), but adding the iteration is defensive: if E4 force-layout ever rebuilds tendrils for n>500, the visibility filter works without a second pass.

Design (plan-design-critic R1, 7 must-fix):
- **NEW S8 BottomBar affordance update — IN scope** — `buildAffordance` appends ` · view = local (N)` when localView active (N = neighborhood size). Removes the "DetailPanel-closed orientation gap" the critic flagged.
- **S6 focus button — three labels, not active/inactive flicker** — button text changes:
  - Idle (no focus active): `focus`
  - This memory IS the center: `focused` (rust accent — matches freeze active pattern)
  - Focus active on a different memory: `recenter here` (text-only, rust foreground, no border) — clicking re-centers focus on this memory
  Eliminates the "active-state lies on re-mount" inconsistency.
- **S4 frayed half-line CHANGED → Obsidian default** — both endpoints must be visible to draw a line. Eliminates the half-line-reads-as-bug risk. (v1's "frayed extends off-frame" was unjustified.)
- **NEW S9 neighborhood size hard cap** — if `computeLocalNeighborhood(..., depth=2)` returns > 60 ids, helper falls back to `depth=1` (same algorithm, smaller depth). Returns a `{ memoryIds: Set<string>, depthUsed: number, cappedFrom?: number }` shape so UI can show "Showing depth 1 (28 nodes); depth 2 would have shown 152 — defer slider to v0.3.0" hint in BottomBar.
- **S6 focusBtnStyle CONCRETE** — `background: 'var(--ink-faint)', border: '1px solid var(--glass-border)', color: 'var(--dim)', borderRadius: 4, padding: '4px 12px', fontFamily: 'var(--font-mono)', fontSize: 11` for idle (distinct from esc button which uses no border + smaller padding). Active state bumps to `border: '1px solid var(--accent)', background: 'rgba(196, 92, 60, 0.18)'` (alpha 0.18 not 0.10 per critic).
- **Esc dual-clear COMMITTED** — single press of Esc (or esc button or empty-space click) clears BOTH selectedMemory AND localView. Documented design rule: "closing the inspector closes its focused view." Stepped Esc deferred to v0.3.0 if user feedback wants the separation.
- **S5 stale-centerId GUARDED** — `setLocalView` callback in App.tsx verifies `memories.some(m => m.id === v.centerId)` before accepting. If centerId not in current memories, callback no-ops. Sidebar empty-state never gets the stale-focus diagnosis (because localView state never becomes invalid).

## Why this exists

E1 (color-by-tag, PR #61) gave the graph multi-axis color so the 1232-episodic blob differentiates. E2 (real-edges, PR #62) gave it explicit conflict + shared-tag edges so the spatial relationships are real, not just PCA proximity. E3 is the Obsidian feature users reach for most: **click a node, see only that node and its neighborhood**, drop the rest of the graph for the duration. Lets the user focus when the 1373-memory view feels too much.

E3 of 4 in the Obsidian-inspired stack:
1. E1 color-by-tag (PR #61, awaiting Keith merge)
2. E2 real edges (PR #62, awaiting Keith merge)
3. **E3 (this plan) — local graph view (N-hop from selected)**
4. E4 force-directed layout (replaces PCA, queued)

## Goal

Add a **"Focus on neighborhood"** affordance: when the user has a memory selected (via the existing click-to-select + DetailPanel flow), they can click a button to collapse the graph to that memory + its N-hop neighborhood (default depth 2, hard-capped at 60 nodes with depth-1 fallback) via the explicit edges added in E2. Esc clears both the focus AND the selection (matches existing Esc-clears-selection behaviour). BottomBar surfaces the focused state so users don't lose orientation when DetailPanel closes.

## Discover findings (these drive the plan)

```
Existing selection infrastructure:
  scene.ts L71  : selectedNode field
  scene.ts L642 : deselect() resets mesh scale
  useCanvasEngine.ts L177-179: handleKeyDown returns Esc->scene.deselect()
  LivingMap.tsx L132: selectedMemory state
  LivingMap.tsx L180-183: onClickMemory (the convergence point — all clear paths)
  LivingMap.tsx L316: DetailPanel mount {memory, onClose, open}

Existing filter infrastructure:
  filterState.ts isFilterActive: drives Sidebar empty-state + scene.setFiltered
  scene.ts L756 setFiltered: iterates this.nodes only — DOES NOT touch lines

DISCOVER GOTCHA (addressed in S4):
  setFiltered hides spheres+halos only. conflictLines + sharedTagEdges +
  tendrils all stay drawn regardless of node visibility. Local view of 5
  memories renders 5 spheres + ALL lines in the scene including
  between-hidden-nodes lines. Conflict line.userData has {status} from
  E2 but NOT endpoint ids. Plan adds aId/bId.

Edge data available:
  Conflicts: from conflicts[] passed to populate (always available, 1117
    still-present pairs on live fixture)
  Shared-tag pairs: from computeSharedTagPairs(memories) (E2 pure helper,
    tiered cap-bounded, callable on any-n memories)

Existing Esc behaviour:
  App.tsx ~L104: keyboard F toggles freeze (NOT Esc)
  useCanvasEngine.ts L177-179: handleKeyDown Esc -> scene.deselect()
  scene.deselect() -> onClickCb(null) -> onClickMemory(null) at
    LivingMap.tsx L180-183 -> setSelectedMemory(null)
  All paths (Esc key, esc button, click empty space) terminate at
    onClickMemory(null). That's where setLocalView(null) belongs.
```

## Scope

### S1 — Extend `FilterState` with `localView`

`ui/src/state/filterState.ts`:

```typescript
export interface LocalViewState {
  /** Memory ID at the center of the focus. Guaranteed to exist in current
   * memories at set-time (App.tsx setLocalView guards this). */
  centerId: string;
  /** N-hop depth from center. v1 default = 2. Hard-capped by helper at 5. */
  depth: number;
}

export interface FilterState {
  // ...existing fields...
  /** v0.28+ — when non-null, deriveVisibleIds returns only memories within
   * `depth` hops of `centerId` via the union of conflict-pairs +
   * shared-tag-pairs. Composes with other filters (AND).
   * VIEW state (composes with colorMode); resetFilters DOES clear it
   * (matches "reset = back to full graph"). */
  localView: LocalViewState | null;
}

export const INITIAL_FILTER_STATE: FilterState = {
  // ...
  localView: null,
};
```

**`isFilterActive`** includes `if (state.localView !== null) return true;`. Same critical wire as E1 `fadingOnly` + E1 carefully NOT-included `colorMode`. Local view IS a filter (it hides memories); colorMode is NOT (it recolors).

**`resetFilters`** clears localView alongside the other filter fields. Preserves frozen + colorMode (E1 carryover):
```typescript
const resetFilters = useCallback(() => {
  setFilterState((prev) => ({
    ...INITIAL_FILTER_STATE,
    frozen: prev.frozen,
    colorMode: prev.colorMode,
    // localView IS reset (back to null) — matches user model
  }));
}, []);
```

**`deriveVisibleIds`** gains an optional `localNeighborhood?: Set<string>` arg (only one current caller — LivingMap.tsx L139 — verified safe to extend):

```typescript
export function deriveVisibleIds(
  memories: Memory[],
  state: FilterState,
  localNeighborhood?: Set<string>,
): Set<string> {
  // ...existing per-memory filters...
  if (state.localView !== null && localNeighborhood !== undefined
      && !localNeighborhood.has(m.id)) continue;
  // (safe degradation: if state.localView set but neighborhood undefined,
  //  local-view filter silently skips — tested)
  // ...
}
```

### S2 — Pure helper: `computeLocalNeighborhood`

NEW file `ui/src/engine/localNeighborhood.ts`:

```typescript
import type { Memory, Conflict } from "../types.js";

export interface LocalViewResult {
  /** The memory IDs to keep visible (always includes centerId). */
  memoryIds: Set<string>;
  /** The depth actually used. If the requested depth exceeded the
   * neighborhood-size cap, the helper falls back to depth-1. */
  depthUsed: number;
  /** Set ONLY when the helper fell back from a higher depth. UI uses
   * this to show the "showing depth-1 (X nodes); depth-2 would have
   * shown Y" affordance. */
  cappedFrom?: { requestedDepth: number; wouldHaveBeen: number };
}

export interface AdjacencyMap {
  /** Pre-built undirected adjacency over the union of conflict-pairs +
   * shared-tag-pairs. Hoisted to a useMemo in LivingMap so localView
   * changes don't re-pay the build cost. */
  get(id: string): ReadonlySet<string> | undefined;
}

const HARD_DEPTH_CAP = 5;       // sanity guard against bad input
const NEIGHBORHOOD_CAP = 60;    // local view feels local only if <=60 nodes

/**
 * BFS from centerId via the prebuilt adjacency map. Pure + deterministic.
 *
 * Algorithm:
 *   1. Init visited = new Set([centerId]); queue = [centerId]; depthOf = {centerId: 0}.
 *   2. While queue: pop u, depth = depthOf[u]. If depth >= cap, continue.
 *      For each v in adjacency.get(u) ?? []:
 *        If v not in visited: visited.add(v); depthOf[v] = depth+1;
 *        queue.push(v). (Mark visited on ENQUEUE, not dequeue.)
 *   3. After BFS, if |visited| > NEIGHBORHOOD_CAP AND depth > 1:
 *        Re-run at depth-1 (one recursive call); return result with cappedFrom set.
 *      Else return {memoryIds: visited, depthUsed: depth}.
 *
 * Performance budget: <5ms on the live 1373-memory adjacency at depth=2.
 * Adjacency build cost is hoisted to LivingMap useMemo (NOT measured here).
 */
export function computeLocalNeighborhood(
  adjacency: AdjacencyMap,
  centerId: string,
  depth: number,
): LocalViewResult { /* impl per algorithm above */ }

/** Build adjacency from conflict-pairs (both directions) + shared-tag pairs. */
export function buildAdjacency(
  memories: readonly Memory[],
  conflicts: readonly Conflict[],
): AdjacencyMap { /* impl: union of conflict edges + computeSharedTagPairs */ }
```

### S3 — `deriveVisibleIds` composes `localView`

Already covered in S1 — `deriveVisibleIds` gains optional `localNeighborhood` arg.

### S4 — Scene: extend line visibility to filter both endpoints (Obsidian default)

`ui/src/engine/scene.ts`:

(a) **Store endpoint IDs on `line.userData` at build time** — merge into existing payload:
- `buildConflictLines` (~L538): existing `line.userData = { status: c.status }` becomes `line.userData = { status: c.status, aId: c.memory_a_id, bId: c.memory_b_id }`.
- `buildSharedTagEdges` (~L400): adds `line.userData = { aId: p.a, bId: p.b }` (currently no userData).

(b) **Extend `setFiltered` — Obsidian default: BOTH endpoints must be visible:**

```typescript
setFiltered(visibleIds: Set<string>, filterActive: boolean): void {
  for (const node of this.nodes) {
    const visible = !filterActive || visibleIds.has(node.id);
    node.mesh.visible = visible;
    node.halo.visible = visible;
  }
  // v0.28+ E3 — Obsidian default: a line is visible ONLY when both endpoints
  // are visible. Otherwise hide (no "frayed half-lines"; eliminates the
  // reads-as-bug ambiguity flagged by plan-design-critic R1 HIGH).
  // Includes tendrils for defensive future-proofing (currently bailed on
  // n>500 so never built, but if E4 force-layout ever rebuilds them with
  // ids on userData, the filter just works).
  for (const line of [...this.conflictLines, ...this.sharedTagEdges, ...this.tendrils]) {
    if (!filterActive) {
      line.visible = true;
      continue;
    }
    const ud = line.userData as { aId?: string; bId?: string };
    if (!ud.aId || !ud.bId) {
      // Lines without endpoint IDs (legacy tendrils) — keep visibility unchanged.
      continue;
    }
    line.visible = visibleIds.has(ud.aId) && visibleIds.has(ud.bId);
  }
}
```

### S5 — LivingMap: hoisted adjacency + neighborhood + threading

`ui/src/views/LivingMap/LivingMap.tsx`:

```typescript
// NEW: hoist adjacency build to a single useMemo per [memories, conflicts].
// computeSharedTagPairs runs once per dataset change, NOT per localView change.
const adjacency = useMemo(
  () => buildAdjacency(memories, conflicts),
  [memories, conflicts],
);

// NEW: compute neighborhood when localView is active. Cheap (BFS only,
// <5ms on 1373) so the useMemo dep on filterState.localView is fine.
const localNeighborhood = useMemo(() => {
  if (!filterState.localView) return undefined;
  return computeLocalNeighborhood(
    adjacency,
    filterState.localView.centerId,
    filterState.localView.depth,
  );
}, [adjacency, filterState.localView]);

const visibleIds = useMemo(
  () => deriveVisibleIds(memories, filterState, localNeighborhood?.memoryIds),
  [memories, filterState, localNeighborhood],
);
```

**Esc wire fix — `setLocalView(null)` at convergence point:**
```typescript
const onClickMemory = useCallback((memory: Memory | null) => {
  setSelectedMemory(memory);
  setHoveredMemory(null);
  if (memory === null) {
    // ALL clear paths (Esc key via scene.deselect, esc button, empty-space
    // click via scene.handleClick) terminate here with null. This is the
    // single correct site for the localView-clear-on-deselect coupling.
    setLocalView(null);
  }
}, [setLocalView]);
```

**LivingMapProps additions** (enumerated for typecheck safety):
- `setLocalView: (v: LocalViewState | null) => void`

`filterState.localView` already in `filterState`. Pass `localNeighborhood` to BottomBar for affordance (S8 below).

`App.tsx` adds `setLocalView` with stale-guard:
```typescript
const setLocalView = useCallback((v: LocalViewState | null) => {
  if (v !== null && !memories.some((m) => m.id === v.centerId)) {
    // Stale centerId — silently no-op. UI should never trigger this
    // (memories ref is stable per fetch), but guards against race during
    // a refetch + click in the same tick.
    return;
  }
  setFilterState((prev) => ({ ...prev, localView: v }));
}, [memories]);
```

### S6 — DetailPanel: 3-label focus button + Esc semantics

`LivingMap.tsx DetailPanel`: add a focus button in the existing flex header row (next to the layer dot/label on the left), NOT next to esc (avoids the visual conflation flagged by plan-design-critic):

```tsx
function FocusButton({ memory, localView, setLocalView }: {
  memory: Memory;
  localView: LocalViewState | null;
  setLocalView: (v: LocalViewState | null) => void;
}) {
  const isCenter = localView?.centerId === memory.id;
  const focusActive = localView !== null;
  // Three states:
  //   - no focus active     → "focus"          idle (grey)
  //   - this IS the center  → "focused"        active (rust border+bg)
  //   - focus on a different memory → "recenter here" (rust text only)
  let label: string;
  let style: React.CSSProperties;
  if (isCenter) {
    label = "focused";
    style = { ...focusBtnStyleActive, cursor: "default" };
  } else if (focusActive) {
    label = "recenter here";
    style = focusBtnStyleRecenter;
  } else {
    label = "focus";
    style = focusBtnStyleIdle;
  }
  return (
    <button
      type="button"
      aria-label={
        isCenter ? "This memory is the focused center"
        : focusActive ? "Recenter the focused view on this memory"
        : "Focus the graph on this memory's neighborhood (depth 2)"
      }
      onClick={() => {
        if (isCenter) return;
        setLocalView({ centerId: memory.id, depth: 2 });
      }}
      style={style}
    >
      {label}
    </button>
  );
}

const focusBtnStyleIdle: React.CSSProperties = {
  background: "var(--ink-faint)",
  border: "1px solid var(--glass-border)",
  color: "var(--dim)",
  borderRadius: 4,
  padding: "4px 12px",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  cursor: "pointer",
};
const focusBtnStyleActive: React.CSSProperties = {
  ...focusBtnStyleIdle,
  background: "rgba(196, 92, 60, 0.18)", // alpha 0.18 not 0.10 per critic
  border: "1px solid var(--accent)",
  color: "var(--accent)",
};
const focusBtnStyleRecenter: React.CSSProperties = {
  ...focusBtnStyleIdle,
  background: "transparent",
  border: "1px solid transparent",
  color: "var(--accent)",
};
```

Position in DetailPanel header (LivingMap.tsx ~L70):
```tsx
<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
  <div style={{ width: 8, height: 8, borderRadius: "50%", background: layerColor, boxShadow: `0 0 8px ${layerColor}40` }} />
  <span>{memory.layer}</span>
  <FocusButton memory={memory} localView={filterState.localView} setLocalView={setLocalView} />
</div>
```

(Idle style distinct from existing esc button: focus has border, esc doesn't.)

**Esc semantics — COMMITTED**: single press of Esc (or esc button or click-empty) clears BOTH selectedMemory AND localView. Wire is at `onClickMemory(null)` per S5. Stepped Esc deferred.

### S7 — Tests

NEW `ui/src/engine/localNeighborhood.test.ts`:
- `buildAdjacency` correctness on conflict-only / shared-tag-only / mixed fixtures
- `computeLocalNeighborhood`: centerId not in adjacency → `{memoryIds: Set([centerId]), depthUsed: 0}`
- depth=0 → `{memoryIds: Set([centerId]), depthUsed: 0}`
- depth=1 on 3-node line graph (A-B-C via conflicts), from A → `Set([A,B])`, depthUsed=1
- depth=2 same graph → `Set([A,B,C])`, depthUsed=2
- Triangle via shared tags → from any → `Set([A,B,C])`
- Conflicts + shared-tags compose
- Deterministic (same input → same output)
- depth>=5 internally capped
- **Cap behaviour**: build a star graph with centerId connected to 100 nodes at depth 1 → cap=60 triggers, but wait: depth=1 from center already returns 100. The cap is `>NEIGHBORHOOD_CAP AND depth>1` — at depth=1 we accept the result anyway (no smaller depth to fall back to). Test verifies this corner: depth=1 with 100 neighbors returns all 100, `depthUsed=1`, `cappedFrom` undefined.
- **Cap behaviour 2**: depth=2 yields 80 nodes; cap triggers; falls back to depth=1 which yields 20 nodes; returns `{memoryIds: 20-node set, depthUsed: 1, cappedFrom: {requestedDepth: 2, wouldHaveBeen: 80}}`.
- **Perf**: <5ms BFS at depth=2 on a synthesized 1373-memory + ~3000-edge adjacency. Adjacency build cost NOT counted (hoisted).

Extend `ui/src/state/filterState.test.ts`:
- INITIAL state has `localView === null`
- `isFilterActive` true when only `localView` set
- `resetFilters` clears `localView` (along with other filter fields)
- `deriveVisibleIds` with `localView` set + non-null neighborhood returns intersection
- `deriveVisibleIds` with `localView` set BUT undefined neighborhood silently skips
- `localView` survives `setColorMode` changes (composes — both VIEW state) (Open Q#5)

Extend `ui/src/components/BottomBar.test.tsx`:
- Local view active appends ` · view = local (N)` to affordance string
- Cap-fallback also appends ` (cap fell to depth 1)` indicator

### S8 — BottomBar affordance update (NEW from R1 must-fix)

`ui/src/components/BottomBar.tsx`: extend `EdgeCounts` prop OR add separate `localView` prop. Simpler: add `localView?: { size: number; cappedFrom?: number }` prop.

```typescript
export function buildAffordance(
  colorMode: ColorMode,
  edges: EdgeCounts | undefined,
  localView?: { size: number; cappedFrom?: number },
): string {
  // ... existing parts ...
  if (localView) {
    const note = localView.cappedFrom
      ? `view = local (${localView.size}, capped from ${localView.cappedFrom})`
      : `view = local (${localView.size})`;
    parts.push(note);
  }
  return parts.join(" · ");
}
```

LivingMap passes the `localView` prop to BottomBar derived from `localNeighborhood`:
```typescript
<BottomBar
  // ...existing...
  localView={localNeighborhood ? {
    size: localNeighborhood.memoryIds.size,
    cappedFrom: localNeighborhood.cappedFrom?.wouldHaveBeen,
  } : undefined}
/>
```

### S9 — Neighborhood-size cap behaviour (NEW)

Specified in S2 algorithm + AC. Hard cap = 60 nodes. If depth=2 result exceeds, fall back to depth=1, set `cappedFrom`. BottomBar surfaces. Depth slider for explicit expansion deferred to v0.3.0.

## Acceptance criteria

| # | Criterion | Verifies |
|---|---|---|
| AC1 | Clicking "focus" button when a memory is selected sets `localView = {centerId, depth:2}` and renders only the neighborhood | S5/S6 |
| AC2 | Neighborhood = BFS from center over union of conflict pairs + shared-tag pairs | S2 |
| AC3 | Esc key OR esc button OR click-empty-space ALL clear both selectedMemory AND localView (via onClickMemory(null) convergence) | S5/S6 |
| AC4 | `resetFilters` clears localView (alongside other filter fields) | S1/S5 |
| AC5 | `isFilterActive` returns true when localView is set | S1 |
| AC6 | Conflict + shared-tag + tendril lines visible only when BOTH endpoints in visibleIds (Obsidian default) | S4 |
| AC7 | Lines with one visible + one hidden endpoint are HIDDEN (no frayed half-lines) | S4 |
| AC8 | `computeLocalNeighborhood` BFS <5ms at depth=2 on 1373-memory + 3000-edge synthesized adjacency | S2/S7 perf |
| AC9 | If depth=2 neighborhood > 60 nodes, helper falls back to depth=1 with `cappedFrom` set | S2/S9 |
| AC10 | Focus button has three labels (idle "focus" / center "focused" / non-center w/ active focus "recenter here") with distinct styles | S6 |
| AC11 | BottomBar affordance shows ` · view = local (N)` (or `(N, capped from M)`) when localView active | S8 |
| AC12 | App.tsx `setLocalView` guards stale centerId (no-op when centerId not in memories) | S5 |
| AC13 | E1 + E2 features (color modes, conflict edges, shared-tag edges, BottomBar affordance) STILL work | regression |
| AC14 | No test regressions: full `ui/` + repo-root suites green | regression |

## Risks

| # | Risk | Lik. | Mitigation |
|---|---|---|---|
| R1 | Adjacency build (one-time per memories/conflicts change) too slow | L | computeSharedTagPairs already tested <50ms on 500-fixture; on 1373 expect ~150ms one-shot. Acceptable — not on a hot loop. |
| R2 | Neighborhood-cap fallback to depth-1 confuses users | M | BottomBar `cappedFrom` surfaces the math + names depth-1; affordance is the disambiguation surface |
| R3 | Three-label focus button confuses users (label changes contextually) | M | aria-label provides screen-reader clarity; visual style distinct per state; manual visual smoke verifies |
| R4 | Obsidian both-endpoints-must-be-visible hides edges that connect cluster boundary to off-frame structure | M | This is the established Obsidian convention; users expect it. If a future ticket wants the alt, add a Sidebar toggle in v0.3.0 |
| R5 | Stale centerId still possible if memory deleted AFTER localView set (race) | L | App.tsx setLocalView guards SET-time; for delete-after-set, a useEffect over [memories, localView] can clear localView when centerId no longer present — added to S5 below |

Adding stale-guard useEffect to S5:
```typescript
useEffect(() => {
  if (filterState.localView && !memories.some(m => m.id === filterState.localView!.centerId)) {
    setLocalView(null);
  }
}, [memories, filterState.localView]);
```

## Out of scope (named, deferred)

- **Depth slider (1-3)** — hardcoded depth=2; v0.3.0
- **Stepped Esc** (first clears focus, second clears selection) — single-press dual-clear committed; v0.3.0 if user wants separation
- **Animated zoom-to-cluster** — v0.3.0 polish
- **Breadcrumb history** (drill into a neighbor of a neighbor) — v0.3.0+
- **Sidebar status row** for local view — BottomBar covers orientation; defer the Sidebar duplicate
- **Edge-class toggle in local view** — defer
- **Sidebar empty-state localView-aware variant** — stale guard makes this case unreachable; if it ever fires, generic empty-state is acceptable

## Rollback

Single PR:
- Revert → `localView` field disappears, FocusButton + localNeighborhood + buildAdjacency removed, setFiltered reverts to spheres-only, BottomBar affordance loses local-view clause.
- No DB change; no existing API removed.

## Cost estimate

- Coding: ~5-6 hours (filterState + 2 pure helpers + scene setFiltered extend + FocusButton + setLocalView stale-guard + BottomBar update + tests)
- Critic rounds: ~1-1.5 hours
- Visual smoke: ~30 min
- Total: ~1.5 days (up from v1's ~1d after the 12 must-fix items folded in)

## Resolved open questions (from v1)

1. ~~Frayed-half-line: keep or switch?~~ → **Switch to Obsidian default (both endpoints visible to draw).**
2. ~~Focus button position: header next to esc OR body?~~ → **Header LEFT next to layer label** (distinct from esc on the right; reduces conflation).
3. ~~Default depth=2 too much on hub memories?~~ → **Cap at 60 nodes; fall back to depth-1.** BottomBar surfaces the cap.
4. ~~Esc semantics: dual-clear or stepped?~~ → **Single-press dual-clear committed.** Stepped deferred.
5. ~~localView survives colorMode change?~~ → **Yes, both VIEW state, compose.** Test covers.
