/**
 * Shared filter state lifted to App.tsx per plan v2 E2.
 *
 * **Shape is LOCKED in E2.** E3 EXTENDS the shape (adds tag filters, etc.)
 * but does NOT rename or remove existing fields. Round-2 consideration:
 * "Name the shared state container in E2 scope so E3 doesn't re-litigate."
 *
 * Why prop drilling, not context / Zustand: only LivingMap + Header + Sidebar
 * consume this. Three consumers is honest prop-drilling territory.
 */

import type { Memory } from "../types.js";

export type Layer = "buffer" | "episodic" | "semantic";
// Matches Memory.confidence in ../types.ts
export type Confidence = "verified" | "observed" | "inferred" | "stale";

export interface FilterState {
  /** E2 — search input substring; matched against content + tags. */
  query: string;
  /** E3 — layer checkboxes. Empty set = show all (treated as no-filter). */
  layers: Set<Layer>;
  /** E3 — [min, max] strength range, both inclusive, 0..1. */
  strengthRange: [number, number];
  /** E3 — confidence multi-select. Empty set = show all. */
  confidences: Set<Confidence>;
  /** E3 — null = no age cap; number = show only memories <= N days old. */
  ageMaxDays: number | null;
  /** E2 — when true, scene.setReducedMotion(true) freezes the simulation. */
  frozen: boolean;
}

export const INITIAL_FILTER_STATE: FilterState = {
  query: "",
  layers: new Set(),
  strengthRange: [0, 1],
  confidences: new Set(),
  ageMaxDays: null,
  frozen: false,
};

/**
 * Is ANY filter currently active? Disambiguates "no filter, show all" from
 * "filter matches zero rows" (round 2 code-review-critic HIGH #1 fix).
 *
 * Used by useCanvasEngine to decide between `scene.setFiltered(visibleIds)`
 * and `scene.setFiltered(new Set())` — never use `visibleIds.size > 0` as
 * the gate; an empty filtered set is a meaningful state.
 */
export function isFilterActive(state: FilterState): boolean {
  if (state.query.trim().length > 0) return true;
  if (state.layers.size > 0) return true;
  if (state.confidences.size > 0) return true;
  if (state.strengthRange[0] > 0) return true;
  if (state.strengthRange[1] < 1) return true;
  if (state.ageMaxDays !== null) return true;
  return false;
}

/**
 * Predicate matching a memory against the search query. Shared by
 * deriveVisibleIds (filter pipeline) + the highlighted-id derivation in
 * useCanvasEngine + the Header matchCount display, so the three sites
 * cannot drift (round-2 code-review-critic MED).
 */
export function matchesQuery(memory: { content: string; tags: string[] }, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (memory.content.toLowerCase().includes(needle)) return true;
  return memory.tags.some((t) => t.toLowerCase().includes(needle));
}

/**
 * Compute the set of memory IDs that pass all active filters in the
 * given state. Pure function — testable in isolation. Empty result =
 * nothing visible.
 *
 * Used by E3's FilterPanel + drawer; E2's search-only path bypasses this
 * for now (LivingMap.tsx still derives matchCount inline for the header
 * pill). E3 PR will unify both paths through this function.
 */
export function deriveVisibleIds(memories: Memory[], state: FilterState): Set<string> {
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
    ids.add(m.id);
  }
  return ids;
}
