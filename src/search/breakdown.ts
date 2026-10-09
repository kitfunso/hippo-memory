import type { MemoryEntry } from '../memory.js';
import { isDagSummary } from './boosts.js';
import type { ScoreBreakdown } from '../core/search-types.js';

/** Whole days since the entry was created, never negative. */
export function ageInDays(entry: MemoryEntry, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(entry.created).getTime()) / 86_400_000));
}

/** Copies the entry's DAG metadata, and for summaries the multipliers applied, onto an explain breakdown. */
export function addDagFields(breakdown: ScoreBreakdown, entry: MemoryEntry, deboost: number, freshness: number): ScoreBreakdown {
  if (entry.dag_level !== undefined) breakdown.dagLevel = entry.dag_level;
  if (entry.descendant_count !== undefined) breakdown.descendantCount = entry.descendant_count;
  if (isDagSummary(entry)) {
    breakdown.lastRebuiltAt = entry.last_rebuilt_at ?? null;
    breakdown.rebuildCount = entry.rebuild_count ?? 0;
    breakdown.summaryDeboost = deboost;
    breakdown.summaryFreshnessBoost = freshness;
  }
  return breakdown;
}
