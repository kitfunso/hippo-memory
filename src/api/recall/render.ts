// Recall text pieces the CLI and MCP presenters share, so the budget loop, cutoff wording and hints cannot drift apart.

import type { SearchResult } from '../../core/search-types.js';
import { estimateTokens } from '../../util/token-text.js';
import {
  detectAnchoring,
  biasHintEnabled,
  snapshotRing,
  type AnchoringHint,
  type RingBuffer,
} from './finish.js';
import { detectAvailabilityBias, type AvailabilityHint } from '../availability.js';
import type { RecallSuppressionSummary } from './types.js';

/** A token allowance that sections pay from in print order; one that does not fit is refused whole. */
export function tokenPurse(allowance: number) {
  let left = allowance;
  return {
    pays(tokens: number): boolean {
      if (tokens > left) return false;
      left -= tokens;
      return true;
    },
    left: (): number => left,
  };
}

/** Renders `count` rows, then drops the lowest-ranked one until the text fits `budget` or only `floor` rows remain. */
export function shrinkToFit<R>(
  count: number,
  floor: number,
  budget: number,
  render: (kept: number) => R,
  textOf: (rendered: R) => string,
): R {
  let kept = count;
  let rendered = render(kept);
  // The hints, cutoff and heading vary with the list, so the whole text is re-measured after each drop.
  while (kept > floor && estimateTokens(textOf(rendered)) > budget) {
    kept--;
    rendered = render(kept);
  }
  return rendered;
}

/** The clause strings of the cutoff text; each surface frames them in its own line or section. */
export function cutoffClauses(s: RecallSuppressionSummary): string[] {
  const clauses: string[] = [];
  // The residual covers rank, budget and limit drops alike, and fires with no --limit at all.
  if (s.droppedByBudget > 0) clauses.push(`${s.droppedByBudget} not shown (rank, budget or limit)`);
  if (s.droppedPreRank > 0) clauses.push(`${s.droppedPreRank} filtered pre-rank`);
  if (s.summarySubstitutionsAdded > 0) clauses.push(`${s.summarySubstitutionsAdded} summary substitutions added`);
  if (s.freshTailAdded > 0) clauses.push(`${s.freshTailAdded} fresh-tail added`);
  if (s.suppressedByInterference > 0) clauses.push(`${s.suppressedByInterference} suppressed by interference`);
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
  // A query_repeat is a re-ask, not competition.
  return { ...counts, suppressedByInterference: anchoring?.reason === 'memory_dominance' ? 1 : 0 };
}

export interface HintInputs {
  readonly list: SearchResult[];
  /** The candidate pool for availability bias; null when that hint is switched off. */
  readonly pool: ReadonlyArray<{ id: string; created: string }> | null;
  readonly anchorRing: RingBuffer | null;
  readonly queryHash: number;
}

/** Availability needs a pool only when its env switch is on, so callers skip building one otherwise. */
export function availabilityPool<E extends { id: string; created: string }>(
  entries: () => ReadonlyArray<E>,
): Array<{ id: string; created: string }> | null {
  return biasHintEnabled('availability') ? entries().map((e) => ({ id: e.id, created: e.created })) : null;
}

export function detectRecallHints({ list, pool, anchorRing, queryHash }: HintInputs): RecallHints {
  const anchoring = anchorRing ? detectAnchoring(snapshotRing(anchorRing), queryHash, list[0]?.entry.id ?? null) : null;
  const availability = pool
    ? detectAvailabilityBias({ topK: list.map((r) => ({ id: r.entry.id, created: r.entry.created })), pool })
    : null;
  return { anchoring, availability };
}
