// Read path: one typed entry per recall ranker (retrieve, retrieveRanking; the CLI core is in request.ts).

import { envRequireSessionScopedFreshTail } from '../../util/env.js';
import { DEFAULT_SEARCH_CANDIDATE_LIMIT } from '../../core/search-types.js';
import type { MemoryEntry } from '../../core/memory.js';
import { boostByGoals } from '../../search/goal-boost.js';
import type { RecallSearchArgs, RecallWrites } from '../../store/port.js';
import { searchByEngine } from '../../search/engine.js';
import { vectorSourceOf } from '../../search/hybrid.js';
import type { HybridVectorCandidates } from '../../search/vector.js';
import type { PhysicsConfig } from '../../core/physics-config.js';
import {
  passesScopeFilterForRecall,
  assertScopeRequestAllowed,
  personalScopeOf,
  recallScopeFilter,
} from '../../core/recall-scope.js';
import type { RecallOptions, RecallResult, RecallWindowOptions, ShowRanking, StoreRanking } from './types.js';
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
import type { ActiveGoals, ContinuityKey } from '../../store/port/types.js';
import type { GoalRecallLogRow } from '../../store/port/recall-writes.js';

const CONTINUITY_EVENT_LIMIT = 5;
// Tag, pin and recency boosts can lift a row from deep in the BM25 order, so MCP ranks a wide lexical window.
const WHOLE_STORE_LEXICAL_WINDOW = 1000;

type EngineSearchOptions = Parameters<typeof searchByEngine>[4];
type RankedResults = Awaited<ReturnType<typeof searchByEngine>>;

/** The default ranker: the SQL BM25 window, reordered by hybrid or physics search when `mode` asks, then the recall's
 * write; a surface that sets `recordAs` also has the recall recorded in full. */
export async function retrieve(ctx: Context, opts: RecallOptions): Promise<RecallResult> {
  assertScopeRequestAllowed(ctx.actor, opts.filter?.scope);
  const windowSize = recallWindowSize(opts.window);
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

/** The MCP ranker: ranks the whole scoped store, hands the ranking to `show`, and audits, strengthens and traces the
 * ids `show` returns. `results` stays the top window of that ranking. `recordAs` is not read here. */
export async function retrieveRanking(ctx: Context, opts: RecallOptions, show: ShowRanking): Promise<RecallResult> {
  assertScopeRequestAllowed(ctx.actor, opts.filter?.scope);
  const windowSize = recallWindowSize(opts.window);
  const personalScope = personalScopeOf(ctx.actor) ?? undefined;
  const whole = await rankWholeStore(ctx, opts, windowSize, personalScope);
  // The caller traces and audits the rows it shows, so the window writes neither.
  const windowOpts = { ...opts, trace: { ...opts.trace, suppressRecallTrace: true } };
  const plan = planRecall(ctx, windowOpts, whole.window, personalScope);
  const reads = await readRecall(ctx, windowOpts, plan, whole.goals);
  const composed = composeRecall(ctx, windowOpts, {
    windowSize,
    all: whole.window,
    plan,
    reads,
    auditWindow: false,
  });
  await finishShownRecall(ctx, opts, { show, ranking: whole.ranking, goalLog: whole.goalLog }, composed);
  return composed.result;
}

/** What `retrieve` records: the rows it returns, and the continuity block the reply carries beside them. */
function returnedList(opts: RecallOptions, result: RecallResult): ShownList {
  return {
    query: opts.query,
    sessionId: opts.boost?.sessionId,
    topId: result.results[0]?.id ?? null,
    anchoredOn: result.anchoringHint?.memoryId,
    items: result.results.length,
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
  const candidates = await lexicalWindow(ctx, opts, windowSize, personalScope);
  const plan = planRecall(ctx, opts, candidates, personalScope);
  const reads = await readRecall(ctx, opts, plan);
  const composed = composeRecall(ctx, opts, { windowSize, all: candidates, plan, reads });
  await finishRecall(
    ctx,
    opts,
    composed.writes,
    composed.result.results.map((r) => r.id),
  );
  return composed.result;
}

/** The SQL BM25 window, reordered by hybrid or physics search when `mode` asks. */
async function lexicalWindow(
  ctx: Context,
  opts: RecallOptions,
  windowSize: number,
  personalScope: string | undefined,
): Promise<MemoryEntry[]> {
  const candidates = await ctx.store.searchRecallEntries(
    opts.query,
    recallSearchArgs(ctx, opts, windowSize, personalScope),
  );
  if (opts.mode !== 'hybrid' && opts.mode !== 'physics') return candidates;
  const ranked = await rankByEngine(ctx, opts, candidates, {
    budget: Infinity,
    scope: opts.filter?.scope ?? null,
    vectorCandidates: recallVectorSpec(ctx, opts, personalScope),
  });
  return withMissing(
    ranked.map((r) => r.entry),
    candidates,
  );
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

/** `mode` names the engine: physics with the store's config, hybrid otherwise. */
function physicsFor(ctx: Context, opts: RecallOptions): PhysicsConfig | null {
  return opts.mode === 'physics' ? ctx.config.physics : null;
}

/** Ranks `pool` with the engine `mode` names, over the store's vector arm. */
function rankByEngine(
  ctx: Context,
  opts: RecallOptions,
  pool: MemoryEntry[],
  searchOpts: EngineSearchOptions,
): Promise<RankedResults> {
  const source = vectorSourceOf({ store: ctx.store, config: ctx.config, onHippoDb: ctx.reach?.isHippoDb });
  return searchByEngine(source, opts.query, pool, physicsFor(ctx, opts), searchOpts);
}

/** `first`, then the rows of `second` that `first` does not hold. */
function withMissing(first: MemoryEntry[], second: MemoryEntry[]): MemoryEntry[] {
  const held = new Set(first.map((e) => e.id));
  return [...first, ...second.filter((e) => !held.has(e.id))];
}

/** The recall load's arguments: exact scope, current rows only, the caller's project and personal scope. */
function recallSearchArgs(
  ctx: Context,
  opts: RecallOptions,
  limit: number,
  personalScope: string | undefined,
): RecallSearchArgs {
  return {
    limit,
    tenantId: ctx.tenantId,
    requestedScope: opts.filter?.scope,
    explicitScopeMode: 'exact',
    includeSuperseded: false,
    originProjects: recallOrigin(opts),
    ownScope: personalScope,
  };
}

/** api.retrieve's vector arm: the recall load's exact-scope rule, current rows only. */
function recallVectorSpec(
  ctx: Context,
  opts: RecallOptions,
  personalScope: string | undefined,
): HybridVectorCandidates {
  return {
    tenantId: ctx.tenantId,
    scope: recallScopeFilter(opts.filter?.scope, 'exact', personalScope),
    includeSuperseded: false,
    origin: recallOrigin(opts),
    admit: (e) => passesScopeFilterForRecall(e.scope ?? null, opts.filter?.scope, personalScope),
  };
}

/** The ranking `retrieveRanking` ranks, with the window planned from it and the goals its boost read. */
interface WholeStoreRanking {
  readonly window: MemoryEntry[];
  readonly goals: ActiveGoals | null;
  readonly ranking: StoreRanking;
  readonly goalLog: GoalRecallLogRow[];
}

/** Physics when `mode` says so, hybrid otherwise, over a wide lexical window plus the nearest vectors, goal boost
 * applied; the window is the top `windowSize` rows of that ranking. */
async function rankWholeStore(
  ctx: Context,
  opts: RecallOptions,
  windowSize: number,
  personalScope: string | undefined,
): Promise<WholeStoreRanking> {
  const loaded = await ctx.store.searchRecallEntries(
    opts.query,
    recallSearchArgs(ctx, opts, Math.max(windowSize, WHOLE_STORE_LEXICAL_WINDOW), personalScope),
  );
  const pool = loaded.filter((e) => passesScopeFilterForRecall(e.scope ?? null, opts.filter?.scope, personalScope));
  // No scope option: the scope boost follows HIPPO_SCOPE and the skill env, as MCP recall always ranked.
  const searched = await rankByEngine(ctx, opts, pool, {
    budget: Infinity,
    vectorCandidates: recallVectorSpec(ctx, opts, personalScope),
  });
  const { ranked, goals, rankedLog } = await boostRankedByGoals(ctx, opts, searched);
  const ranking = {
    ranked,
    pool: withMissing(
      pool,
      ranked.map((r) => r.entry),
    ),
    droppedByScope: loaded.length - pool.length,
  };
  return { window: ranked.slice(0, windowSize).map((r) => r.entry), goals, ranking, goalLog: rankedLog };
}

/** What the caller cuts its list from: its presenter, the whole-store ranking and the goal log rows it earned. */
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
): Promise<void> {
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
}

// One goal read serves both boosts; the ranked list's log rows come first, so its scores win the log's first-write.
async function boostRankedByGoals(ctx: Context, opts: RecallOptions, ranked: RankedResults) {
  const noLog: GoalRecallLogRow[] = [];
  const { sessionId, goalTag } = opts.boost ?? {};
  const goals = sessionId && !goalTag ? await ctx.store.activeGoals({ sessionId, tenantId: ctx.tenantId }) : null;
  if (!goals || !sessionId) return { ranked, goals, rankedLog: noLog };
  const boost = boostByGoals(ranked, goals, {
    sessionId,
    tenantId: ctx.tenantId,
    limit: ranked.length,
  });
  return { ranked: boost.results, goals, rankedLog: boost.log };
}

function shownAuditAndTrace(ctx: Context, opts: RecallOptions, shownIds: readonly string[], ranked: RankedResults) {
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
function recallWindowSize(window: RecallWindowOptions = {}): number {
  const { scorerWindow } = window;
  // Throw before the first store read, so a bad window never opens or migrates the store.
  // The consumer site at `if (freshTailCount > 0)` does NOT re-validate.
  const freshTailCountPreflight = window.freshTailCount ?? 0;
  if (freshTailCountPreflight > 0 && !window.freshTailSessionId && envRequireSessionScopedFreshTail()) {
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
