// The ranking and budget policy of a context block, on plain rows: the api reads the stores, prices
// the rows and asks these functions who gets in.

import { isRecallOnly, type MemoryEntry } from '../../base/memory/entry.js';
import { isWorthSurfacing } from '../../base/memory/memory-quality.js';
import { compareScoredResults, compareScoresDesc } from '../../base/rank/compare.js';
import type { PromptRecallGate, PromptRecallMetric } from '../../base/rank/prompt-recall.js';
import {
  DEFAULT_PROMPT_RECALL_SHARE,
  DEFAULT_SESSION_RULES_BUDGET,
  type HippoConfig,
} from '../../base/config/config.js';

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

export const finiteOr = (
  v: number,
  { fallback, min }: { readonly fallback: number; readonly min: number },
): number => (Number.isFinite(v) && v >= min ? v : fallback);

/** The pins that fit `cap`, strongest then newest, each id once; a pin that does not fit is skipped,
 * not a stop. Returned in `ranked` order, so the block's display order does not change. */
export function pinsWithinCap<T extends PricedRow>(
  ranked: readonly T[],
  cap: number,
  onOverCap?: (row: T) => void,
): T[] {
  const walk = ranked
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        compareScoresDesc(a.row.score, b.row.score) ||
        Date.parse(b.row.entry.created) - Date.parse(a.row.entry.created) ||
        a.index - b.index,
    );
  const kept = new Set<T>();
  const keptIds = new Set<string>();
  let used = 0;
  for (const { row } of walk) {
    // A synced pin sits in both stores.
    if (keptIds.has(row.entry.id)) continue;
    if (used + row.tokens > cap) {
      onOverCap?.(row);
      continue;
    }
    kept.add(row);
    keptIds.add(row.entry.id);
    used += row.tokens;
  }
  return ranked.filter((row) => kept.has(row));
}

/** The newest rows that fit `budget`, in `rows` order; of equal age the later row is newer. A row
 * that does not fit is skipped, not a stop, so a long rule never hides the shorter ones before it. */
export function newestWithin<T extends { created: string }>(
  rows: readonly T[],
  budget: number,
  price: (row: T) => number,
): T[] {
  const walk = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => Date.parse(b.row.created) - Date.parse(a.row.created) || b.index - a.index);
  const kept = new Set<T>();
  let used = 0;
  for (const { row } of walk) {
    const tokens = price(row);
    if (used + tokens > budget) continue;
    kept.add(row);
    used += tokens;
  }
  return rows.filter((row) => kept.has(row));
}

/** Skips ids already picked and rows past the budget, so a large row never blocks smaller ones
 * behind it. */
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
    threshold: finiteOr(inject.promptRecallThreshold, {
      fallback: DEFAULT_PROMPT_RECALL_THRESHOLD,
      min: 0,
    }),
    minShared: finiteOr(inject.promptRecallMinShared, {
      fallback: DEFAULT_PROMPT_RECALL_MIN_SHARED,
      min: 0,
    }),
    maxItems: finiteOr(inject.promptRecallMaxItems, {
      fallback: DEFAULT_PROMPT_RECALL_MAX_ITEMS,
      min: 1,
    }),
  };
}

/** The share of the block budget that prompt recall keeps before pins spend it; a config built in
 * code with no key reads the default. */
export function promptRecallShareOf(inject: HippoConfig['pinnedInject']): number {
  return Math.min(
    1,
    finiteOr(inject.promptRecallShare ?? Number.NaN, {
      fallback: DEFAULT_PROMPT_RECALL_SHARE,
      min: 0,
    }),
  );
}

/** The most tokens the rule lines of `hippo session-rules` use; a config built in code with no key
 * reads the default. */
export function sessionRulesBudgetOf(inject: HippoConfig['pinnedInject']): number {
  return finiteOr(inject.sessionRulesBudget ?? Number.NaN, {
    fallback: DEFAULT_SESSION_RULES_BUDGET,
    min: 1,
  });
}

/** The newest `limit` rows worth surfacing; a pin always is, a recall-only row never is. */
export function newestWorthSurfacing<T extends { entry: MemoryEntry }>(
  rows: readonly T[],
  limit: number,
): T[] {
  return (
    [...rows]
      // Newest first, then id: stable within one store, but same-millisecond rows fall to random ids across ingests.
      .sort((a, b) => {
        const byCreated = Date.parse(b.entry.created) - Date.parse(a.entry.created);
        return byCreated !== 0 ? byCreated : b.entry.id.localeCompare(a.entry.id);
      })
      // Filter before slice so a junk row is backfilled past, not counted against N. Pins bypass the floor: a dropped
      // pin's share of the shared budget would go to a backfilled row, and the pin loop could not win it back.
      .filter(({ entry }) => entry.pinned || (isWorthSurfacing(entry) && !isRecallOnly(entry)))
      .slice(0, limit)
  );
}

/** No query: the strongest rows first, each kept if it still fits `left` tokens. */
export function strongestWithin<T extends PricedRow>(
  local: readonly T[],
  global: readonly T[],
  left: number,
): T[] {
  const combined = [
    ...[...local].sort(compareScoredResults),
    ...[...global].sort(compareScoredResults),
  ].sort(compareScoredResults);
  const selected: T[] = [];
  let used = 0;
  for (const r of combined) {
    if (used + r.tokens > left) continue;
    selected.push(r);
    used += r.tokens;
  }
  return selected;
}
