# 2026-05-25 — Real edges (E2 of Obsidian-inspired graph upgrades stack)

**Status:** Draft v2 (addressing R1 must-fix from plan-eng-critic + plan-design-critic)
**Episode:** 01KSF6M8NRE3GP3GKNYFVXT056
**Branch:** feat-real-edges (off feat-color-by-tag, rebases when E1 PR #61 lands)
**Owner:** Claude (Keith review)

## Changes from v1 (R1 must-fix incorporated)

Engineering (plan-eng-critic R1, 7 must-fix):
- **S1 rewritten** — `listMemoryConflicts(_, 'all')` would return 0 rows (strict-eq SQL). v2 adds `'*'` sentinel in `store.ts` that skips the WHERE-on-status clause. 4 SQL branches (tenanted × with-status, tenanted × no-status, unscoped × with-status, unscoped × no-status). 6 existing callers (cli/mcp/dashboard/tests) all pass `'open'` or default — unaffected.
- **S1+S5 expanded** — `open_conflicts` stat at dashboard.ts:148 now explicitly filters `c.status === 'open'` after the all-fetch. Test asserts `stats.open_conflicts === 0` on live fixture even when `conflicts.length === 1676`.
- **S4 + AC8 reconciled** — sharedTagEdges teardown disposes BOTH geometry AND material. Pre-existing tendril/conflictLine material-leak deferred to a separate ticket (referenced in Out of scope).
- **S3 tag cap redesigned** — replaced `>50` hard cap with a tiered approach: tags with 50-300 users contribute their top-K=15 most-strongly-connected pairs; tags >300 fully skipped. Captures `openclaw` (162), `claude-code-memory` (68) which v1 silently lost. `error` (986), `git-learned` (669), `path:skf_s` (828), `path:quantamental` (247) still skipped. Note `path:*` tags excluded entirely by `excludePrefix:"path:"` regardless of tier (consistent with v1; project-namespace tags are too broad as a similarity signal).
- **New AC for perf budget** — `computeSharedTagPairs` (extracted helper) must complete in <50ms on a 500-memory fixture, measured via performance.now().
- **AC1 disambiguated** — `/api/conflicts` returns 1676 rows; scene renders ~1117 lines after `!a || !b` filter at scene.ts:407.
- **S6 rewritten** — extract `computeSharedTagPairs` to a pure helper in `ui/src/engine/sharedTagPairs.ts`. Test directly without WebGL stubs. The "no scene tests" framing was wrong; engine tests already exist (E1 added them). Scene class itself remains untested (out of scope for this episode).
- **S1 Conflict-type action removed** — `ui/src/types.ts:26` already has `status: string`.

Design (plan-design-critic R1, 6 must-fix):
- **New token `COLOR_EDGE_HEX = 0x7a6f63`** (warm dark grey, L≈0.16). Distinct from `COLOR_DIM = #9b8e7e` (existing panel-label color, L≈0.27) AND from `TAG_FALLBACK_COLOR = #6a6a6a` (E1 untagged-memory color, L≈0.14). Computed contrast vs parchment `#faf7f2` = **4.58:1** (well above WCAG 3:1 non-text bar). Visual smoke verifies 1px-hairline visibility at 0.26 opacity (composite delta-E ~25 vs parchment; perceptible but below the WCAG 3:1 threshold for *thin* lines — accept as an explicit hairline trade-off rather than overclaim WCAG-compliance).
- **Opacity floor raised** — `0.18 + count * 0.04` (range 0.26 for 2-shared to 0.42 for 6-shared). 2-shared edges now perceptible against parchment per WCAG thin-line contrast.
- **Open vs resolved conflicts** — differentiated by SHAPE not opacity: open uses current dashed (0.3/0.2 dash:gap); resolved uses dotted (0.05/0.15). Score-scaled opacity preserved for strength semantics on both.
- **First-impression UX signal** — when `n > 500` bail triggers, BottomBar shows a faded `· filter to <500 to see tag edges` suffix instead of silently rendering nothing. User has an actionable next step.
- **BottomBar affordance is dynamic** — copy depends on which edge classes actually render (open conflicts > 0? resolved > 0? shared-tag rendered?). Conditional string built per render.
- **Open Q2 resolved** — `COLOR_EDGE_HEX = 0x7a6f63` distinct from both `COLOR_DIM` (#9b8e7e) and `TAG_FALLBACK_COLOR` (#6a6a6a) by hue + luminance. Verified in WCAG luminance table in S3.
- **Open Q1 + Q4 resolved** — keep proximity tendrils as-is (no-op on live fixture); they're the responsibility of E4. Do NOT add a top-N edge cap to the >500 case (would muddle E2 vs E4 split). Instead: when n>500, render nothing AND show the BottomBar hint.

## Why this exists

E1 (color-by-tag, PR #61) addressed the "1232/1373 episodic = blue blob" problem on the color axis. E2 addresses the **edges** axis: today the only edges in the graph are PCA-proximity tendrils (built only when `n <= 500`, so they don't appear on the live fixture at all). Conflict-line infrastructure exists but is starved (0 open conflicts on the live fixture).

E2 of 4 in the Obsidian-inspired stack:
1. E1 color-by-tag (PR #61, awaiting Keith ship gate)
2. **E2 (this plan)** — real edges from shared-tags + already-rendered conflicts surfaced
3. E3 local graph view (N-hop, needs E2 edges)
4. E4 force-directed layout (replaces PCA, needs E2 edges)

## Goal

1. Make conflict edges visible on the live fixture by also exposing **resolved** conflicts (1117 with both memories present; 0 open right now). Differentiate open (dashed) vs resolved (dotted) by shape.
2. Add **shared-tag edges** as a new edge class: pairs of memories sharing ≥2 non-`path:*` tags, rendered as faint warm-grey hairlines.
3. Keep proximity tendrils as-is (n>500 bail = invisible on live fixture; E4 replaces).
4. When n>500 bail triggers, show a BottomBar hint so users know filtering reveals more.

Result: the live fixture gets visibly-edged for the first time (resolved conflicts), with a clear path to richer structure (filter for shared-tag edges).

## Scope reduction from Keith's option-B pick (must read first)

User picked "Shared-tag + BE producer backfill for parents/conflicts" expecting ~3-4d of BE producer changes. Discover overturned that:

- **`parents` data**: 0% populated. `superseded_by` and `dag_parent_id` BOTH 0 across all 1391 memories. No source data exists to backfill. Producer change to start tracking parents going forward would not retroactively populate anything. **Parents skipped entirely.**
- **Conflict producer**: writes correctly. `memory_conflicts` table has 1676 rows; producer healthy. No producer change.
- **Conflict rendering**: `scene.buildConflictLines()` exists, renders rust dashed lines. Data is there but filtered to `'open'` (which returns 0). **One sentinel-add in store.ts** plus a dashboard.ts call change exposes them.
- **Shared-tag edges**: Genuinely new UI surface.

**Net E2 scope: ~1.5d (down from 3-4d).** If Keith wants the parents-producer added as future-tracking-only, that's a separate ticket — not E2 scope.

## Discover data findings

```
memory_conflicts: 1676 rows  (status: 1676 resolved / 0 open)
  - 1117 still have both memories present (rest reference deleted memories)
  - currently rendered: 0 (status='open' filter at dashboard.ts:75)
memories with superseded_by != null: 0 / 1391
memories with dag_parent_id != null: 0 / 1391
memories.kind: 1391 'distilled' (single kind, no DAG)
scene.buildTendrils proximity bail: n > 500 = no render on 1373-fixture
existing engine tests: tagPalette.test.ts, contrast.test.ts (E1); NO scene.test.ts
ui/src/types.ts:26: Conflict.status: string already exposed
src/store.ts:2030: listMemoryConflicts uses WHERE status = ? strict equality
6 existing callers: cli.ts ×4, mcp/server.ts ×2, dashboard.ts ×1 — all pass 'open' or default
```

## Scope

### S1 — BE: add `'*'` sentinel to `listMemoryConflicts`; dashboard uses it

`src/store.ts:2030-2062` — extend `listMemoryConflicts(hippoRoot, status='open', tenantId?)` to treat `status === '*'` as a no-filter sentinel. SQL becomes 4 branches:

```typescript
export function listMemoryConflicts(
  hippoRoot: string,
  status: string = 'open',
  tenantId?: string,
): MemoryConflict[] {
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  const allStatuses = status === '*';
  try {
    let rows: MemoryConflictRow[];
    if (tenantId !== undefined) {
      rows = allStatuses
        ? db.prepare(`
            SELECT mc.id, mc.memory_a_id, mc.memory_b_id, mc.reason, mc.score,
                   mc.status, mc.detected_at, mc.updated_at
            FROM memory_conflicts mc
            JOIN memories ma ON ma.id = mc.memory_a_id
            JOIN memories mb ON mb.id = mc.memory_b_id
            WHERE ma.tenant_id = ? AND mb.tenant_id = ?
            ORDER BY mc.updated_at DESC, mc.id DESC
          `).all(tenantId, tenantId) as MemoryConflictRow[]
        : db.prepare(`
            SELECT mc.id, mc.memory_a_id, mc.memory_b_id, mc.reason, mc.score,
                   mc.status, mc.detected_at, mc.updated_at
            FROM memory_conflicts mc
            JOIN memories ma ON ma.id = mc.memory_a_id
            JOIN memories mb ON mb.id = mc.memory_b_id
            WHERE mc.status = ? AND ma.tenant_id = ? AND mb.tenant_id = ?
            ORDER BY mc.updated_at DESC, mc.id DESC
          `).all(status, tenantId, tenantId) as MemoryConflictRow[];
    } else {
      rows = allStatuses
        ? db.prepare(`
            SELECT id, memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at
            FROM memory_conflicts
            ORDER BY updated_at DESC, id DESC
          `).all() as MemoryConflictRow[]
        : db.prepare(`
            SELECT id, memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at
            FROM memory_conflicts
            WHERE status = ?
            ORDER BY updated_at DESC, id DESC
          `).all(status) as MemoryConflictRow[];
    }
    return rows.map(rowToMemoryConflict);
  } finally {
    closeHippoDb(db);
  }
}
```

Then `src/dashboard.ts:75` changes:
```typescript
const conflicts = listMemoryConflicts(hippoRoot, '*');
```

And `dashboard.ts:148` `open_conflicts` stat preserves its meaning:
```typescript
open_conflicts: conflicts.filter((c) => c.status === 'open').length,
```

Test coverage:
- `tests/store.test.ts` (or new `tests/list-memory-conflicts.test.ts`): with a fixture of mixed-status conflicts, `listMemoryConflicts(root, '*')` returns all rows; `listMemoryConflicts(root, 'open')` returns only open; signature unchanged for existing callers.
- `tests/dashboard.test.ts` (or new): on a fixture with N open + M resolved conflicts, `/api/conflicts` returns N+M rows; `stats.open_conflicts === N`.

`ui/src/types.ts:26` `Conflict.status` already exists — no change.

### S2 — UI: conflict shape encoding (dashed vs dotted) instead of opacity

`ui/src/engine/scene.ts:400-428` `buildConflictLines()`: same score-scaled opacity for both statuses; SHAPE distinguishes:

```typescript
private buildConflictLines(conflicts: Conflict[]): void {
  const nodeMap = new Map<string, MemoryNode>();
  for (const node of this.nodes) nodeMap.set(node.id, node);

  for (const c of conflicts) {
    const a = nodeMap.get(c.memory_a_id);
    const b = nodeMap.get(c.memory_b_id);
    if (!a || !b) continue;

    const mid = new THREE.Vector3().lerpVectors(a.basePosition, b.basePosition, 0.5);
    mid.y += 1;

    const curve = new THREE.QuadraticBezierCurve3(a.basePosition, mid, b.basePosition);
    const points = curve.getPoints(16);
    const geo = new THREE.BufferGeometry().setFromPoints(points);

    const isResolved = c.status === 'resolved';
    const mat = new THREE.LineDashedMaterial({
      color: COLOR_CONFLICT_HEX,
      transparent: true,
      // Same opacity formula for both — opacity = strength, not state.
      opacity: 0.3 + c.score * 0.4,
      // Shape encodes state: open = dashed (visible chunks), resolved = dotted (subtle marks).
      dashSize: isResolved ? 0.05 : 0.3,
      gapSize: isResolved ? 0.15 : 0.2,
      depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    line.computeLineDistances();
    this.scene.add(line);
    this.conflictLines.push(line);
  }
}
```

### S3 — UI: shared-tag edge engine (pure helper + scene wiring)

NEW pure helper `ui/src/engine/sharedTagPairs.ts`:

```typescript
import type { Memory } from "../types.js";

export interface SharedTagPair {
  /** Two memory IDs, deterministic order: a < b. */
  a: string;
  b: string;
  /** How many qualifying tags both memories carry. >=2 by construction. */
  count: number;
}

export interface PairsOpts {
  /** Skip tags whose user count is in [softCap, hardCap): emit only their top-K pairs.
   * Default { softCap: 50, hardCap: 300, perTagTopK: 15 }. */
  softCap?: number;
  hardCap?: number;
  perTagTopK?: number;
  /** Tag-prefix to exclude (e.g. "path:" for too-broad project tags). */
  excludePrefix?: string;
  /** Minimum shared-tag count to emit a pair. Default 2. */
  minShared?: number;
}

/**
 * Compute shared-tag pairs across a set of memories. PURE; testable in
 * isolation. Performance budget: <50ms on a 500-memory fixture (asserted
 * in sharedTagPairs.test.ts).
 *
 * Algorithm:
 * 1. Build tag -> [memory-id] index, filtered by excludePrefix.
 * 2. For each tag with userCount < softCap: enumerate all pairs into
 *    counts map (key = "a|b" with a < b).
 * 3. For each tag with softCap <= userCount < hardCap: emit only the
 *    perTagTopK strongest pairs (by current intersection count). This
 *    preserves signal from medium-cardinality tags like openclaw (162),
 *    claude-code-memory (68), path:luminus-dashboard (75) without the
 *    O(N^2) cost of fully enumerating their pairs.
 * 4. Tags with userCount >= hardCap are skipped entirely (error 986,
 *    path:skf_s 828, git-learned 669, path:quantamental 247).
 * 5. Filter resulting counts by minShared.
 */
export function computeSharedTagPairs(
  memories: readonly Memory[],
  opts: PairsOpts = {},
): SharedTagPair[] { /* impl */ }
```

Scene wiring `ui/src/engine/scene.ts`:

```typescript
private sharedTagEdges: THREE.Line[] = [];
private sharedTagBailed: boolean = false;

private buildSharedTagEdges(memories: Memory[]): void {
  const n = this.nodes.length;
  if (n > 500) {
    // Match existing buildTendrils bail behaviour. UI surfaces this via
    // the BottomBar hint when sharedTagBailed=true.
    this.sharedTagBailed = true;
    return;
  }
  this.sharedTagBailed = false;
  const pairs = computeSharedTagPairs(memories, {
    excludePrefix: "path:",
    softCap: 50,
    hardCap: 300,
    perTagTopK: 15,
    minShared: 2,
  });
  const nodeMap = new Map<string, MemoryNode>();
  for (const node of this.nodes) nodeMap.set(node.id, node);

  for (const p of pairs) {
    if (this.sharedTagEdges.length >= HARD_EDGE_CAP) break; // R5 mitigation
    const a = nodeMap.get(p.a);
    const b = nodeMap.get(p.b);
    if (!a || !b) continue;
    const geo = new THREE.BufferGeometry().setFromPoints([a.basePosition, b.basePosition]);
    const mat = new THREE.LineBasicMaterial({
      color: COLOR_EDGE_HEX,           // new token; see tokens.ts changes
      transparent: true,
      opacity: 0.18 + p.count * 0.04,  // 2-shared = 0.26, 6-shared = 0.42
      depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.sharedTagEdges.push(line);
  }
}

private getSharedTagBailed(): boolean { return this.sharedTagBailed; }

private static readonly HARD_EDGE_CAP = 2000; // pathological-filter mitigation
```

### S4 — Scene populate teardown + tokens.ts

`scene.ts` populate teardown (lines 207-214) extended to dispose **both geometry AND material** on `sharedTagEdges`:

```typescript
for (const line of this.sharedTagEdges) {
  this.scene.remove(line);
  line.geometry.dispose();
  (line.material as THREE.Material).dispose();
}
this.sharedTagEdges = [];
```

**Pre-existing material leak on tendril + conflictLine teardown (lines 207-214 in current code) deferred to a separate ticket** — out of E2 scope per plan-eng-critic R1 reconciliation. Referenced in Out of scope below.

`tokens.ts` adds:
```typescript
// v0.28 — shared-tag edge color. Warm dark grey, distinct from COLOR_DIM
// (panel labels) and TAG_FALLBACK_COLOR (E1 untagged-memory swatch).
export const COLOR_EDGE = '#7a6f63';
export const COLOR_EDGE_HEX = 0x7a6f63;
```

WCAG luminance check (in `tokens.test.ts` or `sharedTagPairs.test.ts`):
- `COLOR_EDGE` `#7a6f63` L≈0.16, ratio vs `#faf7f2` parchment = 4.58 : 1 (above WCAG 3:1 non-text bar for the *swatch*; thin-line composite at 0.26 opacity is sub-WCAG per the trade-off note in Changes-from-v1)
- Distinct from `COLOR_DIM` `#9b8e7e` (L≈0.27, ratio 2.4:1) — used for panel/text dim
- Distinct from `TAG_FALLBACK_COLOR` `#6a6a6a` (L≈0.14, ratio 4.7:1) — used in E1 tag-mode

`scripts/check-token-drift.mjs` should NOT complain (the script flags legacy-dark-token reappearance OUTSIDE tokens.ts; this is a NEW token defined IN tokens.ts).

### S5 — BottomBar: dynamic affordance + bail hint

`ui/src/components/BottomBar.tsx`:

Add two new props:
```typescript
interface BottomBarProps {
  // ...existing...
  /** v0.28 — how many conflict lines + shared-tag edges actually render right
   * now. Drives the dynamic affordance copy. */
  visibleEdgeCounts?: { openConflicts: number; resolvedConflicts: number; sharedTag: number };
  /** v0.28 — when true, BrainScene bailed out of shared-tag edge rendering
   * because nodes > 500. Surfaces an actionable hint to the user. */
  sharedTagBailed?: boolean;
}
```

Dynamic affordance copy:
```typescript
function buildAffordance(
  colorMode: ColorMode,
  edges: { openConflicts: number; resolvedConflicts: number; sharedTag: number } | undefined,
  bailed: boolean,
): string {
  // Base channels always present
  const parts: string[] = ['size = retrievals', 'opacity = strength'];

  // Line channels: list only what actually renders
  const lineKinds: string[] = [];
  if (edges) {
    if (edges.openConflicts > 0) lineKinds.push('conflicts (open)');
    if (edges.resolvedConflicts > 0) lineKinds.push('conflicts (resolved)');
    if (edges.sharedTag > 0) lineKinds.push('shared tags');
  }
  if (lineKinds.length > 0) parts.push(`lines = ${lineKinds.join(' / ')}`);

  // Color channel: E1 carryover
  if (colorMode !== 'layer') parts.push(`color = ${colorMode}`);

  let copy = parts.join(' · ');

  // Bail hint when nothing's drawn but more could be
  if (bailed && (!edges || edges.sharedTag === 0)) {
    copy += ' · filter to <500 for tag edges';
  }
  return copy;
}
```

**Race-free wiring** (per plan-eng-critic R2 MED): `BrainScene.populate()` accepts an optional `onPopulateComplete?: (counts) => void` callback. After `setColorMode` at populate tail, scene invokes the callback synchronously with the result of `getEdgeCounts()`. `useCanvasEngine` exposes a `setEdgeCounts` (or similar) state setter via this callback so React re-renders BottomBar with fresh counts immediately after populate. **No render-time polling** — counts flow through React state, not getter pulls.

Concretely in `useCanvasEngine.ts`:

```typescript
const [edgeCounts, setEdgeCounts] = useState<EdgeCounts>({
  openConflicts: 0, resolvedConflicts: 0, sharedTag: 0, sharedTagBailed: false,
});

useEffect(() => {
  if (!scene || memories.length === 0) return;
  scene.populate(memories, positions, conflicts, (counts) => setEdgeCounts(counts));
}, [memories, embeddings, conflicts]);
```

`useCanvasEngine` returns `edgeCounts` to `LivingMap.tsx`, which threads it as `visibleEdgeCounts` prop to `<BottomBar>`. Single source of truth, no getter polling, no race.

### S6 — Tests

NEW `ui/src/engine/sharedTagPairs.test.ts` (pure helper, no WebGL):
- Pairs computed correctly on a hand-crafted 5-memory fixture
- `excludePrefix:"path:"` skips path tags from the index
- Tags with `userCount < softCap` enumerate all pairs (verify a 5-user tag yields 10 pair-contributions)
- Tags with `softCap <= userCount < hardCap` emit only `perTagTopK` strongest pairs (verify a 60-user tag with K=15 yields exactly 15 pair contributions)
- Tags with `userCount >= hardCap` are fully skipped (verify a 400-user tag yields 0)
- `minShared:2` filters singleton-only pairs
- **PERF AC**: `computeSharedTagPairs` completes in <50ms on a 500-memory fixture with 30 random tags per memory. Measured via `performance.now()` with 3-run average.
- Output is sorted deterministically (by count DESC, then a/b ASC) for stable rendering order.

NEW `tests/store.list-memory-conflicts.test.ts` (or extend an existing store test):
- `listMemoryConflicts(root, 'open')` returns only open (verify with fixture)
- `listMemoryConflicts(root, '*')` returns all rows including resolved
- Existing callers (cli/mcp passing 'open') see no behaviour change
- Tenant-scoped variant works with both '*' and specific status

NEW `tests/dashboard.test.ts` extension (if exists; else manual smoke):
- On a fixture with 3 open + 5 resolved conflicts, `/api/conflicts` returns 8 rows; `stats.open_conflicts === 3`.

Extend `ui/src/components/BottomBar.test.tsx` (new test file — currently no BottomBar tests exist):
- With `visibleEdgeCounts={openConflicts:0, resolvedConflicts:0, sharedTag:0}` and `sharedTagBailed:false`: affordance reads "size = retrievals · opacity = strength" (no line clause).
- With `sharedTag: 50, sharedTagBailed: false`: affordance includes "lines = shared tags".
- With `openConflicts:0, resolvedConflicts:1117, sharedTag:0, sharedTagBailed:true`: affordance includes "lines = conflicts (resolved) · filter to <500 for tag edges".

NO direct scene.test.ts (out of scope; pure helper + UI tests cover the logic). Scene class itself remains untested in v0.28; future v0.29 ticket.

### S7 — Honest manual visual smoke

Spin up dashboard, verify:
- Resolved conflict lines appear as faint rust DOTTED curves
- Open conflicts (when any) appear as DASHED curves at same/similar opacity
- Shared-tag edges appear as warm-grey hairlines when filter shrinks to <500 (filter `path:hippo` ≈170 memories)
- BottomBar copy changes appropriately as filter shrinks/grows
- No regression on E1 color modes

## A11y posture (new section per plan-design-critic R1 must-fix LOW)

- The 3D canvas is `aria-hidden="true"` (set in LivingMap.tsx since E5). Edges are decorative visual structure on the canvas; they are NOT part of the a11y tree.
- Tag relationships are available in the Drawer's "tag" column (E1) and the MemoryTooltip's "color: <tag>" line (E1, when colorMode is tag/path).
- Conflict relationships are not currently surfaced anywhere keyboard-accessible. Future ticket: Drawer column "conflicts with [N]" or detail-panel section. Out of scope for E2.

## Acceptance criteria

| # | Criterion | Verifies |
|---|---|---|
| AC1 | `/api/conflicts` returns 1676 rows on live fixture (all statuses) | S1 BE |
| AC2 | `stats.open_conflicts === 0` on live fixture even when `conflicts.length === 1676` | S1 stat |
| AC3 | `listMemoryConflicts(root, '*')` returns all rows; existing `'open'` callers (cli/mcp) unchanged | S1 store |
| AC4 | Scene renders ~1117 conflict lines (1676 minus pairs whose memory deleted) | S2 scene |
| AC5 | Open conflicts use dashed, resolved use dotted (shape, not opacity, encodes state) | S2 |
| AC6 | Shared-tag edges render on filtered subsets (n<=500) between memories sharing ≥2 non-path tags | S3 |
| AC7 | `computeSharedTagPairs` <50ms on 500-memory fixture (perf assertion in test) | S3 perf |
| AC8 | Tiered cap: tags <50 users enumerate all pairs; 50-300 emit top-15; >=300 skip | S3 |
| AC9 | Shared-tag edges use COLOR_EDGE (distinct from COLOR_DIM and TAG_FALLBACK_COLOR) | S4 token |
| AC10 | Shared-tag edge opacity baseline = 0.26 (count=2), max 0.42 (count=6) | S3 |
| AC11 | Hard cap: shared-tag edges count never exceeds 2000 per scene render | S3 / R5 |
| AC12 | populate teardown disposes sharedTagEdges BOTH geometry AND material | S4 |
| AC13 | BottomBar affordance copy changes dynamically with visible edge counts; never lies | S5 |
| AC14 | When n>500 bails shared-tag rendering AND no shared-tag edges visible, BottomBar shows "filter to <500 for tag edges" hint | S5 |
| AC15 | E1 features (color modes, ViewPanel, Drawer tag column, tooltip color line) STILL work | regression |
| AC16 | No test regressions: full `ui/` + repo-root `npm test` green | regression |

## Risks

| # | Risk | Lik. | Mitigation |
|---|---|---|---|
| R1 | computeSharedTagPairs slower than 50ms on 500-fixture | L | Tiered caps drop the worst-case from O(sum(k²)) to bounded; perf AC enforces. If exceeded: Web Worker (defer to follow-up). |
| R2 | Resolved conflicts saturate the rust channel on filtered subsets | M | Dotted (vs dashed) + score-scaled opacity. If still cluttered post-smoke: add Sidebar toggle (defer to v0.29). |
| R3 | Tiered cap math leaves a gap (e.g. tag with 49 users blocks more meaningful contributions from a 60-user tag) | L | softCap=50 / hardCap=300 / topK=15 are tunable. Pure helper makes A/B trivial. |
| R4 | COLOR_EDGE 0x7a6f63 looks too similar to fading-ring rust under low ambient light | L | Manual smoke verifies. If clash: pick cooler shade (#6a7a8a slate) and update token. |
| R5 | Pathological filter (e.g. 200 memories all sharing tags) renders >2000 edges | L | HARD_EDGE_CAP = 2000 stops the loop. Test exercises this with a synthetic fixture. |
| R6 | Dynamic BottomBar copy churns visibly on filter change | L | The copy is computed in render; React reconciler keeps DOM stable. No animation, no flash. |
| R7 | scene exposing a getter for edge counts adds API surface | L | Single getter `getEdgeCounts()`. Internal to BrainScene→LivingMap; not part of any external contract. |

## Out of scope (named, deferred)

- **`parents` edges** — no source data exists. Adding a producer (supersede-chain tracking) is a separate BE epic; doesn't help E2 ship.
- **Tendril + conflictLine material disposal leak** — pre-existing bug in `scene.populate()` teardown (lines 207-214 dispose geometry only). Separate ticket; E2 fixes it for sharedTagEdges only.
- **Sidebar toggle to hide edge classes** — v0.29 if user feedback demands.
- **Edge-hover tooltip** ("these memories share [error, openclaw]") — needs canvas raycaster for THREE.Line picking. Defer to v0.29.
- **N-hop local view from selected** — E3.
- **Force-directed layout** — E4.
- **Replace proximity tendrils** — keep them no-op on live fixture; E4 replaces.
- **scene.test.ts (direct BrainScene tests)** — needs WebGL stubs; defer to v0.29 ticket.
- **Conflict info in Drawer / MemoryTooltip** — a11y completeness; defer to v0.29.

## Rollback

Single PR (or merge of two if you prefer BE + UI as separate commits):
- Revert → `listMemoryConflicts` sentinel removed (back to `'open'`-only); dashboard returns 0 conflicts; sharedTagEdges field + method removed; BottomBar affordance reverts to static; new COLOR_EDGE token removed.
- No DB migration involved; rollback is safe.
- Existing `'open'` callers in cli/mcp UNAFFECTED throughout (regression test verifies).

## Cost estimate

- Coding: ~4-5 hours (store.ts sentinel + dashboard + sharedTagPairs.ts helper + scene wiring + BottomBar dynamic + tokens.ts + tests)
- Critic rounds: ~1.5-2 hours
- Visual verification: ~30 min
- Total: ~1.5 days

## Resolved open questions (from v1)

1. ~~Keep proximity tendrils alongside shared-tag edges?~~ → **Keep as no-op on live fixture; E4 replaces.** No reason to delete now.
2. ~~`COLOR_DIM_HEX = 0x9b8e7e` distinct from `TAG_FALLBACK_COLOR = #6a6a6a`?~~ → **Replaced with `COLOR_EDGE = #7a6f63` (L≈0.16).** Distinct from both COLOR_DIM (#9b8e7e, L≈0.27) and TAG_FALLBACK_COLOR (#6a6a6a, L≈0.14).
3. ~~`buildSharedTagEdges` respect filtered visible set?~~ → **Build all then let nodeMap.get filter at render time.** E3 may pass a pre-filtered memories arg for efficiency; not blocking for E2.
4. ~~n>500 bail acceptable?~~ → **Yes; BottomBar hint surfaces it actionably.** Hard cap on edge count (HARD_EDGE_CAP=2000) handles the small-fixture pathological case.
