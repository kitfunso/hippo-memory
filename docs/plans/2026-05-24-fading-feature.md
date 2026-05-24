# Plan v2 — single out fading memories (v0.26.1)

**Episode:** `01KSDWH86GBFWPEQWD8TSTK8VQ`
**Date:** 2026-05-24
**Brief:** Keith asked for features to "single out the fading ones." Header
already shows `"8 fading"` in yellow. No way to filter, no visual emphasis
in canvas, no quick-action surface.
**Revision history:** v1 → v2: folds 5 HIGH + 9 MED items from plan-eng R1 (71) + plan-design R1 (82).

## Discovery (verified against running BE)

**"Fading" / at-risk definition** (`src/dashboard.ts:95`, `src/mcp/server.ts:736`):
```
strength < 0.1 AND !pinned
```

(Inconsistency: `src/cli.ts:2541` uses `< 0.2`. Out of scope for v0.26.1 — track for follow-up. UI matches the dashboard.ts/MCP value 0.1.)

**Current DB (Keith's):** `stats.at_risk = 8` of 305 memories. Sample fading memory:
- `strength: 0.087` (just below 0.1)
- `half_life_days: 7` (decays fast)
- `projected_strength_7d: 0.044` → effectively gone in 30d (`0.004`)
- `retrieval_count: 0` (never used)
- `pinned: false`

So fading memories are typically **unused + decaying fast**. The UX needs to help Keith decide whether to **pin** them (rescue) or let them go.

## Brainstorm — 5 UX approaches

### Option A — Filter chip only
Add `fadingOnly: boolean` to FilterState + FilterPanel toggle. Cheap (0.5d). Doesn't visually distinguish though — fading nodes look like other low-strength nodes.

### Option B — Visual emphasis in canvas only
At-risk nodes get a pulsing rust halo regardless of filter. Always visible signal. (1d.) Doesn't help filter to JUST them.

### Option C — Dedicated sidebar panel
New "Fading (8)" panel with the at-risk memory list inline + quick pin actions. Most actionable, takes sidebar real estate. (1.5d.)

### Option D — Clickable header pill
Existing "8 fading" badge becomes a button → toggles fadingOnly filter. Minimal new UI. (0.5d.) Doesn't visually emphasize in canvas either.

### Option E — Multi-touch (A + B + D)
- `fadingOnly: boolean` in FilterState
- Header pill becomes clickable button → toggles filter
- FilterPanel gets toggle row for discoverability
- At-risk nodes always get a subtle rust accent ring in the canvas (no toggle needed — fading IS the visual signal)
- Drawer rows with fading get rust accent text

**Pick: E.** Filter + visual emphasis are complementary. Header pill = discoverability, FilterPanel toggle = mental-model parity with other filters, canvas emphasis = ambient awareness without needing the filter.

## Scope (S1-S6)

### S1 — FilterState extension (~0.1d)

`ui/src/state/filterState.ts`:
- Constant: `export const FADING_STRENGTH_THRESHOLD = 0.1;` (matches BE `src/dashboard.ts:95` + `src/mcp/server.ts:736`)
- Helper: `export function isFading(m: Pick<Memory, "strength" | "pinned">): boolean { return m.strength < FADING_STRENGTH_THRESHOLD && !m.pinned; }` **(eng-critic MED #1: use Pick<Memory> for documented type intent)**
- Add to `FilterState`: `fadingOnly: boolean`
- `INITIAL_FILTER_STATE.fadingOnly = false`
- **`isFilterActive`: add `if (state.fadingOnly) return true;` (eng-critic HIGH #1).** Without this, pill-only activation silently no-ops the entire engine + Sidebar + BottomBar + Drawer + TagCloud filter pipeline because they all gate on `filterActive`.
- `deriveVisibleIds`: skip memories that `!isFading(m)` when `state.fadingOnly` is true

### S2 — App.tsx callback (~0.05d)

- `setFadingOnly(v: boolean)` callback drilled through to LivingMap → Header + FilterPanel.

### S3 — Header clickable pill (~0.2d)

`ui/src/components/Header.tsx`:
- Existing `<span style={{ color: "var(--yellow)" }}>{stats?.at_risk} fading</span>` → wrap in `<button>`.
- **Render only when `at_risk > 0` (design-critic MED empty-state).** Pill disappears when there's nothing fading.
- `onClick` → `setFadingOnly(!filterState.fadingOnly)`.
- `aria-pressed={filterState.fadingOnly}`
- `aria-label` starts with visible text: `"8 fading, click to filter to fading memories only"`
- **Active state matches freeze button pattern (design-critic HIGH #2 + eng-critic LOW #1):** when `fadingOnly === true`, text + border + bg ALL go to rust (`var(--accent)`, `1px solid var(--accent)`, `rgba(196, 92, 60, 0.10)`). Inactive: yellow text, no border, no bg — same as today. Yellow-text-in-rust-border was a mixed signal.
- **Explicit `:focus-visible` outline (eng-critic MED #4):** the global tokens.css `:focus-visible` rule already covers this since the button is a real `<button>`, but ensure no inline `outline: none` strips it.

### S4 — FilterPanel toggle (~0.2d) [v2: placement + props]

`ui/src/components/FilterPanel.tsx`:
- **Position: AFTER Strength, BEFORE Confidence** (both critics MED). Fading is a derived predicate of strength+pinned, so it belongs adjacent to its raw counterpart. Top placement was wrong information hierarchy.
- Filter group label: "Fading only" with caption (small mono subtitle) `< 0.1 strength, unpinned` so users don't wonder why these 8.
- Same `chkRow` style as layer/confidence rows.
- `filterValue` displays `{at_risk} of {total}` when at_risk count available; renders **disabled with `(none)`** when `at_risk === 0` (empty state).
- **Add `stats: Stats | null` prop to FilterPanelProps; drill through Sidebar (eng-critic LOW #3).**
- **When `fadingOnly === true` and `at_risk` drops to 0** (e.g. user pinned the last fading memory), App.tsx auto-clears `fadingOnly` so the user doesn't end up with an empty canvas they can't escape (design-critic MED empty-state).

### S5 — Engine emphasis via TorusGeometry RING (~0.7d) [v2: shape-differentiation + helper coordinator]

**Shape change (design-critic HIGH #1):** Pre-v2 plan said "halo color becomes rust" — but selection halo is ALSO a rust sphere at similar opacity, so 9 rust glows render as "which one is selected?" Solution: fading nodes get a **TorusGeometry ring** (thin circle around the node, oriented to face camera via billboard quaternion), NOT a sphere halo. Shape disambiguates: spheres = layer halo, RINGS = fading status, sphere-pulse = selected.

`ui/src/engine/scene.ts`:
- New `MemoryNode.fadingRing?: THREE.Mesh` field for the optional torus ring.
- In `populate` per-node loop: if `isFading(m)`, construct `new THREE.Mesh(new THREE.RingGeometry(radius * 1.4, radius * 1.7, 32), new THREE.MeshBasicMaterial({ color: COLOR_CONFLICT_HEX, side: THREE.DoubleSide, transparent: true, opacity: 0.5, depthWrite: false }))`. Position copies node position; mesh.lookAt(camera.position) refreshed per frame (cheap — 8 nodes max).
- **Reuse `COLOR_CONFLICT_HEX` (already `0xa04832`)** instead of adding new `COLOR_ACCENT_DIM_HEX` (eng-critic HIGH #3). Conflict edges are LINES, fading rings are RINGS — visually distinct shapes, same "needs attention" rust hue is semantic-coherent.
- Standard halo for fading nodes stays default (don't double-up rust on both halo and ring).
- **New `recomputeHaloAppearance(node)` helper** (eng-critic HIGH #2 + MED #6): single source of truth for halo opacity/color, consults `searchDimmed` + `highlightedIds.has(node.id)`. Called from `populate`, `applyDimming`, hover handlers. Stops the three-paths-overwrite race.
- Fading RING is independent of halo state — ring opacity stays constant at 0.5 regardless of hover/search. Always-visible signal.
- **Per-frame ring orientation:** in `animate()` after particle drift, for each node with a `fadingRing`, set `fadingRing.lookAt(camera.position)`. Cheap (typically 8 nodes); skip if `paused`.
- `dispose()` adds ring cleanup: `for (node of nodes) if (node.fadingRing) node.fadingRing.geometry.dispose() + (node.fadingRing.material as Material).dispose()`.

**Why not pulse?** Design-critic LOW recommended pulse as v0.26.1 inclusion. With the ring-vs-sphere shape differentiation closing HIGH #1, static rings stand out enough. Pulse adds animation budget + prefers-reduced-motion handling. Defer to v0.27 alongside the cleanup epic.

### S6 — Tests + drawer rust dot + StatsPanel cohesion cue (~0.5d) [v2: +0.2d]

**Tests (eng-critic MED #3):**
- `filterState.test.ts`: 
  1. `isFading` true/false on threshold boundaries (0.099 fading, 0.1 not, 0.05 pinned not, 0.05 unpinned yes)
  2. `isFilterActive` returns true when only `fadingOnly` is set, all others default
  3. `fadingOnly` correctly intersects (AND) with other filters (e.g. `fadingOnly + layers={buffer}` returns AND)
  4. Pinned memories with `strength<0.1` NEVER returned when `fadingOnly=true`
- `Header.test.tsx`: clickable pill exists when at_risk > 0 + click invokes `setFadingOnly`; pill does NOT render when at_risk === 0.
- `FilterPanel.test.tsx`: fading toggle visible after Strength group; at_risk=0 renders disabled label.

**Drawer rust dot (design-critic LOW promoted):** drawer rows where `isFading(m)` get a small rust dot inline next to the layer dot. ~15 min add. Closes the "header → canvas → filter panel → drawer" loop so the same memory reads as fading in all 4 surfaces.

**StatsPanel cohesion cue (design-critic MED):** when `fadingOnly === true`, the existing rust "at risk: 8" line in StatsPanel gets a 1px rust border + 4px padding. Ties header pill → stats line → canvas ring → drawer dot into one rust-themed band running down the page. ~5 min.

**Total: ~1.7d** across S1-S6 + critic loops (was 1.3d in v1; +0.4d for ring/helper engine work + promoted drawer dot + StatsPanel cohesion).

## Acceptance gates

- [ ] `npm test`: all green (43 + ~4 new)
- [ ] `npm run build`: clean
- [ ] `node scripts/check-token-drift.mjs`: exits 0
- [ ] Manual: 8 rust-ringed nodes visible in canvas without filter active
- [ ] Manual: click "8 fading" header pill → drawer count drops to 8, canvas hides non-fading, FilterPanel "Fading only" toggle now checked
- [ ] Manual: keyboard `/` to focus search still works; pill is keyboard-reachable via Tab; Enter activates
- [ ] Lighthouse a11y still ≥85 (no regression)

## Risks

| Risk | Mitigation |
|---|---|
| FilterState shape change breaks Sidebar/LivingMap typecheck | Single source of truth; tsc will catch missing fields. |
| Engine halo color change collides with conflict-edge rust (COLOR_CONFLICT_HEX) | Conflict edges are LINES, halos are SPHERES — visually distinct shapes. Same rust hue is consistent across "needs attention" affordances. |
| Header pill visual treatment competes with freeze button (both rust on press) | Pill stays yellow text; only border/bg tint go rust on active state. Freeze button is full-rust. Distinct visual weight. |
| `isFading` threshold drift from BE (0.1 vs 0.2 CLI inconsistency) | Constant in shared filterState.ts; comment names the BE source-of-truth file. v0.27 cleanup: align CLI to 0.1 OR expose threshold via API. |

## Out of scope (deferred)

- Quick-pin action ("pin to refresh" button on fading nodes) — separate UX flow, v0.26.2
- Pulsing animation on fading rings (`prefers-reduced-motion` interaction) — v0.27. Ring-vs-sphere shape differentiation makes pulse unnecessary for v0.26.1.
- CLI threshold alignment (`< 0.2` → `< 0.1` in cli.ts:2548) — separate concern, tracked in v0.27.
- **Expose `at_risk_threshold` via Stats API** so UI doesn't carry a frozen constant (eng-critic MED #5). v0.27 follow-up; for v0.26.1 the comment in filterState.ts naming `src/dashboard.ts:95` as source-of-truth is the mitigation.
- **Migrate App.tsx callback drilling to useReducer/context** (eng-critic LOW #2). With `setFadingOnly` this becomes the 8th setter; v0.27 refactor.

## Sign-off

Pending plan-eng-critic + plan-design-critic R1.
