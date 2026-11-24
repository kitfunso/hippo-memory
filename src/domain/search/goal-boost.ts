import { compareScoresDesc } from '../../base/rank/compare.js';
import { DEFAULT_SCHEMA_FIT, ERROR_TAG, type MemoryEntry } from '../../base/memory/entry.js';
import type { RerankStep } from '../../base/rank/search-types.js';
import type { ActiveGoals, Goal, RetrievalPolicy } from '../../base/ports/store/types.js';
import type { GoalRecallLogRow } from '../../base/ports/store/recall-writes.js';

const MAX_FINAL_MULTIPLIER = 3.0;
const FIRST_MATCH_BOOST = 2.0;
const EXTRA_MATCH_BOOST = 0.5;

/** Options of {@link boostByGoals}. */
export interface GoalStackBoostOptions {
  sessionId: string;
  tenantId: string;
  limit: number;
  now: Date;
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

function goalBoostMultiplier({
  entry,
  tags,
  matches,
  goalsByTag,
  policiesByGoalId,
}: GoalBoostMultiplierOptions): number {
  let multiplier = Math.min(
    FIRST_MATCH_BOOST + EXTRA_MATCH_BOOST * (matches.length - 1),
    MAX_FINAL_MULTIPLIER,
  );
  for (const tag of matches) {
    const goal = goalsByTag.get(tag)!;
    const policy = policiesByGoalId.get(goal.id);
    if (!policy) continue;
    if (policy.policyType === 'error-prioritized' && tags.includes(ERROR_TAG)) {
      multiplier *= policy.errorPriority;
    } else if (policy.policyType === 'schema-fit-biased') {
      multiplier *=
        1.0 + Math.max(0, policy.weightSchemaFit - 1.0) * (entry.schemaFit ?? DEFAULT_SCHEMA_FIT);
    } else if (policy.policyType === 'recency-first') {
      multiplier *= policy.weightRecency;
    } else if (policy.policyType === 'hybrid') {
      multiplier *= policy.weightOutcome;
    }
  }
  return Math.min(multiplier, MAX_FINAL_MULTIPLIER);
}

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

  const goalsByTag = new Map(active.goals.map((g) => [g.goalName, g]));
  const goals = { goalsByTag, policiesByGoalId: active.policies };

  const matchesByEntryId = new Map<string, string[]>();

  const boosted = results
    .map((r) => {
      const tags = r.entry.tags ?? [];
      const matches = tags.filter((t) => goalsByTag.has(t));
      if (matches.length === 0) return r;
      const multiplier = goalBoostMultiplier({ entry: r.entry, tags, matches, ...goals });
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
    .sort((a, b) => compareScoresDesc(a.score, b.score));

  return { results: boosted, log: buildGoalRecallLog(boosted, matchesByEntryId, goalsByTag, opts) };
}
