// src/search/goal-boost.ts: the goal-stack boost over goals already read; it ranks rows and touches no store.
import { compareScoresDesc } from '../core/compare.js';
import type { MemoryEntry } from '../core/memory.js';
import type { RerankStep } from '../core/search-types.js';
import type { ActiveGoals, Goal, GoalRecallLogRow, RetrievalPolicy } from '../store/goals.js';

const MAX_FINAL_MULTIPLIER = 3.0;

/** Options of {@link boostByGoals}. */
export interface GoalStackBoostOpts {
  sessionId: string;
  tenantId: string;
  limit: number;
  /** Side-channel: one goal-boost `RerankStep` per boosted row, keyed by `entry.id` (a map because the helper re-spreads rows); only populated when passed. */
  trace?: Map<string, RerankStep>;
}

/** The boosted, re-sorted rows and the `goal_recall_log` rows they earn. */
export interface GoalStackBoost<R> {
  results: R[];
  log: GoalRecallLogRow[];
}

/** The capped boost for one row whose tags match `matches` active goals. */
function goalBoostMultiplier(
  entry: MemoryEntry,
  tags: string[],
  matches: string[],
  goalsByTag: Map<string, Goal>,
  policiesByGoalId: ReadonlyMap<string, RetrievalPolicy>,
): number {
  // Base 2.0x for first match, +0.5x per additional, capped at 3.0x.
  let multiplier = Math.min(
    2.0 + 0.5 * (matches.length - 1),
    MAX_FINAL_MULTIPLIER,
  );
  // Compose per-policy multipliers per matched tag.
  for (const tag of matches) {
    const goal = goalsByTag.get(tag)!;
    const policy = policiesByGoalId.get(goal.id);
    if (!policy) continue;
    if (policy.policyType === 'error-prioritized' && tags.includes('error')) {
      multiplier *= policy.errorPriority;
    } else if (policy.policyType === 'schema-fit-biased') {
      // Linearly weight schema_fit in [0,1] up to (weightSchemaFit)x.
      // Default 1.0 is a no-op.
      multiplier *=
        1.0 +
        Math.max(0, policy.weightSchemaFit - 1.0) *
          (entry.schema_fit ?? 0.5);
    } else if (policy.policyType === 'recency-first') {
      multiplier *= policy.weightRecency;
    } else if (policy.policyType === 'hybrid') {
      multiplier *= policy.weightOutcome;
    }
  }
  // Hard cap AFTER all composition.
  return Math.min(multiplier, MAX_FINAL_MULTIPLIER);
}

/** Log rows for the top `limit` boosted rows, one per matched goal. */
function buildGoalRecallLog<R extends { entry: MemoryEntry; score: number }>(
  boosted: R[],
  matchesByEntryId: Map<string, string[]>,
  goalsByTag: Map<string, Goal>,
  opts: GoalStackBoostOpts,
): GoalRecallLogRow[] {
  const { sessionId, tenantId, limit } = opts;
  const recalledAt = new Date().toISOString();
  const log: GoalRecallLogRow[] = [];
  for (const r of boosted.slice(0, limit)) {
    const matches = matchesByEntryId.get(r.entry.id);
    if (!matches || matches.length === 0) continue;
    for (const tag of matches) {
      const goal = goalsByTag.get(tag);
      if (!goal) continue;
      log.push({ goalId: goal.id, memoryId: r.entry.id, tenantId, sessionId, recalledAt, score: r.score });
    }
  }
  return log;
}

/** The goal-stack boost over goals already read, touching no store; a caller skips it under an explicit goal tag. Its log covers the top
 *  `limit` rows and keeps those whose memory is global, since only the store can tell them apart; {@link localGoalRecallRows} drops those before the write. */
export function boostByGoals<R extends { entry: MemoryEntry; score: number }>(
  results: R[],
  active: ActiveGoals,
  opts: GoalStackBoostOpts,
): GoalStackBoost<R> {
  const { trace } = opts;
  if (active.goals.length === 0) return { results, log: [] };

  const goalsByTag = new Map(active.goals.map((g) => [g.goalName, g]));
  const policiesByGoalId = active.policies;

  // Goal-tag matches per boosted row, keyed by entry id; a side table (not a spread-on marker property) so `boosted` stays exactly R[] with no cast-then-strip.
  const matchesByEntryId = new Map<string, string[]>();

  const boosted = results
    .map((r) => {
      const tags = r.entry.tags ?? [];
      const matches = tags.filter((t) => goalsByTag.has(t));
      if (matches.length === 0) return r;
      const multiplier = goalBoostMultiplier(r.entry, tags, matches, goalsByTag, policiesByGoalId);
      // Recall-trace side-channel: record the goal-boost step BEFORE the
      // score is mutated, keyed by entry id; a pure read of r.score.
      if (trace) {
        trace.set(r.entry.id, {
          stage: 'goal-boost',
          multiplier,
          scoreBefore: r.score,
          scoreAfter: r.score * multiplier,
          note: matches.join(', '),
        });
      }
      matchesByEntryId.set(r.entry.id, matches);
      // SAFETY: spreading a generic-constrained `r: R` widens to the spread's plain object type; only `score` changes, so the value still satisfies R.
      return { ...r, score: r.score * multiplier } as R;
    })
    // Deliberately a PLAIN stable score sort with no compareEntryIdentity tail: re-sorting an already deterministic ranking inherits its determinism via
    // stability, and ties keep the prior (meaningful) rank instead of reordering by content.
    .sort((a, b) => compareScoresDesc(a.score, b.score));

  return { results: boosted, log: buildGoalRecallLog(boosted, matchesByEntryId, goalsByTag, opts) };
}
