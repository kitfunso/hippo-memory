/**
 * v0.27 color-by-tag — palette engine for the dashboard graph.
 *
 * Three palettes:
 *   - TAG_PALETTE (10 colors) for "color by tag" mode (excludes path:* tags)
 *   - PATH_PALETTE (8 colors)  for "color by path" mode (only path:* tags)
 *   - TAG_FALLBACK_COLOR for any memory whose qualifying tag is outside
 *     the top-N for the active mode
 *
 * All hex values verified > 4.5:1 contrast vs COLOR_MAP_BG (#faf7f2) per
 * WCAG (see contrast.ts). None in the rust hue range (avoids selection
 * halo COLOR_ACCENT collision).
 *
 * Tag selection rule: shortest qualifying tag wins; alphabetical tiebreak.
 * Stable across sessions via FNV-1a hash with linear-probe collision
 * resolution into the palette.
 */

import type { Memory } from "../types.js";
import type { ColorMode } from "../state/filterState.js";
import { LAYER_COLORS } from "./types.js";

/**
 * 10-color tag palette tuned for parchment background.
 * WCAG luminance table (see contrast.test.ts for runtime assertions):
 *
 * | hex      | L     | Ratio vs #faf7f2 |
 * |----------|-------|------------------|
 * | #1e5a7d  | 0.10  | 6.4 : 1          |
 * | #2d5e2b  | 0.10  | 6.5 : 1          |
 * | #6b2876  | 0.07  | 8.3 : 1          |
 * | #155a5a  | 0.09  | 7.2 : 1          |
 * | #8a4d2e  | 0.13  | 5.2 : 1          |
 * | #6f4f1f  | 0.10  | 6.6 : 1          |
 * | #2d4d6b  | 0.09  | 7.0 : 1          |
 * | #4d762a  | 0.16  | 5.0 : 1          | (darkened from #527e2e for AA safety)
 * | #7f4848  | 0.11  | 6.0 : 1          |
 * | #4a4a72  | 0.08  | 7.6 : 1          |
 */
export const TAG_PALETTE: readonly string[] = [
  "#1e5a7d", "#2d5e2b", "#6b2876", "#155a5a", "#8a4d2e",
  "#6f4f1f", "#2d4d6b", "#4d762a", "#7f4848", "#4a4a72",
] as const;

/** Path-mode sub-palette — 8 colors chosen for project-grouping legibility
 * (bluer/cooler bias so projects read as a family). Subset of TAG_PALETTE
 * to keep contrast assertions trivially covered. */
export const PATH_PALETTE: readonly string[] = [
  "#1e5a7d", "#155a5a", "#2d4d6b", "#4a4a72",
  "#6b2876", "#2d5e2b", "#4d762a", "#7f4848",
] as const;

/** Dark grey (not parchment-grey) for memories whose qualifying tag is
 * outside the top-N. L = 0.14, ratio 4.7 : 1 vs parchment. */
export const TAG_FALLBACK_COLOR = "#6a6a6a";

const PATH_PREFIX = "path:";

/** FNV-1a 32-bit hash. Pure + deterministic; identical across sessions. */
function fnv1aHash(s: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    // 32-bit multiply via shifts; mask to keep within u32.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

export interface PaletteOpts {
  /** When set, only tags starting with this prefix are counted (e.g. "path:"). */
  includePrefix?: string;
  /** When set, tags starting with this prefix are excluded (e.g. "path:"). */
  excludePrefix?: string;
  /** Top-N most frequent qualifying tags get distinct palette colors. */
  topN: number;
  /** Color palette to assign from. Tags beyond palette.length get linear-probed. */
  palette: readonly string[];
}

/**
 * Build a tag → color map from the current memories.
 *
 * - Counts how many memories carry each qualifying tag.
 * - Picks the top-N tags (sorted by count DESC, alpha ASC for stability).
 * - Hash-stable assignment: tag hash modulo palette length, linear-probe
 *   into the next free slot on collision. Same tag → same color across
 *   sessions (only depends on FNV-1a hash + palette ordering).
 *
 * Pure + deterministic. Returns at most min(topN, palette.length) entries.
 */
export function buildPalette(
  memories: readonly Memory[],
  opts: PaletteOpts,
): Map<string, string> {
  const { includePrefix, excludePrefix, topN, palette } = opts;
  const cap = Math.min(topN, palette.length);

  // Count qualifying tags
  const counts = new Map<string, number>();
  for (const mem of memories) {
    for (const tag of mem.tags) {
      if (includePrefix !== undefined && !tag.startsWith(includePrefix)) continue;
      if (excludePrefix !== undefined && tag.startsWith(excludePrefix)) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  // Pick top-N: count DESC, alpha ASC (stable tiebreak)
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, cap)
    .map(([tag]) => tag);

  // Hash-stable color assignment with linear-probe collision resolution
  const result = new Map<string, string>();
  const usedSlots = new Set<number>();
  for (const tag of ranked) {
    const start = fnv1aHash(tag) % palette.length;
    let slot = start;
    while (usedSlots.has(slot)) {
      slot = (slot + 1) % palette.length;
      if (slot === start) break; // palette full (shouldn't happen at cap == palette.length)
    }
    usedSlots.add(slot);
    result.set(tag, palette[slot]!);
  }
  return result;
}

/**
 * v0.29 (E5 HIGH-3) — Pick the SHORTEST qualifying path:* tag from a tag
 * list, with alpha tiebreak. **Path-mode only** — does not handle the
 * non-path tag-mode pick (pickColorTag's "tag" branch keeps its own inline
 * filter for those, which excludes path:* tags and is structurally
 * different from a "pick from prefix" rule).
 *
 * Used by:
 *   - pickColorTag's "path" branch (refactored to call this) — no exclusion
 *   - computeProjectAnchors (projectAnchors.ts) — excludes filesystem-root
 *     tags via excludeSet
 */
export function pickShortestPathTag(
  tags: readonly string[],
  excludeSet?: ReadonlySet<string>,
): string | null {
  const qualifying = tags.filter(
    (t) => t.startsWith(PATH_PREFIX) && !(excludeSet?.has(t) ?? false),
  );
  if (qualifying.length === 0) return null;
  qualifying.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return qualifying[0] ?? null;
}

/**
 * Pick the color-driving tag for a memory under tag/path mode.
 * Rule: shortest qualifying tag wins; alphabetical tiebreak.
 * Returns null if no qualifying tag exists → caller uses fallback color.
 *
 * v0.29: "path" branch now delegates to pickShortestPathTag (shared with
 * computeProjectAnchors). "tag" branch keeps its inline filter (excludes
 * path:* tags; structurally inverse of the path-tag rule, not worth a
 * second shared helper).
 */
export function pickColorTag(memory: Memory, mode: "tag" | "path"): string | null {
  if (mode === "path") {
    return pickShortestPathTag(memory.tags);
  }
  // "tag" mode: shortest non-path tag, alpha tiebreak.
  const qualifying = memory.tags.filter((tag) => !tag.startsWith(PATH_PREFIX));
  if (qualifying.length === 0) return null;
  qualifying.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return qualifying[0] ?? null;
}

/**
 * Resolve the render color for a memory under the active mode.
 *
 * - layer: returns LAYER_COLORS[memory.layer] (unchanged from baseline).
 * - tag:   pickColorTag → tagPalette → fallback grey.
 * - path:  pickColorTag → pathPalette → fallback grey.
 *
 * Pure function. Never throws, never returns undefined.
 */
export function resolveColor(
  memory: Memory,
  mode: ColorMode,
  tagPalette: Map<string, string>,
  pathPalette: Map<string, string>,
): string {
  if (mode === "layer") {
    return LAYER_COLORS[memory.layer] ?? TAG_FALLBACK_COLOR;
  }
  const tag = pickColorTag(memory, mode);
  if (tag === null) return TAG_FALLBACK_COLOR;
  const palette = mode === "path" ? pathPalette : tagPalette;
  return palette.get(tag) ?? TAG_FALLBACK_COLOR;
}
