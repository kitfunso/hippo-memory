// The ranking and budget policy of a context block, on plain rows: the api reads the stores, prices the rows and asks
// these functions who gets in.

import type { MemoryEntry } from '../../base/memory/memory.js';
import { isWorthSurfacing } from '../../base/memory/memory-quality.js';
import { compareScoredResults } from '../../base/rank/compare.js';
import type { PromptRecallGate, PromptRecallMetric } from '../../base/rank/prompt-recall.js';
import type { HippoConfig } from '../../base/config/config.js';

/** A row with its score and what it costs the budget. */
export interface PricedRow {
  entry: MemoryEntry;
  score: number;
  tokens: number;
  isGlobal?: boolean;
  promptRecall?: boolean;
}

/** The pinned-only branch's shared budget: the backfill and the pin loop both spend it. */
export interface Picked<T extends PricedRow> {
  items: T[];
  ids: Set<string>;
  used: number;
}

// Overlap a candidate needs with the prompt when the config sets none.
const DEFAULT_PROMPT_RECALL_THRESHOLD = 0.04;
const DEFAULT_PROMPT_RECALL_MIN_SHARED = 2;
const DEFAULT_PROMPT_RECALL_MAX_ITEMS = 5;

export const finiteOr = (v: number, dflt: number, min: number): number => (Number.isFinite(v) && v >= min ? v : dflt);

// Mirrors the pin loop's continue-not-break so a big pin cannot block smaller ones from reserving, and dedupes by id
// because a synced pin sits in both stores. A pin also in the recent slice is counted twice: recents under-fill,
// safely.
export function reservePinned(rankedPinned: readonly PricedRow[], budget: number): number {
  let reserve = 0;
  const reservedIds = new Set<string>();
  for (const r of rankedPinned) {
    if (reservedIds.has(r.entry.id)) continue;
    if (reserve + r.tokens <= budget) {
      reserve += r.tokens;
      reservedIds.add(r.entry.id);
    }
  }
  return reserve;
}

/** Skips ids already picked and rows past the budget, so a large row never blocks smaller ones behind it. */
export function admitWithinBudget<T extends PricedRow>(
  rows: readonly T[],
  picked: Picked<T>,
  budget: number,
  onOverBudget?: (row: T) => void,
): void {
  for (const r of rows) {
    if (picked.ids.has(r.entry.id)) continue;
    if (picked.used + r.tokens > budget) {
      onOverBudget?.(r);
      continue;
    }
    picked.items.push(r);
    picked.ids.add(r.entry.id);
    picked.used += r.tokens;
  }
}

/** The prompt-recall gate a config asks for; a value that is not a number reads as its default. */
export function promptRecallGateOf(inject: HippoConfig['pinnedInject']): PromptRecallGate {
  const metric: PromptRecallMetric = inject.promptRecallMetric === 'cosine' ? 'cosine' : 'jaccard';
  return {
    metric,
    threshold: finiteOr(inject.promptRecallThreshold, DEFAULT_PROMPT_RECALL_THRESHOLD, 0),
    minShared: finiteOr(inject.promptRecallMinShared, DEFAULT_PROMPT_RECALL_MIN_SHARED, 0),
    maxItems: finiteOr(inject.promptRecallMaxItems, DEFAULT_PROMPT_RECALL_MAX_ITEMS, 1),
  };
}

/** The newest `limit` rows worth surfacing; a pin always is. */
export function newestWorthSurfacing<T extends { entry: MemoryEntry }>(rows: readonly T[], limit: number): T[] {
  return (
    [...rows]
      // Newest first, then id: stable within one store, but same-millisecond rows fall to random ids across ingests.
      .sort((a, b) => {
        const byCreated = Date.parse(b.entry.created) - Date.parse(a.entry.created);
        return byCreated !== 0 ? byCreated : b.entry.id.localeCompare(a.entry.id);
      })
      // Filter before slice so a junk row is backfilled past, not counted against N. Pins bypass the floor: a dropped
      // pin's share of the shared budget would go to a backfilled row, and the pin loop could not win it back.
      .filter(({ entry }) => entry.pinned || isWorthSurfacing(entry))
      .slice(0, limit)
  );
}

/** No query: the strongest rows first, each kept if it still fits `left` tokens. */
export function strongestWithin<T extends PricedRow>(local: readonly T[], global: readonly T[], left: number): T[] {
  const combined = [...[...local].sort(compareScoredResults), ...[...global].sort(compareScoredResults)].sort(
    compareScoredResults,
  );
  const selected: T[] = [];
  let used = 0;
  for (const r of combined) {
    if (used + r.tokens > left) continue;
    selected.push(r);
    used += r.tokens;
  }
  return selected;
}
