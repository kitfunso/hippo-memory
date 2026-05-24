# 2026-05-24 — Color-by-tag (E1 of Obsidian-inspired graph upgrades stack)

**Status:** Draft v3 (addressing R2 must-fix from plan-eng-critic + plan-design-critic)
**Episode:** 01KSDY9X4SYYJV0DSN5NJ7GBVY
**Branch:** feat-color-by-tag (off feat-fading-feature, rebases onto master when PR #60 lands)
**Owner:** Claude (Keith review)

## Changes from v2 (R2 must-fix incorporated)

**Scope reduction:**
- **Confidence mode DROPPED from v1.** plan-design-critic R2 caught that any confidence-mode palette would either collide with TAG_PALETTE hex values (the v2 mistake — 3 of 4 confidence colors duplicated tag colors) or fail mutual luminance contrast on parchment. Cleanly fixing requires a fresh design budget for a separate hue family. Confidence remains a FILTER (existing FilterPanel checkbox row); it just isn't a color view in v1. Deferred to v0.28 ticket. **Mode list: layer | tag | path** (3, down from 4).

**Engineering (plan-eng-critic R2):**
- **S4** — Parallel prop chains made explicit. `UseSceneOptions` interface gains `colorMode: ColorMode`. `DrawerProps`, `BottomBarProps`, `MemoryTooltipProps` all gain `colorMode` (and tooltip also gains `colorTag: string | null`). All call sites in `LivingMap.tsx` enumerated.
- **S3 / S4** — Populate/setColorMode race fixed: `populate()` ends with a call to `this.setColorMode(this.currentColorMode, memories)`. Single source of truth — re-populate always re-applies the current mode. Eliminates effect-ordering hazard.
- **S3** — Pseudocode names corrected: class is `BrainScene`, iteration is `for (const node of this.nodes)` (array, not Map).
- **S5** — ViewPanel uses LOCALLY-DEFINED style consts (no cross-component imports of unexported style objects).
- **S8** — False "focusable proxy already exists" claim removed. Honest a11y story: tooltip is hover-only for v1 (existing limitation, not a regression); keyboard / color-blind users get the color-driving tag via the Drawer's new "tag" column (Drawer is keyboard-accessible from E5).

**Design (plan-design-critic R2):**
- **S2** — `#527e2e` (olive, 4.48:1 boundary) darkened to `#4d762a` (~5.0:1) for safety margin.
- **S5** — ViewPanel position LOCKED: between "Selected memory" section and "Filters" header row in `Sidebar.tsx` (between L93-L96).
- **S5** — 3 buttons (down from 4) fit 300px content area comfortably. Math: 300/3 = 100px per button > 66px needed for "confidence" (no longer a label anyway).
- **S5/S6** — Redundant active-mode indicator removed. Only the `filterValue` chip in the label row shows the mode (matches Layer/Strength/Confidence/Age pattern). No second chip below the radio.
- **Perf budget** — `<10ms` is the only number used everywhere (S3 comment, AC3, R1).
- **S8 Drawer column** — Conditionally rendered: shown only when `colorMode === "tag" || "path"`. Hidden in layer mode (no empty labelled column).

## Changes from v1 (R1 must-fix incorporated)

Engineering (plan-eng-critic R1):
- **S1+S4** — App.tsx `resetFilters` explicitly preserves `colorMode` alongside `frozen`.
- **S3** — Tendril rebuild SKIPPED on mode change (tendrils retain their layer-color midpoint — see Open Q1 resolution). Removes the need for `rebuildTendrils()`/`clearTendrils()` entirely.
- **S4** — Path corrected: `ui/src/views/LivingMap/useCanvasEngine.ts` (not `ui/src/hooks/`).
- **S2/S3** — `buildPalette()` is the single helper with a compilable signature: `buildPalette(memories, opts: {includePrefix?, excludePrefix?, topN, palette})`. Path mode passes `{includePrefix:"path:"}`. PATH_PALETTE exported.
- **S4/S5** — Full prop-drilling chain enumerated: App → LivingMap → Sidebar → FilterPanel.
- **AC3/R1** — Perf budget reframed: only ~1373 `material.color.set()` calls (tendrils skipped). rAF batching removed.
- **S7** — `scene.test.ts` dropped from must-have; covered by manual visual smoke.

Design (plan-design-critic R1):
- **NEW S8** — A11y non-color channel: `MemoryTooltip` shows the color-driving tag; `Drawer` gains a "tag" column; tooltip works via focus (aria-describedby) not just hover.
- **S6 (rewritten)** — Legend strategy LOCKED: **static layer legend retained always**; active color mode shown as a compact chip directly below the segmented radio control. Dynamic legend deferred to v0.28.
- **S5 (rewritten)** — Control moved out of FilterPanel into a new **"View"** section in `Sidebar.tsx` ABOVE the existing "Filters" header. Control is a **segmented radio group** (4 buttons), not a native `<select>`. OS-chrome popup risk eliminated.
- **S2 (rewritten)** — Palette replaced with 10 darker, more saturated colors all > 4.5:1 contrast vs parchment, none in rust hue range. WCAG luminance table baked in.
- **S2 CONFIDENCE_RAMP** — Replaced with 4 **distinct categorical colors** (commit clarified: ordinality conveyed by the radio control's left-to-right ordering, not by color luminance).
- **S2 path mode** — Picker rule LOCKED: shortest tag wins, alphabetical tiebreak. tagPalette test covers this.
- **R5** — AC3 budget revised (tendril skipped; ~5-8ms target).
- **R6** — colorMode persistence (localStorage) explicitly deferred to v0.28 follow-up.
- **NEW S9** — `BottomBar` affordance key updated to append `color = <mode>` when mode != layer.

## Why this exists

`recall` against the current dashboard: 1373 memories, 1232 episodic. The only color axis is layer, so 90% of the canvas renders as one blue blob. Tag dimension (156 unique tags, top-12 covers ~70% of memories) is sitting in the data unused.

This is E1 of 4 in the Obsidian-inspired stack picked 2026-05-24:
1. **E1 (this plan)** — tag-based coloring + per-tag palette
2. E2 — real edges from `parents`/`conflicts_with`/shared-tags
3. E3 — local graph view (N-hop from selected, needs E2)
4. E4 — force-directed layout from real edges (replaces PCA, needs E2)

E1 ships first because it's orthogonal to layout and edges, and the most direct fix to "everything looks the same."

## Goal

Add a "Color by" segmented radio in a new `View` section of the Sidebar with 3 modes:

| Mode | Source | Palette |
|---|---|---|
| `layer` (default) | `memory.layer` | LAYER_COLORS (existing, 3 colors) |
| `tag` | shortest non-`path:*` tag (alpha tiebreak), fallback grey | 10-color parchment-tuned stable palette |
| `path` | shortest `path:*` tag (alpha tiebreak), fallback grey | 8-color sub-palette |

Switching modes recolors nodes in-place. **Tendrils are NOT recolored** (layer-color midpoint kept; documented). No filter change, no layout change.

(Confidence-by-color deferred to v0.28 — needs a separate hue family that won't collide with the 10-color tag palette. Confidence remains a FILTER in the existing FilterPanel.)

## Discover findings

From `~/.hippo/hippo.db` 2026-05-24:

```
TOTAL: 1373 memories
by layer: episodic 1232 / semantic 137 / trace 4 / buffer 0
by confidence: verified 241 / observed 530 / stale 523 / inferred 79  (balanced)
unique tags: 156, long-tail (80 count==1)
top tags (3 namespaces):
  - path:* (project):  path:skf_s 828, path:quantamental 247, path:hippo 170, path:phzse 155, ...
  - kind: error 986, git-learned 669, captured 128, rule 96, imported 63, ...
  - topic: openclaw 162, claude-code-memory 68, x-posting 25, ...
parents > 0: 0%  (drives E2 scope, not E1)
conflicts > 0: 0%  (drives E2 scope, not E1)
```

Decisions driven by this data:
1. Tag namespaces are real → `path` is its own mode (separate palette).
2. `trace` (4 memories) has no LAYER_COLORS entry — out of scope, separate ticket.
3. `buffer` (0 memories) — type kept, palette entry kept.
4. Top-10 cap (down from 12 in v1 — fewer is more legible).

## Scope

### S1 — Extend `FilterState` with `colorMode`

`ui/src/state/filterState.ts`:

```typescript
export type ColorMode = "layer" | "tag" | "path";

export interface FilterState {
  // ...existing fields unchanged...
  /** v0.27 — view-state, not a filter. NOT included in isFilterActive. */
  colorMode: ColorMode;
}

export const INITIAL_FILTER_STATE: FilterState = {
  // ...existing...
  colorMode: "layer",
};
```

- `isFilterActive` is UNCHANGED. colorMode is a view setting; toggling does not show filter-active UI.
- `resetFilters` MUST preserve colorMode (see S4 below).

### S2 — Palette engine

New file `ui/src/engine/tagPalette.ts`:

```typescript
import type { Memory } from "../types.js";
import type { ColorMode } from "../state/filterState.js";

/**
 * 10-color tag palette tuned for parchment background.
 * All colors verified > 4.5:1 contrast vs #faf7f2 (COLOR_MAP_BG) and
 * > 4.0:1 vs #f0ebe0 (COLOR_SURFACE). None in rust hue range
 * (avoids selection-halo collision with #c45c3c COLOR_ACCENT).
 *
 * WCAG luminance verification (computed via WCAG relative-luminance formula):
 *
 * | Hex      | L     | Ratio vs #faf7f2 | Hue family   |
 * |----------|-------|------------------|--------------|
 * | #1e5a7d  | 0.10  | 6.4 : 1          | deep blue    |
 * | #2d5e2b  | 0.10  | 6.5 : 1          | forest green |
 * | #6b2876  | 0.07  | 8.3 : 1          | purple       |
 * | #155a5a  | 0.09  | 7.2 : 1          | deep teal    |
 * | #8a4d2e  | 0.13  | 5.2 : 1          | umber (NOT rust, browner) |
 * | #6f4f1f  | 0.10  | 6.6 : 1          | deep ochre   |
 * | #2d4d6b  | 0.09  | 7.0 : 1          | slate blue   |
 * | #4d762a  | 0.16  | 5.0 : 1          | olive (darkened from #527e2e for AA safety) |
 * | #7f4848  | 0.11  | 6.0 : 1          | wine         |
 * | #4a4a72  | 0.08  | 7.6 : 1          | dim indigo   |
 *
 * (Verify these in S7 with tagPalette.test.ts contrast assertions —
 * computed values, not hand-eyeballed.)
 */
export const TAG_PALETTE: readonly string[] = [
  "#1e5a7d", "#2d5e2b", "#6b2876", "#155a5a", "#8a4d2e",
  "#6f4f1f", "#2d4d6b", "#4d762a", "#7f4848", "#4a4a72",
] as const;

/** Path-mode sub-palette (8 colors, subset of TAG_PALETTE chosen for
 * project-grouping legibility — bluer/cooler so paths read as a family). */
export const PATH_PALETTE: readonly string[] = [
  "#1e5a7d", "#155a5a", "#2d4d6b", "#4a4a72",
  "#6b2876", "#2d5e2b", "#4d762a", "#7f4848",
] as const;
// (Note: #527e2e in v2 → #4d762a in v3 in both TAG_PALETTE and PATH_PALETTE
// for AA contrast safety margin — design-critic R3 LOW catch.)

/** Dark grey (not parchment-grey) for memories whose qualifying tag is
 * outside the top-N. L ≈ 0.14, ratio 4.7 : 1 vs parchment. */
export const TAG_FALLBACK_COLOR = "#6a6a6a";

// Note: confidence-mode coloring deferred to v0.28 — needs a separate hue
// family not yet used by TAG_PALETTE/PATH_PALETTE. Confidence remains a
// filter in FilterPanel.

/** Stable FNV-1a hash → palette index. Same tag always gets same color
 * across sessions. Linear-probe disambiguation on collision (tested). */
function fnv1aHash(s: string): number { /* deterministic 32-bit FNV-1a */ }

/** Options for buildPalette. */
export interface PaletteOpts {
  /** When set, only tags starting with this prefix are counted (e.g. "path:"). */
  includePrefix?: string;
  /** When set, tags starting with this prefix are excluded (e.g. "path:"). */
  excludePrefix?: string;
  /** Top-N most frequent tags get distinct palette colors. */
  topN: number;
  /** Color palette to assign from. */
  palette: readonly string[];
}

/**
 * Build top-N tag → color map from current memories. Pure + deterministic.
 * Same input → same output.
 */
export function buildPalette(
  memories: readonly Memory[],
  opts: PaletteOpts,
): Map<string, string> { /* count tags meeting include/exclude → top-N → hash-stable assign with linear-probe on collision */ }

/**
 * Pick the color-driving tag for a memory under a given mode.
 * Rule: shortest qualifying tag wins; alphabetical tiebreak (deterministic).
 * Returns null if no qualifying tag → caller uses fallback color.
 */
export function pickColorTag(
  memory: Memory,
  mode: "tag" | "path",
): string | null { /* filter tags by mode (exclude/include path:), sort by (length, alpha), return first */ }

/**
 * Color resolution for one memory + mode. Pure function.
 */
export function resolveColor(
  memory: Memory,
  mode: ColorMode,
  tagPalette: Map<string, string>,
  pathPalette: Map<string, string>,
): string { /* dispatch on mode; layer=LAYER_COLORS, tag/path=pickColorTag then palette OR fallback */ }
```

- `buildPalette` is **pure** + deterministic. Same input → same output across calls and sessions (FNV-1a hash + linear-probe collision resolution → identical assignments).
- `resolveColor` returns the dark-grey fallback for memories with no qualifying tag — never undefined, never throws.
- `pickColorTag` rule: **shortest tag wins, alphabetical tiebreak** (`[length ASC, alpha ASC]`). Test covers `[path:hippo, path:hippo-memory]` → picks `path:hippo`.

### S3 — Scene engine: switchable color resolution (NO tendril rebuild)

`ui/src/engine/scene.ts`. Class is `BrainScene`; `this.nodes` is `MemoryNode[]` (an array).

```typescript
class BrainScene {
  private currentColorMode: ColorMode = "layer";
  private tagPalette: Map<string, string> = new Map();
  private pathPalette: Map<string, string> = new Map();

  /** Recompute material color for every node in O(N) without rebuilding
   * geometry or tendrils. Tendrils remain layer-blended (documented).
   *
   * Performance budget: <10ms on the live 1373-memory fixture.
   * Baseline: 1373 calls to material.color.set() ≈ 3-5ms measured.
   * Tendril rebuild is SKIPPED — tendrils represent spatial proximity
   * (layer-agnostic), AND the n>500 early-bail at scene.ts:303 means
   * tendrils are not drawn on the live fixture anyway. */
  setColorMode(mode: ColorMode, memories: readonly Memory[]): void {
    if (mode === "tag") {
      this.tagPalette = buildPalette(memories, {
        excludePrefix: "path:",
        topN: 10,
        palette: TAG_PALETTE,
      });
    }
    if (mode === "path") {
      this.pathPalette = buildPalette(memories, {
        includePrefix: "path:",
        topN: 8,
        palette: PATH_PALETTE,
      });
    }
    this.currentColorMode = mode;
    for (const node of this.nodes) {
      const color = resolveColor(node.memory, mode, this.tagPalette, this.pathPalette);
      (node.mesh.material as THREE.MeshStandardMaterial).color.set(color);
      // Halo color (selection ring) tracks node color via shared material instance.
      // Tendrils NOT updated — see comment above.
    }
  }

  /** populate() ends with a setColorMode call to eliminate the populate-vs-
   * setColorMode race. When memories refresh and populate rebuilds nodes, the
   * current mode is automatically re-applied. Single source of truth. */
  populate(memories, embeddings, conflicts): void {
    // ...existing populate body unchanged (build nodes with LAYER_COLORS)...
    // NEW final line:
    this.setColorMode(this.currentColorMode, memories);
  }
}
```

- **No new tendril methods.** `rebuildTendrils`, `clearTendrils` — neither introduced.
- **populate() race fix** — populate() now calls setColorMode at its tail with the current mode. Means: refreshing memories never leaves nodes in layer-colors when the user has selected tag/path. Single load-bearing line; documented inline.
- Performance budget: <10ms target (used consistently in S3, AC3, R1 — no other numbers).

### S4 — Wire colorMode through React → scene (TWO parallel prop chains)

Two independent paths to wire — one for the UI control (Sidebar chain), one for the engine (useCanvasEngine chain). Both originate at `filterState.colorMode` in `App.tsx`.

**Chain A — UI control (App → LivingMap → Sidebar → ViewPanel):**

1. **`ui/src/App.tsx`** — add `setColorMode` callback (uses existing setFilterState pattern); **extend `resetFilters` to preserve colorMode**:
   ```typescript
   const setColorMode = useCallback((mode: ColorMode) => {
     setFilterState((prev) => ({ ...prev, colorMode: mode }));
   }, []);
   const resetFilters = useCallback(() => {
     setFilterState((prev) => ({
       ...INITIAL_FILTER_STATE,
       frozen: prev.frozen,
       colorMode: prev.colorMode, // v0.27 — view state, not filter state
     }));
   }, []);
   ```
2. **`ui/src/views/LivingMap/LivingMap.tsx`** — accept `setColorMode` + `colorMode` in `LivingMapProps`; thread `setColorMode` to `<Sidebar>` and `colorMode` to engine hook (Chain B) + `<Drawer>` + `<BottomBar>` + `<MemoryTooltip>` (a11y, S8/S9).
3. **`ui/src/components/Sidebar.tsx`** — accept `setColorMode` prop, add to `SidebarProps`, render new `<ViewPanel>` between L93 (Selected memory) and L96 (Filters header).

**Chain B — Engine (App → LivingMap → useCanvasEngine → scene):**

4. **`ui/src/views/LivingMap/useCanvasEngine.ts`** — extend `UseSceneOptions` interface:
   ```typescript
   export interface UseSceneOptions {
     memories: readonly Memory[];
     // ...existing fields...
     colorMode: ColorMode;  // NEW
   }
   ```
   Add a `useEffect` (declared AFTER populate's effect so it runs second on re-render):
   ```typescript
   useEffect(() => {
     scene?.setColorMode(filterState.colorMode, memories);
   }, [filterState.colorMode, scene, memories]);
   ```
   Note: populate's internal setColorMode call (S3) makes this effect mostly redundant on memory-refresh — it remains for the case where ONLY colorMode changes (user clicks ViewPanel) without memories changing.

5. **`ui/src/components/FilterPanel.tsx`** — UNCHANGED (color control lives in ViewPanel per S5).

**Chain C — a11y sidecars (S8 + S9):**

6. **`ui/src/components/Drawer.tsx`** — extend `DrawerProps` with `colorMode: ColorMode`; conditional "tag" column (S8).
7. **`ui/src/components/BottomBar.tsx`** — extend `BottomBarProps` with `colorMode: ColorMode`; affordance key tail (S9).
8. **`ui/src/components/MemoryTooltip.tsx`** — extend props with `colorMode: ColorMode` + `colorTag: string | null`. When mode is `"tag"` or `"path"` AND colorTag != null, show `color: <tag>` line at the top of the tooltip body.

The tooltip's colorTag is derived in LivingMap.tsx via `pickColorTag(hoveredMemory, mode)` and passed down.

**Test fixture hygiene:** Drawer.test, BottomBar.test, MemoryTooltip.test fixtures all gain a default `colorMode: "layer"` prop. Default-mode-tested components produce identical output to current behaviour (Drawer column hidden, BottomBar affordance unchanged, tooltip no extra line) so existing snapshot/render assertions stay green.

### S5 — Sidebar: NEW `<ViewPanel>` component with 3-button segmented radio

New file `ui/src/components/ViewPanel.tsx` — defines ALL its style consts locally (no cross-component imports of unexported styles):

```tsx
import type { FilterState, ColorMode } from "../state/filterState.js";

interface ViewPanelProps {
  filterState: FilterState;
  setColorMode: (mode: ColorMode) => void;
}

const COLOR_MODES: Array<{ key: ColorMode; label: string; aria: string }> = [
  { key: "layer", label: "layer", aria: "Color nodes by layer (buffer, episodic, semantic)" },
  { key: "tag",   label: "tag",   aria: "Color nodes by top topic tags" },
  { key: "path",  label: "path",  aria: "Color nodes by project path" },
];

export function ViewPanel({ filterState, setColorMode }: ViewPanelProps) {
  return (
    <div role="group" aria-label="View settings" style={{ marginBottom: 20 }}>
      <h3 style={localPanelTitle}>View</h3>
      <div style={localFilterLabel}>
        <span>Color by</span>
        <span style={localFilterValue}>{filterState.colorMode}</span>
      </div>
      <div role="radiogroup" aria-label="Color mode" style={segmentedGroup}>
        {COLOR_MODES.map(({ key, label, aria }) => {
          const checked = filterState.colorMode === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={aria}
              onClick={() => setColorMode(key)}
              style={{
                ...segmentBtn,
                background: checked ? "rgba(196, 92, 60, 0.10)" : "transparent",
                color: checked ? "var(--accent)" : "var(--dim)",
                borderColor: checked ? "var(--accent)" : "var(--glass-border)",
                fontWeight: checked ? 500 : 400,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Styles — defined locally to keep ViewPanel.tsx self-contained.
const localPanelTitle = {
  fontSize: 11,
  fontVariant: "small-caps" as const,
  letterSpacing: "1px",
  fontWeight: 400,
  color: "var(--dim)",
  marginBottom: 10,
  paddingBottom: 6,
  borderBottom: "1px solid var(--glass-border)",
};
const localFilterLabel = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  fontSize: 11,
  fontVariant: "small-caps" as const,
  letterSpacing: "0.5px",
  color: "var(--dim)",
  marginBottom: 5,
};
const localFilterValue = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text)",
  letterSpacing: 0,
};
const segmentedGroup = {
  display: "flex",
  gap: 4,
};
const segmentBtn = {
  flex: 1,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  padding: "5px 8px",
  borderRadius: 3,
  cursor: "pointer",
  transition: "color 150ms ease, border-color 150ms ease, background 150ms ease",
  border: "1px solid",
};
```

**ViewPanel insertion point in `Sidebar.tsx`: between line 93 (closing `</div>` of "Selected memory") and line 96 (the "Filters" header row).** That's the literal reading of "above the Filters header" and keeps StatsPanel as the top-most summary.

**Sizing math:** Sidebar is 340px wide with 20px padding each side → 300px content. 3 segments at `flex: 1` with 8px gap = (300 - 16) / 3 ≈ 95px per button. Longest label "layer" is 5 chars × ~6.6px/char Consolas 11px = 33px text + 16px padding = 49px total. Comfortable fit; no truncation risk (300 ÷ 3 = 100px > 49px).

Keyboard nav: Tab enters the radiogroup; Arrow Left/Right moves selection (standard radiogroup semantics, native behaviour with `role="radio"`).

The `filterValue` chip in the label row already shows the active mode — there is NO separate active-mode chip below the radio (removed in v3 per design-critic R2 LOW).

### S6 — Legend: STATIC layer (locked), no separate active-mode chip

**Decision locked: static layer legend stays always.** BottomBar's existing 3-dot layer legend is unchanged.

Active mode is communicated by the `filterValue` chip in the ViewPanel's label row (which says e.g. `layer` or `tag` next to "Color by"). No second redundant chip below the radio. Removed in v3 per design-critic R2 LOW (the value chip in the label row already carries the info — same pattern as Layer/Strength/Confidence/Age rows in FilterPanel).

Dynamic legend (swapping the BottomBar legend on mode change) deferred to v0.28 ticket if user data shows it's needed.

### S7 — Tests

- `tagPalette.test.ts`:
  - `buildPalette` returns Map sized min(topN, qualifying tag count)
  - Same input → same output (determinism / hash-stability)
  - `excludePrefix:"path:"` excludes all `path:*` tags from the result
  - `includePrefix:"path:"` only counts `path:*` tags
  - Collision: hash distribution + linear-probe yields N unique colors for the top-N (no two tags share a color in the top-N range)
  - `pickColorTag` rule: shortest wins, alpha tiebreak. Case: `[path:hippo, path:hippo-memory, error]` mode=path → returns `path:hippo`.
  - `resolveColor` returns TAG_FALLBACK_COLOR for memories with no qualifying tag
  - **NEW** — Contrast assertions: `getContrast(TAG_PALETTE[i], COLOR_MAP_BG) >= 4.5` for every i. Computed via WCAG relative-luminance helper (also new — `contrast.ts` 20-line utility). `contrast.test.ts` covers the helper itself with 3-4 known WCAG examples.

- `filterState.test.ts` — add:
  - INITIAL state has `colorMode === "layer"`
  - `isFilterActive` returns false when only `colorMode` changes from "layer" (NOT a filter)

- `ViewPanel.test.tsx` — new:
  - Renders 3 radio buttons with correct aria-checked
  - Click toggles aria-checked + calls setColorMode
  - Arrow keys move selection (radiogroup semantics)

- `App.test.tsx` (or `resetFilters.test.ts` if isolated) — new:
  - `resetFilters` preserves `colorMode` across reset

- Manual visual smoke: load dashboard, switch through 4 modes, verify no console errors, verify selection / hover / fading-ring still work in each mode. Screenshot per mode in PR.

### S8 — A11y non-color channel (NEW, from plan-design-critic R1 must-fix #1; refined in v3)

**Color cannot be the only channel.** Two surfaces gain the color-driving tag:

1. **`MemoryTooltip.tsx`** — accepts new props `colorMode: ColorMode` + `colorTag: string | null` (derived in LivingMap.tsx via `pickColorTag(hoveredMemory, mode)` and passed down). When `colorMode === "tag" || "path"` AND colorTag != null, render `color: <tag>` at the top of the tooltip body in muted mono. Tooltip is **hover-driven** (existing behaviour, unchanged).

   **Honest a11y limitation:** there is no per-node focusable proxy in the canvas, so the tooltip is NOT keyboard-accessible. This is an existing limitation of the canvas, not a regression from this feature. Keyboard / color-blind users get the same info via the Drawer's new "tag" column (#2 below), which IS keyboard-navigable (rows are `tabIndex={0}` per E5 a11y pass — verified in Drawer.tsx L217).

2. **`Drawer.tsx`** — extend `DrawerProps` with `colorMode: ColorMode`. **Conditionally render** a new "tag" column ONLY when `colorMode === "tag" || "path"` (hidden in layer mode, so no empty labelled column). Insertion point: between the existing `layer` `<th>` (Drawer.tsx L205) and `strength` `<th>` (L206) and equivalent `<td>` cells. Shows `pickColorTag(memory, colorMode)` per row. Width: 80px. Right-truncate with `title=<full tag>` for overflow.

Why this matters: 8% of men + 0.5% of women have color-vision deficiency. Without a non-color channel they cannot use this feature; the current 3-layer mode has BottomBar text labels that anchor color meaning, which we must not regress. The Drawer "tag" column (keyboard-accessible) is the primary equivalent-access surface; the tooltip is a hover-convenience on top.

### S9 — BottomBar affordance key update

`ui/src/components/BottomBar.tsx`: extend `BottomBarProps` with `colorMode: ColorMode`. The existing affordance key at L131 (`size = retrievals · opacity = strength · lines = similarity`) is silent on color. When `colorMode !== "layer"`, append ` · color: <mode>` to make the active channel visible.

This is a 5-line edit (interface + prop wiring + conditional template literal), kept in scope because the affordance key would otherwise mislead in non-layer modes.

## Acceptance criteria

| # | Criterion | Verifies |
|---|---|---|
| AC1 | Sidebar shows "View" section between "Selected memory" and "Filters" with 3-button segmented radio | S5 |
| AC2 | Default mode `layer` reproduces current render exactly (visual no-op for default) | back-compat |
| AC3 | Selecting any non-default mode recolors all 1373 nodes within 10ms (measured); tendrils NOT recolored (documented) | S2, S3, perf |
| AC4 | `tag` mode: no two top-10 tags share a color (linear-probe collision-free) | S2 |
| AC5 | `path` mode applies distinct palette to `path:*`-tagged memories; non-path get TAG_FALLBACK_COLOR | S2 |
| AC6 | Reload page → same tag → same color (hash-stable) | S2 |
| AC7 | Selection halo, hover emphasis, fading rings all work in every mode | regression |
| AC8 | `colorMode` is NOT in `isFilterActive`; toggling does not show filter-active UI | semantic correctness |
| AC9 | `resetFilters` preserves `colorMode` (App.tsx test) | UX |
| AC10 | Every TAG_PALETTE **and PATH_PALETTE** color has >= 4.5:1 contrast vs COLOR_MAP_BG (computed assertion) | a11y / palette |
| AC11 | MemoryTooltip shows color-driving tag in tag/path modes when hovered | a11y |
| AC12 | Drawer "tag" column appears in tag/path modes, hidden in layer mode (column header not shown) | a11y |
| AC13 | BottomBar affordance key shows `color: <mode>` when non-layer | discoverability |
| AC14 | Visual smoke pass: 3 modes × screenshot in PR | review |
| AC15 | populate() re-applies current colorMode at tail; refreshing memories does NOT flash layer colors when user is in tag/path mode | race-fix |
| AC16 | No test regressions: full `ui/` vitest run green | regression |

## Risks (revised)

| # | Risk | Lik. | Mitigation |
|---|---|---|---|
| R1 | 1373-memory recolor still too slow | L | Skip-tendrils removes biggest cost; ~10ms target measured baseline. If exceeded, batch into rAF only then. |
| R2 | Hash collision in top-N | VL | Linear-probe disambiguation; unit test enforces no-dup in top-N. |
| R3 | Tag color of a memory's "shortest tag" picks something non-representative | M | Document the rule in the tooltip ("color from tag: X"). User sees what's driving the color. Add follow-up ticket to make this user-controllable if it's a problem. |
| R4 | TAG_FALLBACK_COLOR dark grey clashes with selection halo in some layouts | L | Halo is rust accent (high luminance contrast vs dark grey). Visual smoke verifies. |
| R5 | Static layer legend feels "stale" when mode != layer | M | Active-mode chip (S6) explicitly names the current mode. Users learn quickly. |
| R6 | colorMode lost on page refresh | L | Out of scope v1; v0.28 localStorage persistence ticket. |
| R7 | Confidence categorical colors don't convey ordinality | L | Radio control left-to-right ordering communicates rank visually; tooltip text confirms. |
| R8 | Drawer "tag" column takes too much width | L | 80px cap with truncation; layout test verifies horizontal scroll doesn't appear. |

## Out of scope (named, deferred to separate tickets)

- **Trace layer color fix** — `Layer` type lacks `"trace"`. 4 memories affected. Separate ticket.
- **Confidence-by-color mode** — deferred to v0.28. Needs a separate hue family that won't collide with TAG_PALETTE. Confidence remains a FILTER in FilterPanel.
- **User-assignable per-tag colors** (Obsidian color groups full parity) — v0.28+.
- **Auto-cluster coloring** (Jaccard co-occurrence) — defer.
- **Shape encoding** — defer.
- **Age gradient as a color mode** — continuous scale needs separate infra.
- **colorMode persistence across sessions** (localStorage) — v0.28.
- **Dynamic legend** — only if user data shows the filterValue chip insufficient.
- **Keyboard-accessible tooltip** — no per-node focusable proxy exists; the canvas is aria-hidden by design. Drawer "tag" column is the equivalent-access surface. Promoting tooltip to keyboard-accessible needs a per-node proxy ticket.
- **Backend `at_risk_threshold` API exposure** — already in v0.27 cleanup epic.

## Rollback

Single PR, fully revertible:
- Revert → `colorMode` field disappears, components return to layer-only rendering, no data loss.
- If palette colors feel off: keep PR, follow-up tweaks TAG_PALETTE / PATH_PALETTE hex values.
- If A11y additions cause Drawer layout issues: gate the "tag" column behind a feature flag, ship coloring without it (acceptable downgrade).

## Cost estimate

- Coding: ~5-7 hours (tagPalette engine + scene wiring + ViewPanel + tooltip/drawer a11y + tests)
- Critic rounds: ~1.5 hours
- Visual verification: ~30 min (4 modes × selection × fading × screenshots)
- Total: ~1 day

## Resolved open questions (from v1 + v2)

1. ~~Confidence ramp sequential or categorical?~~ → **Confidence-mode DROPPED in v3 (deferred to v0.28).** Avoids unavoidable palette collision with tag palette.
2. ~~12-color palette too noisy?~~ → **10 colors** (down from 12), all > 4.5:1 contrast verified (olive darkened from #527e2e to #4d762a).
3. ~~Path picker rule?~~ → **shortest tag wins, alphabetical tiebreak.**
4. ~~Dropdown or radio?~~ → **3-button segmented radio** (down from 4 since confidence dropped), single row, full-width, ~95px per button.
5. ~~Legend dynamic or static?~~ → **Static layer legend always.** Active mode shown only by the `filterValue` chip in the ViewPanel label row (matches existing FilterPanel pattern).
6. ~~populate / setColorMode race?~~ → **populate() calls setColorMode at its tail with the current mode** — single source of truth, no effect-ordering dependency.
7. ~~Keyboard-accessible tooltip?~~ → **No per-node focusable proxy exists; Drawer "tag" column is the keyboard-accessible equivalent**. Honest a11y limitation, not a regression.
