import { compareEntryIdentity, compareScoresDesc } from '../../base/rank/compare.js';
import { boostByGoals } from '../../domain/search/goal-boost.js';
import { graphExpandRecall, graphOf } from '../../domain/graph/recall.js';
import { Layer } from '../../base/memory/entry.js';
import {
  outcomeNudge,
  STRENGTH_RANK_FLOOR,
  STRENGTH_RANK_SPAN,
} from '../../domain/search/boosts.js';
import { applyReranker } from '../../domain/search/rerank.js';
import {
  CONFLICT_PEER_MULTIPLIER,
  SALIENCE_MIN_MULTIPLIER,
  UTILITY_LENGTH_PENALTY_CAP,
  UTILITY_LENGTH_TOKENS,
  VALUE_MULT_MAX,
  VALUE_MULT_MIN,
  VALUE_MULT_SLOPE,
  type RerankStep,
  type SearchResult,
} from '../../base/rank/search-types.js';
import { isJsonNumber } from '../../base/util/json.js';
import { indexTokenize, textOverlap, tokenize as tokenizeQuery } from '../../base/util/tokenize.js';
import type { RecallProfile } from './profiles.js';
import type { GoalRecallLogRow } from '../../base/ports/store/recall-writes.js';
import type { ActiveGoals } from '../../base/ports/store/types.js';
import type {
  RankRecallCtx,
  RecallGraphHops,
  RecallReranker,
  RankRecallOptions,
  SettledOptions,
} from './pipeline.js';
import { poolScope } from './rank-search.js';
import { isSuperseded } from '../../base/memory/liveness.js';
import { findableText } from '../../base/memory/lead-in.js';

export interface RankState {
  results: SearchResult[];
  droppedPreRank: number;
  graphAdded: number;
  goalRecallLog: GoalRecallLogRow[];
  goals?: ActiveGoals | null;
}

/** The stages after the search, in order: graph expansion, re-rank, goal boost, salience, then
 * the outcome and layer filters. */
export async function rankStages(
  ctx: RankRecallCtx,
  opts: SettledOptions,
  state: RankState,
  profile: RecallProfile,
): Promise<void> {
  if (opts.graphHops) await expandGraph(ctx, opts, opts.graphHops, state);
  reorderResults(opts, state);
  if (opts.reranker) {
    state.results = await applyRecallReranker(opts, opts.reranker, state.results, ctx);
  }
  if (profile.goalBoost.ranked) await applyGoalBoosts(ctx, opts, state);
  if (opts.salienceThreshold !== undefined) {
    state.results = applySalience(opts, opts.salienceThreshold, state.results);
  }
  const { outcome, layer } = opts;
  if (outcome) {
    dropUnless(state, (r) => r.entry.layer !== Layer.Trace || r.entry.traceOutcome === outcome);
  }
  if (layer) dropUnless(state, (r) => r.entry.layer === layer);
}

async function expandGraph(
  ctx: RankRecallCtx,
  opts: SettledOptions,
  graph: RecallGraphHops,
  state: RankState,
): Promise<void> {
  const local = graphOf(ctx.store);
  if (graph.hops <= 0 || local === undefined) return;
  const { requested } = poolScope(opts);
  const beforeGraphIds = new Set(state.results.map((r) => r.entry.id));
  state.results = await graphExpandRecall(state.results, {
    hops: graph.hops,
    maxNeighbors: graph.maxNeighbors,
    store: local,
    global: ctx.global && graphOf(ctx.global.store),
    tenantId: ctx.tenantId,
    includeSuperseded: opts.includeSuperseded,
    asOf: opts.asOf,
    budget: opts.budget,
    cost: opts.cost,
    minResults: opts.minResults,
    recallScope: requested ? { requested, additive: true } : {},
  });
  for (const r of state.results) {
    if (!beforeGraphIds.has(r.entry.id)) state.graphAdded++;
  }
}

function traced<R extends SearchResult>(
  opts: RankRecallOptions,
  prev: SearchResult,
  next: R,
  step: RerankStep,
): R {
  if (opts.why) next.rerankTrace = [...(prev.rerankTrace ?? []), step];
  return next;
}

function byScore(results: SearchResult[]): SearchResult[] {
  return results.sort((a, b) => compareScoresDesc(a.score, b.score));
}

interface RescoreStep {
  readonly stage: string;
  readonly note?: string;
}

function rescore(
  opts: RankRecallOptions,
  results: SearchResult[],
  { stage, note }: RescoreStep,
  multiplier: (r: SearchResult) => number | undefined,
): SearchResult[] {
  return byScore(
    results.map((r) => {
      const mult = multiplier(r);
      if (mult === undefined) return r;
      const next = { ...r, score: r.score * mult };
      const step = { stage, multiplier: mult, scoreBefore: r.score, scoreAfter: next.score };
      return traced(opts, r, next, note === undefined ? step : { ...step, note });
    }),
  );
}

function demoteConflictPeers(opts: RankRecallOptions, state: RankState): void {
  const presentIds = new Set(state.results.map((r) => r.entry.id));
  state.results = rescore(opts, state.results, { stage: 'interference' }, (r) =>
    (r.entry.conflictsWith || []).some((peerId) => presentIds.has(peerId))
      ? CONFLICT_PEER_MULTIPLIER
      : undefined,
  );
}

function applyValueAware(opts: RankRecallOptions, state: RankState): void {
  state.results = rescore(opts, state.results, { stage: 'value' }, (r) => {
    const pos = r.entry.outcomePositive ?? 0;
    const neg = r.entry.outcomeNegative ?? 0;
    if (pos === 0 && neg === 0) return undefined;
    return outcomeNudge(pos - neg, {
      slope: VALUE_MULT_SLOPE,
      min: VALUE_MULT_MIN,
      max: VALUE_MULT_MAX,
    });
  });
}

function applyUtilityRank(opts: RankRecallOptions, state: RankState): void {
  state.results = rescore(opts, state.results, { stage: 'utility' }, (r) => {
    const strength = isJsonNumber(r.entry.strength) ? r.entry.strength : 1.0;
    return (
      (STRENGTH_RANK_FLOOR + STRENGTH_RANK_SPAN * strength) *
      (1 - Math.min(UTILITY_LENGTH_PENALTY_CAP, (r.tokens || 0) / UTILITY_LENGTH_TOKENS))
    );
  });
}

function reorderResults(opts: RankRecallOptions, state: RankState): void {
  if (opts.evcAdaptive && state.results.length >= 2) {
    state.results = newestOnTopicFirst(opts.query, state.results);
  }
  if (opts.filterConflicts) {
    dropUnless(state, (r) => !isSuperseded(r.entry));
    demoteConflictPeers(opts, state);
  }
  if (opts.valueAware && state.results.length >= 1) applyValueAware(opts, state);
  if (opts.rerankUtility) applyUtilityRank(opts, state);
}

const NEAR_DUPLICATE_OVERLAP_MIN = 0.4;
const SCORE_FLOOR_FRACTION = 0.5;
const QUERY_COVERAGE_MIN = 0.6;
const GOAL_TAG_BOOST = 1.5;
const NEAR_DUPLICATE_WINDOW = 3;
const NEAR_DUPLICATE_POOL_MIN = 9;

function newestOnTopicFirst(query: string, results: SearchResult[]): SearchResult[] {
  const slice = results.slice(0, Math.min(NEAR_DUPLICATE_WINDOW, results.length));
  let pairs = 0;
  let overlapSum = 0;
  for (let i = 0; i < slice.length; i++) {
    for (let j = i + 1; j < slice.length; j++) {
      overlapSum += textOverlap(findableText(slice[i].entry), findableText(slice[j].entry));
      pairs++;
    }
  }
  if ((pairs > 0 ? overlapSum / pairs : 0) < NEAR_DUPLICATE_OVERLAP_MIN) return results;
  const poolSize = Math.min(
    results.length,
    Math.max(slice.length * NEAR_DUPLICATE_WINDOW, NEAR_DUPLICATE_POOL_MIN),
  );
  const pool = results.slice(0, poolSize);
  const scoreFloor = pool.reduce((m, r) => Math.max(m, r.score), 0) * SCORE_FLOOR_FRACTION;
  const queryTokens = new Set(tokenizeQuery(query));
  const onTopic: SearchResult[] = [];
  const offTopic: SearchResult[] = [];
  for (const r of pool) {
    let hits = 0;
    if (queryTokens.size > 0) {
      const candTokens = new Set(indexTokenize(findableText(r.entry)));
      for (const t of queryTokens) if (candTokens.has(t)) hits++;
    }
    const queryCoverage = queryTokens.size > 0 ? hits / queryTokens.size : 0;
    (r.score >= scoreFloor || queryCoverage >= QUERY_COVERAGE_MIN ? onTopic : offTopic).push(r);
  }
  onTopic.sort((a, b) => {
    const ta = new Date(a.entry.created).getTime();
    const tb = new Date(b.entry.created).getTime();
    return tb !== ta ? tb - ta : compareEntryIdentity(a.entry, b.entry);
  });
  return [...onTopic, ...offTopic, ...results.slice(poolSize)];
}

function applyRecallReranker(
  opts: RankRecallOptions,
  reranker: RecallReranker,
  results: SearchResult[],
  { config, signal }: RankRecallCtx,
): Promise<SearchResult[]> {
  const rerankerOptions = { topK: reranker.topK, clef: config.runtime?.clef, signal };
  return applyReranker({
    query: opts.query,
    ordered: results,
    reranker: reranker.fn,
    rerankerOptions,
    onRanked: (r) =>
      traced(
        opts,
        r,
        { ...r, score: r.rerankScore },
        { stage: 'reranker', scoreBefore: r.score, scoreAfter: r.rerankScore },
      ),
  });
}

async function applyGoalBoosts(
  ctx: RankRecallCtx,
  opts: SettledOptions,
  state: RankState,
): Promise<void> {
  const { goalTag = '', sessionId } = opts.boost ?? {};
  state.goals = null;
  if (goalTag) {
    state.results = rescore(
      opts,
      state.results,
      { stage: 'goal', note: `--goal ${goalTag}` },
      (r) => (r.entry.tags?.includes(goalTag) ? GOAL_TAG_BOOST : undefined),
    );
    return;
  }
  if (!sessionId) return;
  const goalBoostTrace = opts.why ? new Map<string, RerankStep>() : undefined;
  const session = { sessionId, tenantId: ctx.tenantId };
  state.goals = await ctx.store.activeGoals(session);
  const boost = boostByGoals(state.results, state.goals, {
    ...session,
    limit: opts.limit,
    now: ctx.now,
    trace: goalBoostTrace,
  });
  state.results = boost.results;
  state.goalRecallLog = boost.log;
  if (goalBoostTrace && goalBoostTrace.size > 0) {
    state.results = state.results.map((r) => {
      const step = goalBoostTrace.get(r.entry.id);
      return step ? { ...r, rerankTrace: [...(r.rerankTrace ?? []), step] } : r;
    });
  }
}

function applySalience(
  opts: RankRecallOptions,
  threshold: number,
  results: SearchResult[],
): SearchResult[] {
  return rescore(opts, results, { stage: 'retrieval-count-downweight' }, (r) => {
    const count = r.entry.retrievalCount ?? 0;
    return count >= threshold ? undefined : Math.max(SALIENCE_MIN_MULTIPLIER, count / threshold);
  });
}

function dropUnless(state: RankState, keep: (r: SearchResult) => boolean): void {
  const before = state.results.length;
  state.results = state.results.filter(keep);
  state.droppedPreRank += before - state.results.length;
}
