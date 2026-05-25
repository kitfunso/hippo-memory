# 2026-05-25 — Per-project anchor forces (E5 of Obsidian-inspired graph upgrades stack)

**Status:** Draft v2.1 (R2 PASS by both critics; surgical fold-ins applied for last 3 must_fixes)
**Episode:** 01KSFW6KEPY679H2MF4MSDZQ89
**Branch:** feat-project-anchors (off master; E4 already merged)
**Owner:** Claude (Keith review)

## Why this exists

E1-E4 shipped. E4 closes the original Obsidian-inspired stack with d3-force layout driven by E2's structural edges. E5 is the spun-out work from E4's plan iteration: **per-project anchor forces**.

Without anchors, memories cluster by structural connections (conflicts + shared-tag pairs). With anchors, memories ALSO cluster by their project membership — each `path:*` tag gets a stable XZ anchor point, and memories carrying that tag get a gentle pull toward it. The visual result is a true "project-split" view: ~17 distinct regions, one per project, structurally interconnected.

This was the option-3 pick from the project-split question. E4 shipped lean (no anchors) because three anchor-specific HIGH design issues surfaced in E4's R2 critic round:
1. **Sort-index angle assignment** caused mass-resettle on any new project tag (every subsequent anchor shifts → ~1300 memories re-settle)
2. **No in-app legend** — users see clusters with no way to know which is which project
3. **No refresh signaling** — settling clause couldn't distinguish initial-load drift from a new-tag re-drift

E5 addresses all three with proper design budget.

## R1 → v2 changes (critic carry-over)

R1 plan-eng-critic FAILed v1 (2 CRIT, 4 HIGH); R1 plan-design-critic PASSed score 8 with 4 must-fix items. v2 addresses:

**CRIT-1 (eng):** v1's `slotCount = max(1, order.nextIndex)` formula shifted EVERY existing anchor when a new tag arrived — the exact bug E5 was spun out to fix. v2 uses **golden-angle packing**: `angle = (i × GOLDEN_ANGLE) mod 2π` where `GOLDEN_ANGLE = π × (3 − √5)`. Each index has a permanent, unique angle independent of N (Vogel sunflower spiral). Existing anchors are byte-identical pre/post any new-tag addition.

**CRIT-2 (eng):** v1's `sceneRef.current?.getProjectAnchorLayout()` ref-read at React render-time would never re-render on populate. v2 wires explicit React state through `useCanvasEngine`: `useState<AnchorLayout | null>(null)` set in the same effect as `setEdgeCounts`, returned from the hook, destructured by `LivingMap`, fed to Sidebar.

**HIGH-1 (eng):** Hardcoded `bound = 30`. v2 exports `LAYOUT_BOUND` from `forceLayout.ts` and threads it through `scene.populate()` → `computeProjectAnchors` → `ProjectsPanel` mini-SVG.

**HIGH-2 (eng):** `loadProjectAnchorOrder` missing shape validation. v2 adds `if (!Array.isArray(parsed?.tags) || typeof parsed?.nextIndex !== 'number') return EMPTY;` before `new Map(parsed.tags)`.

**HIGH-3 (eng):** Helper duplication. v2 extracts `pickShortestPathTag(tags, excludeSet?)` into `tagPalette.ts` for the path-tag pick path. **v2.1 scope-fix:** the helper is `path:`-prefix-specific (filters `t.startsWith("path:")`). `pickColorTag`'s `"tag"` mode (which EXCLUDES path tags and picks shortest non-path) keeps its inline filter; only the `"path"` branch + `computeProjectAnchors` call the shared helper. Two consumers deduped, not three — but the duplication that mattered (path-tag picking) is gone.

**MED (eng) v2.1 inner-tuple validation:** `new Map([['hello']])` silently produces `key='hello', value=undefined` instead of throwing — golden-angle math then NaN-propagates. v2.1 tightens validation: every entry of `parsed.tags` must be `Array.isArray(t) && t.length === 2 && typeof t[0] === 'string' && typeof t[1] === 'number'` before constructing the Map.

**MED (design) v2.1 focus-visible:** `.project-row:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }` is MORE SPECIFIC than the global `*:focus-visible` rule (2px/2px in tokens.css L67-71) and would DOWNGRADE the focus indicator on these rows. v2.1 drops the override — global rule covers it correctly.

**HIGH-4 (eng) / MED orderedTags:** `orderedTags` listed ANY path tag a memory carries; v2 includes only the actually-anchored tag per memory (matches pickShortestPathTag output).

**HIGH-1 (design):** Aria-label missing on ProjectsPanel buttons. v2 adds `aria-label="Filter to project ${X}, ${count} memories"` + `aria-hidden={true}` on the decorative SVG (matches TagCloud precedent).

**HIGH-2 (design):** SVG mini-map geometry was two inconsistent coordinate systems (viewport 20×20 but radius formula assumed 10×10). v2 fixes to: viewport 20×20, center (10,10), inner radius 5, formula `cx = 10 + (anchor.x / LAYOUT_BOUND) × 5`. Dead `cx/cy = 10` lines removed. Outer stroke = `var(--border)` for visibility.

**MED (design) first-seen order:** Subtitle "(ordered by first-seen)" added under panel title in `--dim` so users aren't surprised by non-alpha order.

**MED (design) center-cluster semantic:** Added to Risks: "Unanchored memories cluster at origin via forceCenter — intentional visual nucleus. Revisit if it dominates."

**MED (eng) reference-stability:** Spec'd in S4 — scene caches `AnchorLayout` on populate, returns same ref until next populate. useMemo in S6 depends on it as a stable ref.

**MED (eng) clearProjectAnchorOrder:** Marked test-only export with a `@internal` doc tag.

**MED (eng) anchor strength rollback:** Risks R3 spells out the visual-smoke failure mode: if clusters jam at anchor centroids with no inter-project edges visible, halve to 0.04.

## Goal

Add per-project anchor forces driven by a **persisted append-only project ordering** (so existing anchors never rotate when new project tags arrive). Provide an in-app **Projects mini-panel** in the Sidebar so users can read which cluster is which. Compose cleanly with E4's settling clause via the existing `initial | refresh` discriminator.

## Discover findings (these drive the plan)

```
Tag distribution (from C:/Users/skf_s/.hippo/hippo.db):
  18 unique path:* tags total
  Top tier (>50 mems):
    path:skf_s             830  ← FILESYSTEM ROOT, not a project (filter out)
    path:quantamental      247
    path:hippo             173
    path:phzse             155
    path:luminus-dashboard  75
    path:mure               55
  Mid tier (10-50): luminus 33, clawd 22, resona 18, production 12, synth 11
  Tail tier (<10): aegis 8, 2chain 5, part-l-hrt-challenge- 4, boring-maths 3
  After filtering skf_s: 17 anchor candidates packed by golden-angle on a circle

Existing UI state:
  No localStorage usage in ui/src — clean slate.
  Sidebar order: StatsPanel → Selected memory → ViewPanel → Filters → TagCloud.
  Room for a "Projects" panel between ViewPanel and Filters.

forceLayout (E4) extension surface:
  ForceLayoutConfig is an interface — cleanly extendable with
    projectAnchors?: Map<string, { x: number; y: number; strength: number }>
  Where the key is a memory ID and the value is its anchor target.
  forceX/forceY accept per-node accessors: `d => projectAnchors.get(d.id)?.x ?? 0`.

ForceNode interface:
  Extendable; no need for a new field (anchors are external-lookup, not per-node).

E4 settling discriminator:
  settlingKindRef.current flips "initial" → "refresh" after first done().
  Anchor changes (new path tag, ordering update) trigger a re-build of
  forceLayout in scene.populate, which fires settling with source="tick" →
  React state updates to "refresh" (correct semantic since the user has
  seen at least one full layout already).
```

## Scope

### S1 — `projectAnchorOrder.ts` persistence helper

NEW file `ui/src/state/projectAnchorOrder.ts`:

```typescript
/**
 * Append-only persisted ordering of project tags. Stable across sessions:
 * once a project gets an index, that index NEVER moves. New project tags
 * get the next-after-max index. Deleted tags retain their slot. This is
 * what prevents the mass-resettle bug E4 R2 caught with sort-index
 * ordering. Combined with golden-angle anchor packing (S2), existing tags'
 * anchor positions are byte-identical pre/post any new-tag addition.
 *
 * STORAGE_KEY versioning: bump to "...:v2" if the persisted schema
 * changes; old v1 keys become orphaned (not migrated) — acceptable since
 * the data is purely UI-state with no canonical value.
 */

const STORAGE_KEY = "hippo:projectAnchorOrder:v1";

export interface ProjectAnchorOrder {
  /** Tag → its persistent index (0-based). Stable across sessions. */
  indexByTag: Map<string, number>;
  /** Highest index assigned. Next new tag gets nextIndex (= maxIndex + 1). */
  nextIndex: number;
}

const EMPTY: ProjectAnchorOrder = { indexByTag: new Map(), nextIndex: 0 };

/**
 * Load from localStorage. Returns empty on first run, parse error, OR
 * shape mismatch (legacy / corrupted / hand-edited payload). Two-layer
 * defense: try/catch for JSON.parse + explicit shape validation before
 * constructing the Map (which would throw on non-iterable `tags`).
 */
export function loadProjectAnchorOrder(): ProjectAnchorOrder {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as unknown;
    // Shape validation BEFORE constructing Map. Defends against:
    //   - hand-edited localStorage (developer tools)
    //   - schema drift from a future v2 left over after a downgrade
    //   - partially-written entries from a prior aborted save
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { tags?: unknown }).tags) ||
      typeof (parsed as { nextIndex?: unknown }).nextIndex !== "number"
    ) {
      return EMPTY;
    }
    const candidateTags = (parsed as { tags: unknown[] }).tags;
    // v2.1: tighten inner-tuple shape check. new Map([['hello']]) does NOT
    // throw — it silently produces {key:'hello', value:undefined} and the
    // undefined index then NaN-propagates through golden-angle math. Reject
    // any entry that isn't exactly [string, number].
    if (
      !candidateTags.every(
        (t): t is [string, number] =>
          Array.isArray(t) &&
          t.length === 2 &&
          typeof t[0] === "string" &&
          typeof t[1] === "number" &&
          Number.isFinite(t[1]),
      )
    ) {
      return EMPTY;
    }
    const valid = parsed as { tags: Array<[string, number]>; nextIndex: number };
    return {
      indexByTag: new Map(valid.tags),
      nextIndex: valid.nextIndex,
    };
  } catch {
    return EMPTY;
  }
}

/** Persist to localStorage. Silent no-op if window/storage unavailable. */
export function saveProjectAnchorOrder(order: ProjectAnchorOrder): void {
  if (typeof window === "undefined") return;
  try {
    const serialized = JSON.stringify({
      tags: [...order.indexByTag.entries()],
      nextIndex: order.nextIndex,
    });
    window.localStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    // localStorage may be full or disabled — silently skip. Layout still
    // works without persistence; new tags get re-assigned per session.
  }
}

/**
 * Reconcile current project tags with the persisted ordering.
 * - Tags already in ordering: keep their existing index.
 * - New tags: assigned nextIndex (alpha-sorted batch order), nextIndex++.
 * - Tags no longer in current set: index retained in ordering but unused.
 *
 * Returns SAME order object reference when nothing changed (reference
 * equality lets caller skip the save call).
 */
export function reconcileProjectOrder(
  currentTags: readonly string[],
  order: ProjectAnchorOrder,
): ProjectAnchorOrder {
  const sortedTags = [...currentTags].sort(); // deterministic add order
  const indexByTag = new Map(order.indexByTag);
  let nextIndex = order.nextIndex;
  let changed = false;
  for (const tag of sortedTags) {
    if (!indexByTag.has(tag)) {
      indexByTag.set(tag, nextIndex);
      nextIndex++;
      changed = true;
    }
  }
  return changed ? { indexByTag, nextIndex } : order;
}

/**
 * @internal Reset for tests / future "reset layout" affordance. Not
 * wired into product code in this episode — exported only so tests can
 * isolate state between runs. v0.3.0 will wire a button.
 */
export function clearProjectAnchorOrder(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}
```

### S2 — `projectAnchors.ts` per-memory anchor computation

NEW file `ui/src/engine/projectAnchors.ts`:

```typescript
import type { Memory } from "../types.js";
import type { ProjectAnchorOrder } from "../state/projectAnchorOrder.js";
import { pickShortestPathTag } from "./tagPalette.js"; // shared helper (HIGH-3 fix)

/** Filter: which path:* tags are "real projects". Excludes the root
 *  filesystem dir which is not a project. */
const EXCLUDED_PATH_TAGS = new Set(["path:skf_s"]);

/**
 * Vogel sunflower spiral packing angle. Each persistent index gets a
 * unique fixed angle 2π · i · (1 - 1/φ) where φ is the golden ratio.
 * Identity: GOLDEN_ANGLE = π · (3 − √5) ≈ 137.508°.
 *
 * Property: angles are dense on the unit circle and never collide.
 * Crucially: the angle for index i depends ONLY on i, not on the total
 * number of anchors. This is what makes E5's stability AC achievable
 * (v1's slotCount-mod formula reintroduced the E4 R2 mass-resettle bug).
 */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export interface AnchorTarget {
  /** Force-layout X (XZ-plane). */
  x: number;
  /** Force-layout Y (maps to scene-Z). */
  y: number;
  /** Pull strength toward this anchor. 0.08 is gentle (vs linkStrength
   *  0.4) so anchors compose with edge-driven clustering without
   *  overwhelming it. See force-balance note below. */
  strength: number;
}

export interface AnchorLayout {
  /** Anchor positions keyed by path tag. */
  byTag: Map<string, AnchorTarget>;
  /** Per-memory anchor lookup (memory.id → anchor target, or undefined
   *  if memory has no qualifying path tag). */
  byMemoryId: Map<string, AnchorTarget>;
  /** The unique path tags considered (in their persistent-index order).
   *  ONLY includes tags that were actually picked as the anchored tag
   *  for at least one memory (not just "any path tag in tag set").
   *  Used by the Sidebar Projects panel. */
  orderedTags: string[];
}

/**
 * Default anchor strength. 0.08 chosen so per-node anchor pull (1 pull
 * per memory) is less than per-link pull (E4's linkStrength 0.4 × ~3-5
 * links per node = effective 1.2-2.0). Worst case: memory with 1 link
 * to a different-project cluster + 1 anchor pull → 0.4 vs 0.08 = link
 * wins 5×. Sum of forces on memory with many anchored neighbors still
 * favors the link cluster.
 */
const DEFAULT_ANCHOR_STRENGTH = 0.08;

/**
 * Compute per-project anchor positions on a circle of radius `bound × 0.6`
 * around the origin. Each tag at persistent index `i` is placed at angle
 * `(i × GOLDEN_ANGLE) mod 2π` — a stable, collision-free packing that
 * depends only on `i`, not on the total tag count.
 *
 * Filters out EXCLUDED_PATH_TAGS (path:skf_s is the filesystem root,
 * 60% of memories — would dominate the layout).
 *
 * Each memory gets the anchor of its shortest qualifying path tag
 * (alpha tiebreak), matching pickColorTag's rule from E1 tag palette
 * via the shared pickShortestPathTag helper.
 */
export function computeProjectAnchors(
  memories: readonly Memory[],
  order: ProjectAnchorOrder,
  bound: number,
  anchorStrength: number = DEFAULT_ANCHOR_STRENGTH,
): AnchorLayout {
  const radius = bound * 0.6;

  // Build byTag anchor positions via golden-angle packing.
  const byTag = new Map<string, AnchorTarget>();
  for (const [tag, index] of order.indexByTag) {
    if (EXCLUDED_PATH_TAGS.has(tag)) continue;
    const angle = (index * GOLDEN_ANGLE) % (2 * Math.PI);
    byTag.set(tag, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      strength: anchorStrength,
    });
  }

  // Build per-memory lookup AND collect actually-anchored tags for the
  // orderedTags output. Single pass via pickShortestPathTag (HIGH-3 fix).
  const byMemoryId = new Map<string, AnchorTarget>();
  const anchoredTags = new Set<string>();
  for (const mem of memories) {
    const tag = pickShortestPathTag(mem.tags, EXCLUDED_PATH_TAGS);
    if (tag === null) continue;
    const anchor = byTag.get(tag);
    if (anchor) {
      byMemoryId.set(mem.id, anchor);
      anchoredTags.add(tag);
    }
  }

  // Sidebar: only tags that ACTUALLY anchor a memory (not "any path tag
  // a memory carries"). Memory tagged [path:hippo, path:hippo-tests]
  // anchors at path:hippo only; the Sidebar won't show a ghost
  // path:hippo-tests row with no visible cluster.
  const orderedTags = [...order.indexByTag.entries()]
    .filter(([tag]) => anchoredTags.has(tag))
    .sort((a, b) => a[1] - b[1])
    .map(([tag]) => tag);

  return { byTag, byMemoryId, orderedTags };
}
```

### S3 — Extend `forceLayout.ts` with `projectAnchors` config + export `LAYOUT_BOUND`

`ui/src/engine/forceLayout.ts`:

```typescript
/**
 * Layout coordinate bound — memories are clamped within ±LAYOUT_BOUND on
 * each axis. Exported so consumers (scene.populate, projectAnchors,
 * ProjectsPanel mini-map) share the same magic number.
 *
 * v0.28: extracted from internal DEFAULTS.bound for shared use.
 */
export const LAYOUT_BOUND = 30;

// In DEFAULTS:
const DEFAULTS = {
  bound: LAYOUT_BOUND, // was hardcoded 30
  // ...
};
```

Add optional `projectAnchors?: Map<string, { x: number; y: number; strength: number }>` to `ForceLayoutConfig`. In factory: if provided, add forceX + forceY accessors:

```typescript
if (config.projectAnchors && config.projectAnchors.size > 0) {
  const anchors = config.projectAnchors;
  simulation
    .force("project-x", d3.forceX<ForceNode>((d) => anchors.get(d.id)?.x ?? 0)
      .strength((d) => anchors.get(d.id)?.strength ?? 0))
    .force("project-y", d3.forceY<ForceNode>((d) => anchors.get(d.id)?.y ?? 0)
      .strength((d) => anchors.get(d.id)?.strength ?? 0));
}
```

Memories without a project anchor get strength=0 (no pull). Memories with one get the configured strength (0.08 default).

### S4 — Scene wiring + tagPalette `pickShortestPathTag` extraction

**`ui/src/engine/tagPalette.ts`** — extract shared helper for path-mode pick (HIGH-3 fix, v2.1-scoped):

```typescript
/**
 * Pick the SHORTEST qualifying path:* tag from a tag list, with alpha
 * tiebreak. **Path-mode only** — does not handle the non-path tag-mode
 * pick (pickColorTag's "tag" branch keeps its own inline filter for
 * those, which excludes path:* tags and is structurally different).
 *
 * Used by:
 *   - pickColorTag's "path" branch (refactored to call this) — no exclusion
 *   - computeProjectAnchors — excludes filesystem-root tags via excludeSet
 */
export function pickShortestPathTag(
  tags: readonly string[],
  excludeSet?: ReadonlySet<string>,
): string | null {
  const qualifying = tags.filter(
    (t) => t.startsWith("path:") && !(excludeSet?.has(t) ?? false),
  );
  if (qualifying.length === 0) return null;
  qualifying.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return qualifying[0] ?? null;
}

// Refactor: pickColorTag's "path" mode branch calls pickShortestPathTag(memory.tags).
// pickColorTag's "tag" mode branch is UNCHANGED — it excludes path:* tags
// and picks shortest non-path tag, which is the structural inverse of
// pickShortestPathTag and not worth a second shared helper for one caller.
```

**`ui/src/engine/scene.ts`**:

```typescript
import { computeProjectAnchors, type AnchorLayout } from "./projectAnchors.js";
import { loadProjectAnchorOrder, saveProjectAnchorOrder, reconcileProjectOrder } from "../state/projectAnchorOrder.js";
import { LAYOUT_BOUND } from "./forceLayout.js";

class BrainScene {
  // Cached per populate; same reference returned by getProjectAnchorLayout
  // until next populate. Lets useMemo in LivingMap (S6) skip rebuilds.
  private projectAnchorLayout: AnchorLayout | null = null;

  populate(memories, positions, conflicts, adjacency) {
    // ... existing setup ...

    const persistedOrder = loadProjectAnchorOrder();
    const allPathTags = new Set<string>();
    for (const m of memories) {
      for (const t of m.tags) if (t.startsWith("path:")) allPathTags.add(t);
    }
    const reconciledOrder = reconcileProjectOrder([...allPathTags], persistedOrder);
    if (reconciledOrder !== persistedOrder) {
      saveProjectAnchorOrder(reconciledOrder); // reference-equality skip
    }
    const projectAnchors = computeProjectAnchors(memories, reconciledOrder, LAYOUT_BOUND);

    this.forceLayout = buildForceLayout(memories, adjacency, seedPositions, {
      projectAnchors: projectAnchors.byMemoryId,
    });

    // Cache for Sidebar consumption. Replaced on next populate; until
    // then, getProjectAnchorLayout() returns this same reference.
    this.projectAnchorLayout = projectAnchors;

    // ... existing tail (setColorMode, etc.) ...
  }

  /**
   * @returns the latest computed AnchorLayout, or null if populate has
   * not yet run. Returns the SAME object reference until the next
   * populate() call — safe to use in React useMemo deps.
   */
  getProjectAnchorLayout(): AnchorLayout | null {
    return this.projectAnchorLayout;
  }
}
```

### S5 — Sidebar Projects mini-panel

NEW file `ui/src/components/ProjectsPanel.tsx`:

```typescript
import { LAYOUT_BOUND } from "../engine/forceLayout.js";

interface ProjectsPanelProps {
  /** Projects ordered by their anchor index (first-seen order). */
  projects: Array<{ tag: string; count: number; anchor: { x: number; y: number } }>;
  /** Click handler: filter memories to that project (sets search query). */
  onSelectProject: (tag: string) => void;
}

const MAX_VISIBLE = 10;

// Mini SVG geometry — single source of truth, no duplicate cx/cy.
const MINI_SIZE = 20;
const MINI_CENTER = MINI_SIZE / 2; // 10
const MINI_RADIUS = 5; // inner ring; dot lives within this on a [-1, +1] scaled coord

export function ProjectsPanel({ projects, onSelectProject }: ProjectsPanelProps) {
  if (projects.length === 0) return null;
  const visible = projects.slice(0, MAX_VISIBLE);
  const hiddenCount = Math.max(0, projects.length - MAX_VISIBLE);

  return (
    <div style={{ marginBottom: 20 }}>
      <h3 style={panelTitle}>Projects</h3>
      <div style={subtitleStyle}>(ordered by first-seen)</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {visible.map(({ tag, count, anchor }) => {
          // Map anchor.x ∈ [-LAYOUT_BOUND, +LAYOUT_BOUND] → screen-x ∈
          // [center - MINI_RADIUS, center + MINI_RADIUS]. Single coordinate
          // system; HIGH-2 dead-code lines removed.
          const dotX = MINI_CENTER + (anchor.x / LAYOUT_BOUND) * MINI_RADIUS;
          const dotY = MINI_CENTER + (anchor.y / LAYOUT_BOUND) * MINI_RADIUS;
          const projectName = tag.replace("path:", "");
          return (
            <button
              key={tag}
              type="button"
              onClick={() => onSelectProject(tag)}
              aria-label={`Filter to project ${projectName}, ${count} memories`}
              className="project-row" // for :hover style in tokens.css
              style={projectRowStyle}
            >
              <svg width={MINI_SIZE} height={MINI_SIZE} aria-hidden={true} style={{ flexShrink: 0 }}>
                <circle
                  cx={MINI_CENTER}
                  cy={MINI_CENTER}
                  r={MINI_RADIUS + 2}
                  fill="none"
                  stroke="var(--border)"
                  strokeWidth={1}
                />
                <circle cx={dotX} cy={dotY} r={2} fill="var(--accent)" />
              </svg>
              <span style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)" }}>
                {projectName}
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--dim)" }}>
                {count}
              </span>
            </button>
          );
        })}
        {hiddenCount > 0 && (
          <div style={hiddenCountStyle}>+{hiddenCount} more</div>
        )}
      </div>
    </div>
  );
}

const panelTitle = {
  fontSize: 11, fontVariant: "small-caps" as const, letterSpacing: "1px",
  fontWeight: 400, color: "var(--dim)", marginBottom: 4, paddingBottom: 6,
  borderBottom: "1px solid var(--glass-border)",
};
const subtitleStyle = {
  fontSize: 9, color: "var(--dim)", marginBottom: 8, fontStyle: "italic" as const,
};
const projectRowStyle = {
  display: "flex", alignItems: "center", gap: 8, padding: "4px 6px",
  background: "transparent", border: "1px solid transparent", borderRadius: 3,
  cursor: "pointer", transition: "background 150ms ease",
  width: "100%", textAlign: "left" as const,
};
const hiddenCountStyle = {
  fontSize: 9, color: "var(--dim)", textAlign: "center" as const, marginTop: 4,
  fontStyle: "italic" as const, opacity: 0.7,
};
```

Add to `ui/src/tokens.css`:

```css
.project-row:hover { background: var(--ink-faint); }
/* v2.1: NO .project-row:focus-visible override — the global *:focus-visible
   rule (tokens.css L67-71, 2px/2px) already covers this. A more-specific
   selector here would DOWNGRADE the focus indicator on these rows vs the
   rest of the app. Sitewide a11y standard wins. */
```

Mount in `Sidebar.tsx` between ViewPanel (L102) and the Filters header — same insertion pattern as E1's ViewPanel.

Click handler: `onSelectProject(tag)` → `setQuery(tag)` (uses existing query filter). User clicks "hippo" → query becomes "path:hippo" → graph filters to hippo memories.

> NOTE (deferred): query input shows raw `path:hippo` (jargon) rather than `project: hippo` chip pill. TagCloud strips `path:` but ProjectsPanel does not — minor consistency drift. v0.3.0 will rewrite query display as a chip pill.

### S6 — LivingMap + useCanvasEngine wiring (the React state path)

**`ui/src/views/LivingMap/useCanvasEngine.ts`** — add explicit state for the anchor layout (CRIT-2 fix):

```typescript
import type { AnchorLayout } from "../../engine/projectAnchors.js";

// In useCanvasEngine body, alongside existing edgeCounts state:
const [projectAnchorLayout, setProjectAnchorLayout] = useState<AnchorLayout | null>(null);

// In the populate effect (currently sets setEdgeCounts):
useEffect(() => {
  const scene = sceneRef.current;
  if (!scene || memories.length === 0) return;
  const positions = projectTo3D(embeddings);
  scene.populate(memories, positions, conflicts, adjacency);
  // Drive React state from scene state — same effect, same render cycle.
  setEdgeCounts(scene.getEdgeCounts());
  setProjectAnchorLayout(scene.getProjectAnchorLayout()); // CRIT-2 wiring
}, [memories, embeddings, conflicts, adjacency]);

// In return:
return {
  containerRef,
  handleMouseMove,
  handleClick,
  handleKeyDown,
  edgeCounts,
  forceSettling,
  projectAnchorLayout, // CRIT-2: surfaced for LivingMap
};
```

**`ui/src/views/LivingMap/LivingMap.tsx`** — destructure + memo:

```typescript
const {
  containerRef,
  handleMouseMove,
  handleClick,
  handleKeyDown,
  edgeCounts,
  forceSettling,
  projectAnchorLayout,   // CRIT-2 wiring
} = useCanvasEngine({...});

// Build the Sidebar projects list with counts. Memoized on memories +
// the anchor-layout reference (which scene caches per populate, so the
// memo only rebuilds when populate fires).
const projectsForSidebar = useMemo(() => {
  if (!projectAnchorLayout) return [];
  const counts = new Map<string, number>();
  for (const m of memories) {
    for (const t of m.tags) {
      if (projectAnchorLayout.byTag.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return projectAnchorLayout.orderedTags.map((tag) => ({
    tag,
    count: counts.get(tag) ?? 0,
    anchor: projectAnchorLayout.byTag.get(tag)!,
  }));
}, [memories, projectAnchorLayout]);
```

Pass `projects={projectsForSidebar}` + `onSelectProject={setQuery}` to Sidebar → ProjectsPanel.

### S7 — Tests

NEW `ui/src/state/projectAnchorOrder.test.ts`:
- `loadProjectAnchorOrder` returns empty when localStorage empty / unavailable.
- `loadProjectAnchorOrder` returns empty when value is non-JSON (parse throw).
- `loadProjectAnchorOrder` returns empty when JSON shape is invalid (no `tags` array OR no `nextIndex` number) — **HIGH-2 fix coverage**.
- `loadProjectAnchorOrder` returns empty when `tags` is present but non-iterable (e.g. `tags: "hello"`).
- `loadProjectAnchorOrder` returns empty when `tags` is an array of NON-tuples (`[["hello"], ["world"]]`, `[[1,2]]`, `[["x", "y"]]`) — **v2.1 inner-tuple validation coverage**; without this, `new Map(...)` silently produces `{key:'hello', value:undefined}` and NaN-propagates through golden-angle math.
- `saveProjectAnchorOrder` round-trips: save → load → equal.
- `saveProjectAnchorOrder` silent-skips when localStorage throws (QuotaExceededError).
- `reconcileProjectOrder` appends new tags with next index.
- `reconcileProjectOrder` keeps existing tags' indices stable.
- `reconcileProjectOrder` returns SAME object reference when no change (reference-equality skip-save).
- `reconcileProjectOrder` with deleted tags: index retained in ordering, slot left empty.

NEW `ui/src/engine/projectAnchors.test.ts`:
- `computeProjectAnchors` filters `path:skf_s`.
- Each anchor at `(cos(i × GOLDEN_ANGLE) × radius, sin(i × GOLDEN_ANGLE) × radius)` where `radius = LAYOUT_BOUND × 0.6` — golden-angle formula.
- Memories with no qualifying path tag → not in `byMemoryId`.
- Memories with multiple path tags → shortest-wins (alpha tiebreak) via shared `pickShortestPathTag`.
- `orderedTags` returns tags in persistent-index order.
- `orderedTags` excludes tags NOT picked as the anchored tag for any memory — **HIGH-4 fix coverage** (memory with [path:hippo, path:hippo-tests] → only path:hippo in orderedTags).
- **AC14 explicit byte-identical test:** Setup with 3 indices → record positions. Add 4th index → re-compute. Existing 3 positions equal to JS strict `===` (or `toBe` in vitest) byte-identically. The test that v1 would have FAILED.

NEW `ui/src/engine/tagPalette.test.ts` extensions (or existing file):
- `pickShortestPathTag` returns null for empty / no-path-tags input.
- `pickShortestPathTag` ignores tags in excludeSet.
- `pickShortestPathTag` picks shortest, alpha tiebreak.
- `pickColorTag` (post-refactor) still passes pre-existing tests.

Extend `ui/src/engine/forceLayout.test.ts`:
- `buildForceLayout` with `projectAnchors` config: forceX/forceY active per node.
- Without `projectAnchors`: no project forces added (back-compat).
- Settled positions for an anchored memory cluster near its anchor.
- `LAYOUT_BOUND` export equals 30.

NEW `ui/src/components/ProjectsPanel.test.tsx`:
- Renders top-N projects in order.
- Renders subtitle "(ordered by first-seen)".
- Each button has aria-label matching `Filter to project X, N memories` — **design HIGH-1 fix coverage**.
- Each SVG has `aria-hidden="true"`.
- SVG dot position computes from `anchor.x / LAYOUT_BOUND × MINI_RADIUS + MINI_CENTER` — **design HIGH-2 fix coverage**.
- Click fires onSelectProject with the tag string.
- "+N more" affordance when projects.length > 10.
- Returns null on empty projects.

### S8 — Anchor stability AC (the core E4 R2 fix, now verifiable)

```
Test: stability across tag-set growth (golden-angle invariant).
  Setup: 3 memories with tags [path:hippo], [path:quantamental], [path:phzse].
  Reconcile order → indices {hippo:0, quantamental:1, phzse:2}, nextIndex=3.
  Run computeProjectAnchors → record anchors{hippo:A, quantamental:B, phzse:C}.
  Add memory with new tag [path:resona].
  Reconcile → indices {hippo:0, quantamental:1, phzse:2, resona:3}, nextIndex=4.
  Run computeProjectAnchors → anchors{hippo:A', quantamental:B', phzse:C', resona:D}.
  Assert A === A', B === B', C === C' (byte-identical via strict equality
  on .x and .y for each).
  Why this passes now: golden-angle formula uses ONLY i, not slotCount.
  Why v1 FAILed it: slotCount-mod formula shifted every existing index
  when slotCount grew from 3 to 4.
```

## Acceptance criteria

| # | Criterion | Verifies |
|---|---|---|
| AC1 | `projectAnchorOrder.ts` round-trips through localStorage | S1 |
| AC2 | `reconcileProjectOrder` appends new tags with next-index | S1 |
| AC3 | `reconcileProjectOrder` keeps existing tags' indices stable | S1 / S8 stability |
| AC4 | `reconcileProjectOrder` returns same-reference when no change | S1 perf-skip |
| AC5 | `loadProjectAnchorOrder` returns empty on shape mismatch (no `tags` array OR no `nextIndex` number OR any entry not a `[string, number]` tuple) | S1 / HIGH-2 + v2.1 inner-tuple |
| AC6 | `computeProjectAnchors` filters `path:skf_s` | S2 |
| AC7 | Anchor positions at `(cos(i × GOLDEN_ANGLE) × r, sin(i × GOLDEN_ANGLE) × r)` where r = `LAYOUT_BOUND × 0.6` | S2 / CRIT-1 |
| AC8 | Memories pick shortest path tag (alpha tiebreak) via shared `pickShortestPathTag` — path-mode dedup only; `pickColorTag`'s "tag" branch keeps its inline non-path filter | S2 + S4 / HIGH-3 (v2.1 scoped) |
| AC9 | `orderedTags` includes ONLY tags actually picked as anchored tag for ≥1 memory | S2 / HIGH-4 |
| AC10 | `buildForceLayout` with projectAnchors config adds forceX/forceY | S3 |
| AC11 | Without projectAnchors config: no project forces (back-compat) | S3 |
| AC12 | `LAYOUT_BOUND` exported from forceLayout.ts and consumed by scene + ProjectsPanel | S3 / HIGH-1 |
| AC13 | Scene populate persists order changes to localStorage | S4 |
| AC14 | Scene `getProjectAnchorLayout()` returns same reference until next populate | S4 / MED ref-stability |
| AC15 | useCanvasEngine returns `projectAnchorLayout` from React state set in populate effect | S6 / CRIT-2 |
| AC16 | ProjectsPanel renders top-10 + "+N more" + subtitle "(ordered by first-seen)" | S5 / design MED |
| AC17 | ProjectsPanel buttons have aria-label `Filter to project X, N memories`; SVG `aria-hidden="true"` | S5 / design HIGH-1 |
| AC18 | ProjectsPanel SVG dot position: `MINI_CENTER + (anchor.x / LAYOUT_BOUND) × MINI_RADIUS` (single coord system) | S5 / design HIGH-2 |
| AC19 | Click on a project row sets query to the path tag | S5/S6 |
| AC20 | **Anchor stability (core)**: adding a new project tag → existing anchors' .x/.y byte-identical pre/post | S8 / CRIT-1 |
| AC21 | E1-E4 features still work (color modes, edges, local view, force layout, BottomBar) | regression |
| AC22 | No test regressions: full ui/ + repo-root green | regression |

## Risks

| # | Risk | Lik. | Mitigation |
|---|---|---|---|
| R1 | localStorage QuotaExceededError on save | L | try/catch silent skip; layout still works without persistence (anchors stay session-local) |
| R2 | localStorage disabled (private browsing) | L | `loadProjectAnchorOrder` returns empty; new tags get re-assigned per session |
| R3 | Anchor strength 0.08 too strong / weak | M | Tunable in config. **Failure mode (visual smoke):** if 17-project clusters collapse to anchor centroids with no inter-project edges visible, halve to 0.04 and re-test. **Worst-case force balance:** a node with 1 cross-project link (0.4 strength) + 1 anchor pull (0.08) → link wins 5×. Sum of edge forces dominates anchor sum for any node with ≥1 inter-project edge. |
| R4 | Sidebar Projects mini-map too small / cluttered | L | 20×20 SVG with stroke `var(--border)` for visible ring; 2-radius dot. Visual smoke; bump to 32×32 if dot lost. |
| R5 | Project ordering becomes stale after long sessions (many deleted+added projects → high nextIndex, sparse-feeling list) | L | Golden-angle packing keeps anchors well-distributed regardless of N. List sparseness is purely cosmetic. v0.3.0 "reset layout" button (helper `clearProjectAnchorOrder` already exists as `@internal` test-only export). |
| R6 | path:skf_s exclusion list grows over time | L | Single exclusion for now (filesystem root). If more "non-project" path tags surface (e.g. path:tmp), add to EXCLUDED_PATH_TAGS — single source of truth. |
| R7 | reconcileProjectOrder sort-by-alpha for new tags is deterministic per session, NOT cross-user | L | Documented in S1 docstring. Each user's local indices are stable; cross-session anchor sync deferred indefinitely. |
| R8 | **Unanchored memories cluster at origin** (path:skf_s + memories with no path tag → ~870 memories pulled to (0,0) by forceCenter) | L | **Design choice (M4):** intentional visual nucleus — the un-projected core sits at the center surrounded by project rings. If it dominates the canvas visually (smoke test reveals a giant blob), follow-up: assign a low-strength "general" anchor at a quiet angle, or filter unanchored memories from layout entirely. |
| R9 | Plan-design first-seen-order surprise (Sidebar list not alpha / by-count) | L | Subtitle "(ordered by first-seen)" makes the rule explicit. |

## Out of scope (named, deferred)

- "Reset layout" affordance button to clear localStorage ordering — v0.3.0 polish. Helper `clearProjectAnchorOrder` exported as `@internal` test-only; wiring is the deferred work.
- Per-project color customization in the Sidebar legend — separate v0.3.0+ ticket.
- Drag-to-rearrange projects on the canvas — defer.
- BottomBar `anchors: N` clause — Sidebar mini-panel covers orientation; defer BottomBar update.
- Animated transition when a new anchor appears — defer.
- Sidebar mini-map showing actual cluster positions (rather than just anchor angles) — defer.
- Cross-session anchor sync (cloud-persisted ordering) — defer indefinitely.
- Hover-preview of project's spheres on Sidebar-row hover (highlight in canvas) — defer v0.3.0+.
- Query input rewrite to `project: X` chip pill (instead of raw `path:X` text) — defer v0.3.0+.

## Rollback

Single PR, revertible:
- Revert → `projectAnchorOrder.ts` + `projectAnchors.ts` + `ProjectsPanel.tsx` + tests deleted; `scene.populate` stops computing anchors; `buildForceLayout`'s `projectAnchors` path becomes dead code (optional config; never set); Sidebar drops ProjectsPanel mount; `LAYOUT_BOUND` export remains harmless. `pickShortestPathTag` extraction stays (cleanup, not a regression). localStorage key remains (harmless residue).
- No DB change; no API contract change.

## Cost estimate

- Coding: ~5-7 hours (2 new helpers + 1 new component + scene wiring + tagPalette refactor + tests + tuning)
- Critic rounds: ~1-2 hours (E5 R1 surfaced 2 CRIT + 6 HIGH addressed in v2; R2 should converge)
- Visual smoke: ~30 min
- Total: ~1 day

## Open questions for R2 critics

1. **Golden-angle vs fixed-modulus** — golden-angle gives stable per-index angles + maximal distribution (Vogel sunflower). Alternative: `slotCount = 64` fixed modulus (gives integer fractions, easier to reason about visually). Golden-angle picked because stability is the AC and packing is dense for any N up to ~50 indices. Flag if a fixed modulus is preferred for visual reasoning.

2. **Sidebar Projects panel position** — between ViewPanel and Filters (matches E1's ViewPanel insertion pattern). Alternative: above ViewPanel (more prominent). Plan picks between-ViewPanel-and-Filters; flag if wrong.

3. **`path:skf_s` filter** — hard-coded EXCLUDED_PATH_TAGS list. Alternative: heuristic (skip path tags carrying >50% of memories). Hard-coded simpler; revisit if other "root" tags surface.

4. **Click handler `setQuery(tag)`** — uses existing free-text query filter. The raw `path:X` query-text drift is acknowledged + deferred to v0.3.0 chip-pill rewrite. Flag if a dedicated "active project" state is preferred for v1.

5. **`pickShortestPathTag` location** — extracted into `tagPalette.ts` alongside `pickColorTag` (which now calls it). Alternative: dedicated `tagHelpers.ts` module. Picked tagPalette because the helper is currently used by exactly two consumers (pickColorTag + computeProjectAnchors), both in `engine/`.
