// Read path: the recall entries that cut a band. Each ranks with rankRecall under its profile, then composes the band
// and writes the recall; the budget-cut entry, retrieveWithCliCore, is in request.ts.

import { DEFAULT_SEARCH_CANDIDATE_LIMIT } from '../../base/rank/search-types.js';
import type { SearchResult } from '../../base/rank/search-types.js';
import { assertScopeRequestAllowed, personalScopeOf } from '../../base/scope/recall-scope.js';
import type {
  RecallOptions,
  RecallResult,
  RecallWindowOptions,
  ShownRanking,
  ShowRanking,
  StoreRanking,
} from './types.js';
import { type Context, ownerOrSubject, RecallContractError, sharedStoreOf } from '../types.js';
import {
  callerOf,
  recallAuditMetadata,
  recallAuditRow,
  recallLead,
  recordShownRecall,
  strengthenOf,
  type ShownList,
} from './finish.js';
import {
  composeRecall,
  planRecall,
  recallOrigin,
  type ComposedRecall,
  type RecallPlan,
  type RecallReads,
} from './compose.js';
import { rankCtxOf, rankRecall, withMissing, type RankRecallOptions, type RankRecallResult } from './pipeline.js';
import { POSITION_BAND, BAND_RANKED } from './profiles.js';
import type { ActiveGoals, ContinuityKey } from '../../base/ports/store/types.js';
import type { GoalRecallLogRow } from '../../base/ports/store/recall-writes.js';
import type { RecallWrites } from '../../base/ports/store.js';

const CONTINUITY_EVENT_LIMIT = 5;

/** Ranks under POSITION_BAND, composes the band, then writes the recall; a caller that sets `recordAs` also has the
 * recall recorded in full. */
export async function retrieve(ctx: Context, opts: RecallOptions): Promise<RecallResult> {
  assertScopeRequestAllowed(ctx.actor, opts.filter?.scope);
  const windowSize = recallWindowSize(ctx, opts.window);
  // From the authenticated actor, never from RecallOptions, which a caller fills in.
  const personalScope = personalScopeOf(ctx.actor) ?? undefined;
  const recordAs = opts.trace?.recordAs;
  if (!recordAs) return recallFromWindow(ctx, opts, windowSize, personalScope);
  const { recallHistory, leadingAudit } = recallLead(ctx, recordAs, opts.query, opts.boost?.sessionId);
  const withLead = { ...opts, hints: { ...opts.hints, recallHistory }, trace: { ...opts.trace, leadingAudit } };
  const result = await recallFromWindow(ctx, withLead, windowSize, personalScope);
  await recordShownRecall(ctx, ctx.store, recordAs, returnedList(opts, result));
  return result;
}

/** Ranks under BAND_RANKED, hands the ranking to `show`, and audits, strengthens and traces the ids `show` returns;
 * `results` stays the top window of that ranking. Under `recordAs`, `show` judges the hints, so only the shown list is
 * recorded. */
export async function retrieveRanking(ctx: Context, opts: RecallOptions, show: ShowRanking): Promise<RecallResult> {
  assertScopeRequestAllowed(ctx.actor, opts.filter?.scope);
  const windowSize = recallWindowSize(ctx, opts.window);
  const personalScope = personalScopeOf(ctx.actor) ?? undefined;
  const ranking = await rankRecall(rankCtxOf(ctx), rankRequestOf(ctx, opts, windowSize, personalScope), BAND_RANKED);
  const window = ranking.results.slice(0, windowSize).map((r) => r.entry);
  // The caller traces and audits the rows it shows, so the window writes neither.
  const windowOpts = { ...opts, trace: { ...opts.trace, suppressRecallTrace: true } };
  const plan = planRecall(ctx, windowOpts, window, personalScope, BAND_RANKED);
  const reads = await readRecall(ctx, windowOpts, plan, ranking.goals);
  const composed = composeRecall(ctx, windowOpts, {
    windowSize,
    all: window,
    plan,
    reads,
    auditWindow: false,
  });
  const cut = { show, ranking: storeRankingOf(ranking), goalLog: ranking.goalRecallLog };
  const shown = await finishShownRecall(ctx, opts, cut, composed);
  const recordAs = opts.trace?.recordAs;
  if (recordAs) await recordShownRecall(ctx, ctx.store, recordAs, presentedList(opts, shown));
  return composed.result;
}

/** What `retrieveRanking` records: the list its presenter showed, priced as printed. */
function presentedList(opts: RecallOptions, shown: ShownRanking): ShownList {
  return {
    query: opts.query,
    sessionId: opts.boost?.sessionId,
    ids: shown.ids,
    anchoredOn: shown.anchoredOn,
    tokens: shown.tokens ?? 0,
    ledgerSessionId: null,
    // finishShownRecall throws when its audit write fails, so this point is never reached without the rows.
    written: true,
  };
}

/** What `retrieve` records: the rows it returns, and the continuity block the reply carries beside them. */
function returnedList(opts: RecallOptions, result: RecallResult): ShownList {
  return {
    query: opts.query,
    sessionId: opts.boost?.sessionId,
    ids: result.results.map((r) => r.id),
    anchoredOn: result.anchoringHint?.memoryId,
    tokens: result.tokens + (result.continuityTokens ?? 0),
    ledgerSessionId: opts.boost?.sessionId ?? null,
    // A failed audit write throws out of recallFromWindow, so this point is never reached without the rows.
    written: true,
  };
}

async function recallFromWindow(
  ctx: Context,
  opts: RecallOptions,
  windowSize: number,
  personalScope: string | undefined,
): Promise<RecallResult> {
  const ranking = await rankRecall(rankCtxOf(ctx), rankRequestOf(ctx, opts, windowSize, personalScope), POSITION_BAND);
  const candidates = ranking.results.map((r) => r.entry);
  const plan = planRecall(ctx, opts, candidates, personalScope, POSITION_BAND);
  const reads = await readRecall(ctx, opts, plan, ranking.goals);
  const composed = composeRecall(ctx, opts, { windowSize, all: candidates, plan, reads });
  await finishRecall(
    ctx,
    opts,
    composed.writes,
    composed.result.results.map((r) => r.id),
  );
  return composed.result;
}

/** What an API recall asks the ranker for: its exact scope and own scope, its project, and the engine `mode` names. */
function rankRequestOf(
  ctx: Context,
  opts: RecallOptions,
  windowSize: number,
  personalScope: string | undefined,
): RankRecallOptions {
  const { sessionId, goalTag } = opts.boost ?? {};
  return {
    query: opts.query,
    window: { scorerWindow: windowSize },
    includeSuperseded: false,
    explicitScope: opts.filter?.scope ?? null,
    scopeMode: 'exact',
    ownScope: personalScope,
    originProjects: recallOrigin(opts),
    // An API goal tag only turns the session boost off, where the CLI's --goal boosts the tag instead.
    boost: goalTag ? {} : { sessionId },
    search: {
      usePhysics: opts.mode === 'physics',
      engineNamed: opts.mode === 'hybrid' || opts.mode === 'physics',
      physicsConfig: ctx.config.physics,
      multihop: false,
      explain: false,
    },
  };
}

/** The one recall write: the caller's leading audit rows go first, and the ids shown are the ones strengthened. */
async function finishRecall(
  ctx: Context,
  opts: RecallOptions,
  writes: RecallWrites,
  shownIds: readonly string[],
): Promise<void> {
  await ctx.store.finishRecall({
    ...writes,
    audit: [...(opts.trace?.leadingAudit ?? []), ...writes.audit],
    strengthen: strengthenOf(ctx, shownIds),
  });
}

/** The ranking the MCP presenter cuts its list from: every ranked row, and the scope-filtered pool for its hints. */
function storeRankingOf(ranking: RankRecallResult): StoreRanking {
  const rankedEntries = ranking.results.map((r) => r.entry);
  return {
    ranked: ranking.results,
    pool: withMissing(ranking.localEntries, rankedEntries),
    droppedByScope: ranking.droppedPreRank,
  };
}

/** What the caller cuts its list from: its presenter, the full ranking and the goal log rows it earned. */
interface CallerCut {
  readonly show: ShowRanking;
  readonly ranking: StoreRanking;
  readonly goalLog: GoalRecallLogRow[];
}

/** The caller shows its cut of the ranking; its rows go after the window's, in the same one write. */
async function finishShownRecall(
  ctx: Context,
  opts: RecallOptions,
  cut: CallerCut,
  composed: ComposedRecall,
): Promise<ShownRanking> {
  const shown = cut.show(cut.ranking, composed.result);
  const { shownRow, trace } = shownAuditAndTrace(ctx, opts, shown.ids, cut.ranking.ranked);
  const { writes } = composed;
  await finishRecall(
    ctx,
    opts,
    {
      goalLog: [...cut.goalLog, ...writes.goalLog],
      audit: [...writes.audit, shownRow, ...shown.audit],
      trace,
    },
    shown.ids,
  );
  return shown;
}

function shownAuditAndTrace(ctx: Context, opts: RecallOptions, shownIds: readonly string[], ranked: SearchResult[]) {
  const scores = new Map(ranked.map((r) => [r.entry.id, r.score]));
  const shownRow = recallAuditRow(callerOf(ctx), 'recall', undefined, recallAuditMetadata(opts.query, shownIds.length));
  const trace = opts.trace?.suppressRecallTrace
    ? undefined
    : {
        tenantId: ctx.tenantId,
        sessionId: opts.boost?.sessionId ?? null,
        pipeline: 'mcp' as const,
        query: opts.query,
        results: shownIds.map((id) => ({ memoryId: id, score: scores.get(id) ?? 0 })),
      };
  return { shownRow, trace };
}

/** Contract preflight: throws before any store-touching work. */
function recallWindowSize(ctx: Context, window: RecallWindowOptions = {}): number {
  const { scorerWindow } = window;
  // Throw before the first store read, so a bad window never opens or migrates the store.
  // The consumer site at `if (freshTailCount > 0)` does NOT re-validate.
  const freshTailCountPreflight = window.freshTailCount ?? 0;
  const sessionScoped = ctx.config.runtime?.requireSessionScopedFreshTail === true;
  if (freshTailCountPreflight > 0 && !window.freshTailSessionId && sessionScoped) {
    throw new RecallContractError(
      'fresh_tail_requires_session_id',
      'fresh-tail requires a session id when HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL=1; ' +
        'pass opts.window.freshTailSessionId or unset the env to allow tenant-wide fresh-tail.',
    );
  }
  // Undefined keeps the store default: defaulting to `limit` would shrink the pool and kill overflow summaries.
  // 0 would reach FTS/LIKE LIMIT 0 and then an uncapped full-store fallback, so non-positive values throw.
  if (scorerWindow !== undefined) {
    if (!Number.isFinite(scorerWindow) || !Number.isInteger(scorerWindow) || scorerWindow < 1) {
      throw new RecallContractError(
        'invalid_scorer_window',
        `scorerWindow must be a positive integer; got ${scorerWindow}`,
      );
    }
  }
  return scorerWindow ?? DEFAULT_SEARCH_CANDIDATE_LIMIT;
}

/** The plan's reads through the store; `goals` already read by the caller skips that read. */
async function readRecall(
  ctx: Context,
  opts: RecallOptions,
  plan: RecallPlan,
  goals?: ActiveGoals | null,
): Promise<RecallReads> {
  const { store, tenantId } = ctx;
  const { freshTailCount: freshCount = 0, freshTailSessionId } = opts.window ?? {};
  const parentIds = plan.overflow.size > 0 ? [...plan.overflow.keys()] : null;
  const continuity = opts.window?.includeContinuity ? { key: continuityKey(ctx, opts) } : null;
  return {
    goals: await goalsOf(ctx, plan, goals),
    parents: parentIds ? await store.entriesByIds(parentIds, tenantId) : [],
    freshRaws:
      freshCount > 0
        ? await store.freshRawEntries(freshCount, tenantId, freshTailSessionId, recallOrigin(opts) ?? null)
        : [],
    continuity: continuity ? await store.continuity(tenantId, CONTINUITY_EVENT_LIMIT, continuity.key) : undefined,
    planning: plan.claim ? await store.planningFallacyEvidence(tenantId, plan.claim.classQueryTokens) : null,
  };
}

/** The goals the caller already read, else the plan's read when it asks for the goal boost. */
async function goalsOf(ctx: Context, plan: RecallPlan, known: ActiveGoals | null | undefined) {
  if (known !== undefined) return known;
  if (!plan.goalBoost) return null;
  return ctx.store.activeGoals({ sessionId: plan.goalBoost.sessionId, tenantId: ctx.tenantId });
}

// On a shared store the tenant's newest row is another developer's; no project keys to nothing, so the block is empty.
function continuityKey(ctx: Context, opts: RecallOptions): ContinuityKey | null {
  if (!sharedStoreOf(ctx)) return null;
  return { owner: ownerOrSubject(ctx.actor), project: recallOrigin(opts) ?? [] };
}
