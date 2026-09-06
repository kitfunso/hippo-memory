/** Shared filter state for LivingMap + Header + Sidebar; three consumers do not justify a store. */

import type { Memory } from "../types.js";

export type Layer = "buffer" | "episodic" | "semantic";
// Matches Memory.confidence in ../types.ts
export type Confidence = "verified" | "observed" | "inferred" | "stale";

export type ColorMode = "layer" | "tag" | "path";

/** Both VIEW and FILTER state: composes with other filters, hides memories, included in isFilterActive, cleared by resetFilters. */
export interface LocalViewState {
  /** Memory ID at the focus center; App.tsx guards it exists at set-time, LivingMap clears it if later deleted. */
  centerId: string;
  /** N-hop depth from center; hard-capped at 5 by the helper. */
  depth: number;
}

export interface FilterState {
  query: string;
  /** Layer checkboxes; empty set = show all (no-filter). */
  layers: Set<Layer>;
  /** [min, max] strength range, both inclusive, 0..1. */
  strengthRange: [number, number];
  /** Confidence multi-select; empty set = show all. */
  confidences: Set<Confidence>;
  /** null = no age cap; number = show only memories <= N days old. */
  ageMaxDays: number | null;
  frozen: boolean;
  /** When true, deriveVisibleIds returns only memories where isFading(m) is true (composes AND with other filters). */
  fadingOnly: boolean;
  /** Drives node color axis; "layer" is the default. VIEW state, not a filter — excluded from isFilterActive, preserved by resetFilters. */
  colorMode: ColorMode;
  /** When non-null, deriveVisibleIds intersects with centerId's N-hop neighborhood (via conflict + shared-tag edges). IS a filter: appears in isFilterActive, cleared by resetFilters. */
  localView: LocalViewState | null;
}

export const INITIAL_FILTER_STATE: FilterState = {
  query: "",
  layers: new Set(),
  strengthRange: [0, 1],
  confidences: new Set(),
  ageMaxDays: null,
  frozen: false,
  fadingOnly: false,
  colorMode: "layer",
  localView: null,
};

/** Fading/at-risk threshold; src/cli.ts:2541 uses 0.2 instead of 0.1, a known cross-file inconsistency (see docs/ARCHITECTURE.md). */
export const FADING_STRENGTH_THRESHOLD = 0.1;

/** Fading = below threshold and not pinned; pinned memories are protected and cannot fade. Pick<Memory> signature documents that only these two fields are read. */
export function isFading(m: Pick<Memory, "strength" | "pinned">): boolean {
  return m.strength < FADING_STRENGTH_THRESHOLD && !m.pinned;
}

/** Disambiguates "no filter, show all" from "filter matched zero rows" — never gate on visibleIds.size alone (see docs/ARCHITECTURE.md). */
export function isFilterActive(state: FilterState): boolean {
  if (state.query.trim().length > 0) return true;
  if (state.layers.size > 0) return true;
  if (state.confidences.size > 0) return true;
  if (state.strengthRange[0] > 0) return true;
  if (state.strengthRange[1] < 1) return true;
  if (state.ageMaxDays !== null) return true;
  // Without this branch, pill-only activation would silently no-op every consumer gated on filterActive.
  if (state.fadingOnly) return true;
  // Same trap as fadingOnly: without this branch, scene.setFiltered's line-visibility extension would silently no-op.
  if (state.localView !== null) return true;
  return false;
}

/** Shared by deriveVisibleIds, useCanvasEngine's highlight derivation, and the Header matchCount display, so the three can't drift. */
export function matchesQuery(memory: { content: string; tags: string[] }, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (memory.content.toLowerCase().includes(needle)) return true;
  return memory.tags.some((t) => t.toLowerCase().includes(needle));
}

/** Pure; empty result = nothing visible. LivingMap.tsx's header-pill matchCount still derives inline rather than through this — not yet unified. */
export function deriveVisibleIds(
  memories: Memory[],
  state: FilterState,
  /** When state.localView is set and this is provided, filters to the neighborhood; if undefined, the local-view filter silently no-ops (safe degradation, tested). */
  localNeighborhood?: Set<string>,
): Set<string> {
  const ids = new Set<string>();
  const filterLayers = state.layers.size > 0;
  const filterConfidences = state.confidences.size > 0;
  const [strMin, strMax] = state.strengthRange;
  const filterStrength = strMin > 0 || strMax < 1;
  const filterAge = state.ageMaxDays !== null;

  for (const m of memories) {
    if (!matchesQuery(m, state.query)) continue;
    if (filterLayers && !state.layers.has(m.layer as Layer)) continue;
    if (filterConfidences && !state.confidences.has(m.confidence as Confidence)) continue;
    if (filterStrength && (m.strength < strMin || m.strength > strMax)) continue;
    if (filterAge && state.ageMaxDays !== null && m.age_days > state.ageMaxDays) continue;
    if (state.fadingOnly && !isFading(m)) continue;
    // Local-view filter only applies when both the flag and the neighborhood Set are present.
    if (state.localView !== null && localNeighborhood !== undefined
        && !localNeighborhood.has(m.id)) continue;
    ids.add(m.id);
  }
  return ids;
}
