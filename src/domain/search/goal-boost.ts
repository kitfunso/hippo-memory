// src/domain/search/goal-boost.ts: the goal-stack boost over goals already read; it ranks rows and
// touches no store.
import { compareScoresDesc } from '../../base/rank/compare.js';
import { DEFAULT_SCHEMA_FIT, ERROR_TAG, type MemoryEntry } from '../../base/memory/entry.js';
import type { RerankStep } from '../../base/rank/search-types.js';
import type { ActiveGoals, Goal, RetrievalPolicy } from '../../base/ports/store/types.js';
import type { GoalRecallLogRow } from '../../base/ports/store/recall-writes.js';
import { redactSecretsStrict } from '../../base/util/secret-detect.js';

const MAX_FINAL_MULTIPLIER = 3.0;
const FIRST_MATCH_BOOST = 2.0;
const EXTRA_MATCH_BOOST = 0.5;

/** Options of {@link boostByGoals}. */
export interface GoalStackBoostOptions {
  sessionId: string;
  tenantId: string;
  limit: number;
  now: Date;
  /**
   * Side-channel: one goal-boost `RerankStep` per boosted row, keyed by `entry.id` (a map because
   * the helper re-spreads rows); only populated when passed.
   */
  trace?: Map<string, RerankStep>;
}

/** The boosted, re-sorted rows and the `goal_recall_log` rows they earn. */
export interface GoalStackBoost<R> {
  results: R[];
  log: GoalRecallLogRow[];
}

interface GoalBoostMultiplierOptions {
  readonly entry: MemoryEntry;
  readonly tags: string[];
  readonly matches: string[];
  readonly goalsByTag: Map<string, Goal>;
  readonly policiesByGoalId: ReadonlyMap<string, RetrievalPolicy>;
}

/** The capped boost for one row whose tags match `matches` active goals. */
function goalBoostMultiplier({
  entry,
  tags,
  matches,
  goalsByTag,
  policiesByGoalId,
}: GoalBoostMultiplierOptions): number {
  // First match boosts by FIRST_MATCH_BOOST, each further one adds EXTRA_MATCH_BOOST, capped at
  // MAX_FINAL_MULTIPLIER.
  let multiplier = Math.min(
    FIRST_MATCH_BOOST + EXTRA_MATCH_BOOST * (matches.length - 1),
    MAX_FINAL_MULTIPLIER,
  );
  // Compose per-policy multipliers per matched tag.
  for (const tag of matches) {
    const goal = goalsByTag.get(tag)!;
    const policy = policiesByGoalId.get(goal.id);
    if (!policy) continue;
    if (policy.policyType === 'error-prioritized' && tags.includes(ERROR_TAG)) {
      multiplier *= policy.errorPriority;
    } else if (policy.policyType === 'schema-fit-biased') {
      // Linearly weight schema_fit in [0,1] up to (weightSchemaFit)x.
      // Default 1.0 is a no-op.
      multiplier *=
        1.0 + Math.max(0, policy.weightSchemaFit - 1.0) * (entry.schemaFit ?? DEFAULT_SCHEMA_FIT);
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
  opts: GoalStackBoostOptions,
): GoalRecallLogRow[] {
  const { sessionId, tenantId, limit } = opts;
  const recalledAt = opts.now.toISOString();
  const log: GoalRecallLogRow[] = [];
  for (const r of boosted.slice(0, limit)) {
    const matches = matchesByEntryId.get(r.entry.id);
    if (!matches || matches.length === 0) continue;
    for (const tag of matches) {
      const goal = goalsByTag.get(tag);
      if (!goal) continue;
      log.push({
        goalId: goal.id,
        memoryId: r.entry.id,
        tenantId,
        sessionId,
        recalledAt,
        score: r.score,
      });
    }
  }
  return log;
}

/**
 * The goal-stack boost over goals already read, touching no store; a caller skips it under an
 * explicit goal tag. Its log covers the top `limit` rows and keeps those whose memory is global,
 * since only the store can tell them apart; {@link localGoalRecallRows} drops those before the
 * write.
 */
export function boostByGoals<R extends { entry: MemoryEntry; score: number }>(
  results: R[],
  active: ActiveGoals,
  opts: GoalStackBoostOptions,
): GoalStackBoost<R> {
  const { trace } = opts;
  if (active.goals.length === 0) return { results, log: [] };

  // Goal names are stored redacted and tags raw, so both sides are keyed in stored form.
  const goalsByTag = new Map(active.goals.map((g) => [redactSecretsStrict(g.goalName), g]));
  const goals = { goalsByTag, policiesByGoalId: active.policies };

  // Goal-tag matches per boosted row, keyed by entry id; a side table (not a spread-on marker
  // property) so `boosted` stays exactly R[] with no cast-then-strip.
  const matchesByEntryId = new Map<string, string[]>();

  const boosted = results
    .map((r) => {
      const tags = r.entry.tags ?? [];
      const matches = [...new Set(tags.map(redactSecretsStrict))].filter((t) => goalsByTag.has(t));
      if (matches.length === 0) return r;
      const multiplier = goalBoostMultiplier({ entry: r.entry, tags, matches, ...goals });
      // Recall-trace side-channel: record the goal-boost step BEFORE the score is mutated, keyed by
      // entry id; a pure read of r.score.
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
      // SAFETY: spreading a generic-constrained `r: R` widens to the spread's plain object type;
      // only `score` changes, so the value still satisfies R.
      return { ...r, score: r.score * multiplier } as R;
    })
    // Deliberately a PLAIN stable score sort with no compareEntryIdentity tail: re-sorting an already deterministic
    // ranking inherits its determinism via stability, and ties keep the prior (meaningful) rank instead of reordering
    // by content.
    .sort((a, b) => compareScoresDesc(a.score, b.score));

  return { results: boosted, log: buildGoalRecallLog(boosted, matchesByEntryId, goalsByTag, opts) };
}
