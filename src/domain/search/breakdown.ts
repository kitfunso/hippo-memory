import type { MemoryEntry } from '../../base/memory/memory.js';
import { isDagSummary } from './boosts.js';
import type { ScoreBreakdown } from '../../base/rank/search-types.js';
import { DAY_MS } from '../../base/util/time.js';

/** Whole days since the entry was created, never negative. */
export function ageInDays(entry: MemoryEntry, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(entry.created).getTime()) / DAY_MS));
}

/** Copies the entry's DAG metadata, and for summaries the multipliers applied, onto an explain breakdown. */
export function addDagFields(
  breakdown: ScoreBreakdown,
  entry: MemoryEntry,
  deboost: number,
  freshness: number,
): ScoreBreakdown {
  if (entry.dagLevel !== undefined) breakdown.dagLevel = entry.dagLevel;
  if (entry.descendantCount !== undefined) breakdown.descendantCount = entry.descendantCount;
  if (isDagSummary(entry)) {
    breakdown.lastRebuiltAt = entry.lastRebuiltAt ?? null;
    breakdown.rebuildCount = entry.rebuildCount ?? 0;
    breakdown.summaryDeboost = deboost;
    breakdown.summaryFreshnessBoost = freshness;
  }
  return breakdown;
}
