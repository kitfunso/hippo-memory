import type { SearchResult } from '../../base/rank/search-types.js';
import { snapshotRing, type RingBuffer } from '../../api/recall/session-rings.js';
import {
  detectAnchoring,
  biasHintEnabled,
  type AnchoringHint,
  type HintConfig,
} from '../../api/recall/anchoring.js';
import { detectAvailabilityBias, type AvailabilityHint } from '../../api/availability.js';
import type { RecallSuppressionSummary } from '../../api/recall/types.js';

/** The clause strings of the cutoff text; each surface frames them in its own line or section. */
export function cutoffClauses(s: RecallSuppressionSummary): string[] {
  const clauses: string[] = [];
  if (s.droppedByBudget > 0) clauses.push(`${s.droppedByBudget} not shown (rank, budget or limit)`);
  if (s.droppedPreRank > 0) clauses.push(`${s.droppedPreRank} filtered pre-rank`);
  if (s.summarySubstitutionsAdded > 0) {
    clauses.push(`${s.summarySubstitutionsAdded} summary substitutions added`);
  }
  if (s.freshTailAdded > 0) clauses.push(`${s.freshTailAdded} fresh-tail added`);
  if (s.suppressedByInterference > 0) {
    clauses.push(`${s.suppressedByInterference} suppressed by interference`);
  }
  return clauses;
}

export type SuppressionCounts = Omit<RecallSuppressionSummary, 'suppressedByInterference'>;

export interface RecallHints {
  readonly anchoring: AnchoringHint | null;
  readonly availability: AvailabilityHint | null;
}

export function suppressionSummary(
  counts: SuppressionCounts,
  anchoring: AnchoringHint | null,
): RecallSuppressionSummary {
  return { ...counts, suppressedByInterference: anchoring?.reason === 'memory_dominance' ? 1 : 0 };
}

export interface HintInputs {
  readonly list: SearchResult[];
  readonly pool: ReadonlyArray<{ id: string; created: string }> | null;
  readonly anchorRing: RingBuffer | null;
  readonly queryHash: number;
}

/** Availability needs a pool only when its switch is on, so callers skip building one otherwise. */
export function availabilityPool<E extends { id: string; created: string }>(
  config: HintConfig,
  entries: () => ReadonlyArray<E>,
): Array<{ id: string; created: string }> | null {
  return biasHintEnabled(config, 'availability')
    ? entries().map((e) => ({ id: e.id, created: e.created }))
    : null;
}

export function detectRecallHints({ list, pool, anchorRing, queryHash }: HintInputs): RecallHints {
  const anchoring = anchorRing
    ? detectAnchoring(snapshotRing(anchorRing), queryHash, list[0]?.entry.id ?? null)
    : null;
  const availability = pool
    ? detectAvailabilityBias({
        topK: list.map((r) => ({ id: r.entry.id, created: r.entry.created })),
        pool,
      })
    : null;
  return { anchoring, availability };
}
