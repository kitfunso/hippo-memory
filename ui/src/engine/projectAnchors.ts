/**
 * v0.29 (E5) — Per-project anchor force computation.
 *
 * Each unique path:* tag is assigned a STABLE position on a circle of
 * radius `LAYOUT_BOUND * 0.6` around origin. Memories carrying that tag
 * get a gentle pull (default strength 0.08) toward the anchor via
 * forceX/forceY in the d3-force simulation.
 *
 * Stability guarantee (AC20, the core E4 R2 fix):
 *   Each tag at persistent index i gets angle `(i * GOLDEN_ANGLE) % 2π`.
 *   The angle depends ONLY on i — not on the total tag count. So adding
 *   a new tag at index N+1 leaves anchors 0..N byte-identical.
 *
 *   GOLDEN_ANGLE = π · (3 − √5) ≈ 137.508°. Vogel sunflower spiral
 *   packing — dense and collision-free for any N up to ~50.
 *
 * Excludes EXCLUDED_PATH_TAGS (currently just path:skf_s, the filesystem
 * root — 60% of memories. Including it would dominate the layout.)
 *
 * Per-memory tag pick uses the shared pickShortestPathTag helper (matches
 * pickColorTag's path-mode rule from E1 tag palette).
 */

import type { Memory } from "../types.js";
import type { ProjectAnchorOrder } from "../state/projectAnchorOrder.js";
import { pickShortestPathTag } from "./tagPalette.js";

/** Filter: which path:* tags are "real projects". Excludes the root
 *  filesystem dir which is not a project. */
const EXCLUDED_PATH_TAGS: ReadonlySet<string> = new Set(["path:skf_s"]);

/**
 * Vogel sunflower spiral angle. `(i * GOLDEN_ANGLE) % (2π)` is the same
 * angle every time for the same i — independent of N. This is what makes
 * AC20 (anchor stability) achievable; v1's slotCount-based angle had to
 * shift every anchor when N grew, reintroducing the E4 R2 mass-resettle.
 */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

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
   *  ONLY includes tags that were actually picked as the anchored tag for
   *  at least one memory (not just "any path tag carried by a memory").
   *  Used by the Sidebar Projects panel. */
  orderedTags: string[];
}

/**
 * Default anchor strength. 0.08 chosen so per-node anchor pull (1 per
 * memory) is less than per-link pull (E4's linkStrength 0.4 × ~3-5 links
 * per node = effective 1.2-2.0). Worst case: memory with 1 link to a
 * different-project cluster + 1 anchor pull → 0.4 vs 0.08 = link wins 5×.
 */
const DEFAULT_ANCHOR_STRENGTH = 0.08;

/**
 * Compute per-project anchor positions on a circle of radius `bound × 0.6`
 * around the origin. Each tag at persistent index `i` is placed at angle
 * `(i × GOLDEN_ANGLE) mod 2π` — stable per i regardless of total tag count.
 *
 * Filters out EXCLUDED_PATH_TAGS.
 *
 * Each memory gets the anchor of its shortest qualifying path tag
 * (alpha tiebreak), via pickShortestPathTag (shared with pickColorTag's
 * "path" branch).
 */
export function computeProjectAnchors(
  memories: readonly Memory[],
  order: ProjectAnchorOrder,
  bound: number,
  anchorStrength: number = DEFAULT_ANCHOR_STRENGTH,
): AnchorLayout {
  const radius = bound * 0.6;
  const TWO_PI = 2 * Math.PI;

  // Build byTag anchor positions via golden-angle packing.
  const byTag = new Map<string, AnchorTarget>();
  for (const [tag, index] of order.indexByTag) {
    if (EXCLUDED_PATH_TAGS.has(tag)) continue;
    const angle = (index * GOLDEN_ANGLE) % TWO_PI;
    byTag.set(tag, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      strength: anchorStrength,
    });
  }

  // Build per-memory lookup AND collect actually-anchored tags for the
  // orderedTags output. Single pass via pickShortestPathTag.
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
  // anchors at path:hippo only; Sidebar won't show a ghost
  // path:hippo-tests row with no visible cluster.
  const orderedTags = [...order.indexByTag.entries()]
    .filter(([tag]) => anchoredTags.has(tag))
    .sort((a, b) => a[1] - b[1])
    .map(([tag]) => tag);

  return { byTag, byMemoryId, orderedTags };
}
