// Read path: recall (sync) and retrieve (async, adds the vector arm).

import { envRequireSessionScopedFreshTail } from '../env.js';
import { DEFAULT_SEARCH_CANDIDATE_LIMIT } from '../store/rows.js';
import { loadEntriesByIds, loadFreshRawMemories } from '../store/entry-reads.js';
import { loadRecallSearchEntries, recallScopeFilter } from '../store/search-rows.js';
import type { ContinuityKey } from '../store/sessions.js';
import { estimateTokens } from '../token-ledger.js';
import { formatHandoffEvidenceLine } from '../handoff.js';
import type { MemoryEntry } from '../memory.js';
import type { RecallTraceInput } from '../store/recall-trace.js';
import { activeGoalsWithPolicies, boostByGoals, type ActiveGoals, type GoalRecallLogRow, type GoalStackBoostOpts } from '../store/goals.js';
import type { ForwardClaimMatch } from '../forward-claim-detector.js';
import { continuityAt, finishRecallAt, storeFor, type HippoStore, type RecallSearchArgs, type RecallWrites } from '../store-port.js';
import { hybridSearch } from '../search/hybrid.js';
import { physicsSearch } from '../search/physics-search.js';
import { churnStaleFactor } from '../search/boosts.js';
import type { HybridVectorCandidates } from '../search/vector.js';
import type { RerankStep } from '../core/search-types.js';
import { compareEntryIdentity } from '../compare.js';
import { dropHeldCopies, duplicateKey, storedTextKeys } from '../same-text.js';
import { isSharedStore, loadConfig } from '../config.js';
import { classifyOriginProject, projectNames } from '../project-identity.js';
import { decidePlanningFallacy, detectPlanningClaim } from '../predictions/planning-fallacy.js';
import { planningFallacyEvidenceAt, type PlanningFallacyEvidence } from '../store/planning-fallacy-evidence.js';
import { detectAnchoring, hashQueryText, biasHintEnabled, type AnchoringHint } from '../recall-history.js';
import { detectAvailabilityBias, type AvailabilityHint } from '../availability.js';
import { passesScopeFilterForRecall, assertScopeRequestAllowed, personalScopeOf } from '../recall-scope.js';
import type { RecallSuppressionSummary, RecallOpts, RecallResult, RecallResultItem, ContinuityBlock } from './recall-types.js';
import { type Context, ownerOrSubject, RecallContractError } from './types.js';
import { anchoringRows, availabilityRows, callerOf, recallAuditMetadata, recallAuditRow, strengthenOf } from './recall-record.js';
import { retrieveWithCliCore } from './recall-core.js';

/**
 * Shared construction helper for `RecallSuppressionSummary`. Used by
 * `api.recall`, `cmdRecall`, and the MCP `hippo_recall` handler so all three
 * pipelines produce the same shape without duplicating field-construction
 * logic. Pass-through identity today; kept as a helper so future field
 * additions land at one site.
 */
export function buildSuppressionSummary(counts: {
  totalCandidates: number;
  droppedPreRank: number;
  droppedByBudget: number;
  summarySubstitutionsAdded: number;
  freshTailAdded: number;
  suppressedByInterference: number;
}): RecallSuppressionSummary {
  return {
    totalCandidates: counts.totalCandidates,
    droppedPreRank: counts.droppedPreRank,
    droppedByBudget: counts.droppedByBudget,
    summarySubstitutionsAdded: counts.summarySubstitutionsAdded,
    freshTailAdded: counts.freshTailAdded,
    suppressedByInterference: counts.suppressedByInterference,
  };
}

/**
 * Domain-level recall on hippo.db only, never `ctx.store`, since it is synchronous: under another store its first open throws
 * `SqliteBlockedError`. Loads BM25-ranked candidates from SQLite scoped to
 * `ctx.tenantId` and keeps that order whatever `mode` says; `retrieve` is the
 * mode-aware, strengthening variant the HTTP route uses.
 *
 * **api.recall does NOT mutate `index.last_retrieval_ids`** (contract
 * lock). The CLI `cmdRecall` (cli.ts) writes `last_retrieval_ids` because the
 * CLI is interactive (user is about to run `hippo outcome --good`). SDK callers
 * are programmatic: they either pass explicit ids to `api.outcome` or call
 * `api.getContext` first for the context-then-outcome workflow (getContext
 * DOES write `last_retrieval_ids`). Adding the side-effect here would change
 * `api.recall` from a pure read into a read+write, breaking SDK callers who
 * batch recall calls in a row. Locked by
 * `tests/api-recall-no-side-effects.test.ts`.
 */
export function recall(ctx: Context, opts: RecallOpts): RecallResult {
  // A member key may not unlock a private or quarantined scope by naming it.
  assertScopeRequestAllowed(ctx.actor, opts.scope);
  const windowSize = recallWindowSize(opts);
  const own = personalScopeOf(ctx.actor) ?? undefined;
  const all = loadRecallSearchEntries(ctx.hippoRoot, opts.query, windowSize, ctx.tenantId, opts.scope, 'exact', false, recallOrigin(opts), own);
  const plan = planRecall(ctx, opts, all, own);
  const { result, writes } = composeRecall(ctx, opts, { windowSize, all, plan, reads: readRecallSync(ctx, opts, plan) });
  finishRecallAt(ctx.hippoRoot, { ...writes, audit: [...(opts.leadingAudit ?? []), ...writes.audit] });
  return result;
}

function recallOrigin(opts: RecallOpts): readonly string[] | undefined {
  return opts.project ? projectNames(opts.project) : undefined;
}

function inCallerProject(entry: MemoryEntry, opts: RecallOpts): boolean {
  return !opts.project || classifyOriginProject(entry.origin_project, opts.project) !== 'cross-project';
}

/** The one recall entry: ranks with the ranker `opts` names, then writes the recall. Only the CLI core ranker writes last_retrieval_ids (contract lock). */
export async function retrieve(ctx: Context, opts: RecallOpts): Promise<RecallResult> {
  assertScopeRequestAllowed(ctx.actor, opts.scope);
  if (opts.cliCore) return retrieveWithCliCore(ctx, opts, opts.cliCore);
  const windowSize = recallWindowSize(opts);
  // From the authenticated actor, never from RecallOpts, which a caller fills in.
  const own = personalScopeOf(ctx.actor) ?? undefined;
  if (opts.showRanked) return retrieveFromStore(ctx, opts, windowSize, opts.showRanked, own);
  const store = storeFor(ctx);
  let candidates = await store.searchRecallEntries(opts.query, recallSearchArgs(ctx, opts, windowSize, own));
  if (opts.mode === 'hybrid' || opts.mode === 'physics') {
    const searchOpts = { budget: Infinity, hippoRoot: ctx.hippoRoot, scope: opts.scope ?? null, vectorCandidates: recallVectorSpec(ctx, opts, own), store };
    const ranked = opts.mode === 'physics'
      ? await physicsSearch(opts.query, candidates, { ...searchOpts, physicsConfig: loadConfig(ctx.hippoRoot).physics })
      : await hybridSearch(opts.query, candidates, searchOpts);
    const rankedIds = new Set(ranked.map((r) => r.entry.id));
    candidates = [...ranked.map((r) => r.entry), ...candidates.filter((e) => !rankedIds.has(e.id))];
  }
  const plan = planRecall(ctx, opts, candidates, own);
  const { result, writes } = composeRecall(ctx, opts, { windowSize, all: candidates, plan, reads: await readRecall(store, ctx, opts, plan) });
  await store.finishRecall({ ...writes, audit: [...(opts.leadingAudit ?? []), ...writes.audit], strengthen: strengthenOf(ctx, result.results.map((r) => r.id)) });
  return result;
}

/** The recall load's arguments: exact scope, current rows only, the caller's project and personal scope. */
function recallSearchArgs(ctx: Context, opts: RecallOpts, limit: number, own: string | undefined): RecallSearchArgs {
  return {
    limit,
    tenantId: ctx.tenantId,
    requestedScope: opts.scope,
    explicitScopeMode: 'exact',
    includeSuperseded: false,
    originProjects: recallOrigin(opts),
    ownScope: own,
  };
}

/** api.retrieve's vector arm: the recall load's exact-scope rule, current rows only. */
function recallVectorSpec(ctx: Context, opts: RecallOpts, own: string | undefined): HybridVectorCandidates {
  return {
    tenantId: ctx.tenantId,
    scope: recallScopeFilter(opts.scope, 'exact', own),
    includeSuperseded: false,
    origin: recallOrigin(opts),
    admit: (e) => passesScopeFilterForRecall(e.scope ?? null, opts.scope, own),
  };
}

// Tag, pin and recency boosts can lift a row from deep in the BM25 order, so MCP ranks a wide lexical window.
const SHOW_RANKED_LEXICAL_WINDOW = 1000;

/** `retrieve` under `showRanked`: physics when `mode` says so, hybrid otherwise, over a wide lexical window plus the nearest vectors. */
async function retrieveFromStore(
  ctx: Context,
  opts: RecallOpts,
  windowSize: number,
  show: NonNullable<RecallOpts['showRanked']>,
  own: string | undefined,
): Promise<RecallResult> {
  const store = storeFor(ctx);
  const loaded = await store.searchRecallEntries(opts.query, recallSearchArgs(ctx, opts, Math.max(windowSize, SHOW_RANKED_LEXICAL_WINDOW), own));
  const pool = loaded.filter((e) => passesScopeFilterForRecall(e.scope ?? null, opts.scope, own));
  // No scope option: the scope boost follows HIPPO_SCOPE and the skill env, as MCP recall always ranked.
  const searchOpts = { budget: Infinity, hippoRoot: ctx.hippoRoot, vectorCandidates: recallVectorSpec(ctx, opts, own), store };
  let ranked = opts.mode === 'physics'
    ? await physicsSearch(opts.query, pool, { ...searchOpts, physicsConfig: loadConfig(ctx.hippoRoot).physics })
    : await hybridSearch(opts.query, pool, searchOpts);
  // One goal read serves both boosts; the ranked list's log rows come first, so its scores win the log's first-write.
  const goals = opts.sessionId && !opts.goalTag ? await store.activeGoals({ sessionId: opts.sessionId, tenantId: ctx.tenantId }) : null;
  let rankedLog: GoalRecallLogRow[] = [];
  if (goals && opts.sessionId) {
    const boost = boostByGoals(ranked, goals, { sessionId: opts.sessionId, tenantId: ctx.tenantId, limit: ranked.length });
    ranked = boost.results;
    rankedLog = boost.log;
  }
  const window = ranked.slice(0, windowSize).map((r) => r.entry);
  const bandOpts = { ...opts, suppressRecallTrace: true };
  const plan = planRecall(ctx, bandOpts, window, own);
  const { result, writes } = composeRecall(ctx, bandOpts, { windowSize, all: window, plan, reads: await readRecall(store, ctx, bandOpts, plan, goals), auditBand: false });
  // Rows the vector arm added count as candidates too.
  const inPool = new Set(pool.map((e) => e.id));
  const candidates = [...pool, ...ranked.map((r) => r.entry).filter((e) => !inPool.has(e.id))];
  const shown = show({ ranked, pool: candidates, droppedByScope: loaded.length - pool.length }, result);
  const scores = new Map(ranked.map((r) => [r.entry.id, r.score]));
  const shownRow = recallAuditRow(callerOf(ctx), 'recall', undefined, recallAuditMetadata(opts.query, shown.ids.length));
  await store.finishRecall({
    goalLog: [...rankedLog, ...writes.goalLog],
    audit: [...(opts.leadingAudit ?? []), ...writes.audit, shownRow, ...shown.audit],
    trace: opts.suppressRecallTrace ? undefined : {
      tenantId: ctx.tenantId,
      sessionId: opts.sessionId ?? null,
      pipeline: 'mcp',
      query: opts.query,
      results: shown.ids.map((id) => ({ memoryId: id, score: scores.get(id) ?? 0 })),
    },
    strengthen: strengthenOf(ctx, shown.ids),
  });
  return result;
}

/** Contract preflight: throws before any store-touching work. */
function recallWindowSize(opts: RecallOpts): number {
  // Throw before loadSearchEntries, which runs initStore and migrates legacy state on first call.
  // The consumer site at `if (freshTailCount > 0)` does NOT re-validate.
  const freshTailCountPreflight = opts.freshTailCount ?? 0;
  if (
    freshTailCountPreflight > 0 &&
    !opts.freshTailSessionId &&
    envRequireSessionScopedFreshTail()
  ) {
    throw new RecallContractError(
      'fresh_tail_requires_session_id',
      'fresh-tail requires a session id when HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL=1; ' +
        'pass opts.freshTailSessionId or unset the env to allow tenant-wide fresh-tail.',
    );
  }
  // Undefined keeps the store default: defaulting to `limit` would shrink the pool and kill overflow summaries.
  // 0 would reach FTS/LIKE LIMIT 0 and then an uncapped full-store fallback, so non-positive values throw.
  if (opts.scorerWindow !== undefined) {
    if (
      !Number.isFinite(opts.scorerWindow) ||
      !Number.isInteger(opts.scorerWindow) ||
      opts.scorerWindow < 1
    ) {
      throw new RecallContractError(
        'invalid_scorer_window',
        `scorerWindow must be a positive integer; got ${opts.scorerWindow}`,
      );
    }
  }
  return opts.scorerWindow ?? DEFAULT_SEARCH_CANDIDATE_LIMIT;
}

/** The scope-admitted candidates in churn order, and the top `limit` of them. */
interface CandidateWindow {
  entries: MemoryEntry[];
  baseSlice: MemoryEntry[];
  droppedPreRank: number;
  droppedByBudget: number;
}

/** What a recall reads once its candidates are known, worked out first so the reads can go to hippo.db or the port. */
interface RecallPlan {
  limit: number;
  window: CandidateWindow;
  /** The caller's personal scope, from the authenticated actor. */
  own: string | undefined;
  /** Set when a session and no explicit goal tag ask for the goal-stack boost. */
  goalBoost: GoalStackBoostOpts | null;
  /** Overflowed children by summary parent, for the parents that may stand in for them; read only when not empty. */
  overflow: Map<string, MemoryEntry[]>;
  claim: ForwardClaimMatch | null;
}

/** The rows a plan asked for; each is empty or null when the plan did not ask. */
interface RecallReads {
  goals: ActiveGoals | null;
  parents: MemoryEntry[];
  freshRaws: MemoryEntry[];
  continuity: ContinuityBlock | undefined;
  planning: PlanningFallacyEvidence | null;
}

/** The bands recall returns, plus the counts the suppression summary reports and the goal log rows the boost earned. */
interface RankedBands {
  rankedOut: RecallResultItem[];
  baseSlice: MemoryEntry[];
  heldDropped: number;
  summarySubstitutions: number;
  freshTailAdded: number;
  goalLog: GoalRecallLogRow[];
}

interface AnchoringOutcome {
  anchoringHint: AnchoringHint | null;
  suppressedByInterference: number;
}

/** The reply, and the rows the store writes once it is composed. */
interface ComposedRecall {
  result: RecallResult;
  writes: RecallWrites;
}

type ScoredEntry = { entry: MemoryEntry; score: number };
type SummaryDecoration = { entry: MemoryEntry; childIds: string[] };

const CONTINUITY_EVENT_LIMIT = 5;

function planRecall(ctx: Context, opts: RecallOpts, all: MemoryEntry[], own: string | undefined): RecallPlan {
  const limit = opts.limit ?? 10;
  const window = admitCandidates(opts, all, limit, own);
  return {
    limit,
    window,
    own,
    goalBoost: opts.sessionId && !opts.goalTag ? { sessionId: opts.sessionId, tenantId: ctx.tenantId, limit } : null,
    overflow: (opts.summarizeOverflow ?? true) && window.entries.length > limit ? overflowGroups(window, limit) : new Map(),
    claim: detectPlanningClaim(opts.query),
  };
}

/** The plan's reads on hippo.db directly, for the synchronous recall that cannot await the port. */
function readRecallSync(ctx: Context, opts: RecallOpts, plan: RecallPlan): RecallReads {
  const { hippoRoot, tenantId } = ctx;
  const freshCount = opts.freshTailCount ?? 0;
  return {
    goals: plan.goalBoost ? activeGoalsWithPolicies(hippoRoot, { sessionId: plan.goalBoost.sessionId, tenantId }) : null,
    parents: plan.overflow.size > 0 ? loadEntriesByIds(hippoRoot, [...plan.overflow.keys()], tenantId) : [],
    freshRaws: freshCount > 0 ? loadFreshRawMemories(hippoRoot, freshCount, tenantId, opts.freshTailSessionId, recallOrigin(opts)) : [],
    continuity: opts.includeContinuity ? continuityAt(hippoRoot, tenantId, CONTINUITY_EVENT_LIMIT, continuityKey(ctx, opts)) : undefined,
    planning: plan.claim ? planningFallacyEvidenceAt(hippoRoot, tenantId, plan.claim.classQueryTokens) : null,
  };
}

/** The plan's reads through the store; `goals` already read by the caller skips that read. */
async function readRecall(store: HippoStore, ctx: Context, opts: RecallOpts, plan: RecallPlan, goals?: ActiveGoals | null): Promise<RecallReads> {
  const { tenantId } = ctx;
  const freshCount = opts.freshTailCount ?? 0;
  return {
    goals: goals !== undefined ? goals : plan.goalBoost ? await store.activeGoals({ sessionId: plan.goalBoost.sessionId, tenantId }) : null,
    parents: plan.overflow.size > 0 ? await store.entriesByIds([...plan.overflow.keys()], tenantId) : [],
    freshRaws: freshCount > 0 ? await store.freshRawEntries(freshCount, tenantId, opts.freshTailSessionId, recallOrigin(opts) ?? null) : [],
    continuity: opts.includeContinuity ? await store.continuity(tenantId, CONTINUITY_EVENT_LIMIT, continuityKey(ctx, opts)) : undefined,
    planning: plan.claim ? await store.planningFallacyEvidence(tenantId, plan.claim.classQueryTokens) : null,
  };
}

// On a shared store the tenant's newest row is another developer's; no project keys to nothing, so the block is empty.
function continuityKey(ctx: Context, opts: RecallOpts): ContinuityKey | null {
  if (!isSharedStore(ctx.hippoRoot)) return null;
  return { owner: ownerOrSubject(ctx.actor), project: opts.project ? projectNames(opts.project) : [] };
}

/** The reply and the rows it writes, from the candidates and the plan's reads; touches no store.
 *  `auditBand` false: the caller shows a cut of the band and audits the rows it shows. */
interface ComposeRecallOptions {
  readonly windowSize: number;
  readonly all: MemoryEntry[];
  readonly plan: RecallPlan;
  readonly reads: RecallReads;
  readonly auditBand?: boolean;
}

function composeRecall(ctx: Context, opts: RecallOpts, options: ComposeRecallOptions): ComposedRecall {
  const { windowSize, all, plan, reads, auditBand = true } = options;
  const { window } = plan;
  const bands = rankBands(opts, plan, reads);
  const rankedOut = bands.rankedOut;
  const continuity = reads.continuity ? scopeContinuity(reads.continuity, opts, plan.own) : undefined;
  // Query-derived, so MCP and CLI read this one hint instead of recomputing; HIPPO_AUTODEBIAS=off disables it.
  const planning = plan.claim && reads.planning ? decidePlanningFallacy(plan.claim, reads.planning, ctx.tenantId, ctx.actor.subject) : null;
  const { anchoringHint, suppressedByInterference } = detectRecallAnchoring(opts, rankedOut[0]?.id ?? null);
  const availabilityHint = detectRecallAvailability(opts, bands.baseSlice, window.entries);

  const result: RecallResult = {
    results: rankedOut,
    total: window.entries.length,
    tokens: rankedOut.reduce((acc, r) => acc + estimateTokens(r.content), 0),
    continuity,
    continuityTokens: continuity ? continuityTokensOf(continuity) : undefined,
    windowSize,
    suppressionSummary: buildSuppressionSummary({
      totalCandidates: all.length,
      droppedPreRank: window.droppedPreRank + bands.heldDropped,
      droppedByBudget: window.droppedByBudget,
      summarySubstitutionsAdded: bands.summarySubstitutions,
      freshTailAdded: bands.freshTailAdded,
      suppressedByInterference,
    }),
  };
  // The hint and the no-class-match / tiebreak watching variant are mutually exclusive; both go out as optional fields.
  if (planning?.output.hint) result.planningFallacyHint = planning.output.hint;
  if (planning?.output.watching) result.planningFallacyWatching = planning.output.watching;
  if (anchoringHint) result.anchoringHint = anchoringHint;
  if (availabilityHint) result.availabilityHint = availabilityHint;

  const who = callerOf(ctx);
  const audit = auditBand ? [recallAuditRow(who, 'recall', undefined, recallAuditMetadata(opts.query, rankedOut.length))] : [];
  if (planning?.audit) audit.push(planning.audit);
  audit.push(...anchoringRows(who, anchoringHint), ...availabilityRows(who, availabilityHint));
  return { result, writes: { goalLog: bands.goalLog, audit, trace: recallTrace(ctx, opts, rankedOut) } };
}

// The SQL load already applied tenant and scope; any recall-mode loader must go through loadRecallSearchEntries.
function admitCandidates(opts: RecallOpts, all: MemoryEntry[], limit: number, own: string | undefined): CandidateWindow {
  const current = all.filter((e) => !e.superseded_by);
  let entries: typeof all;
  if (opts.scope !== undefined && opts.scope !== '') {
    // SQL already exact-matched; the JS filter is defense-in-depth against a SQL-clause regression.
    entries = current.filter((e) => e.scope === opts.scope);
  } else {
    // SQL pre-filtered ':private:' loosely before the window; this is the exact anchored `<source>:private:*` rule.
    entries = current.filter((e) => passesScopeFilterForRecall(e.scope ?? null, undefined, own));
  }
  const droppedPreRank = all.length - entries.length;
  entries = entries
    .map((e, i) => ({ e, s: (1 - i / entries.length) * churnStaleFactor(e) }))
    .sort((a, b) => b.s - a.s)
    .map((r) => r.e);
  // BM25 ordering already comes from loadRecallSearchEntries; cap to `limit`.
  const baseSlice = entries.slice(0, limit);
  return { entries, baseSlice, droppedPreRank, droppedByBudget: entries.length - baseSlice.length };
}

// The goal-stack boost touches the primary band only; the fresh-tail and summary bands keep their fixed placement.
function rankBands(opts: RecallOpts, plan: RecallPlan, reads: RecallReads): RankedBands {
  const { window, limit, own } = plan;
  let baseScored: ScoredEntry[] = window.baseSlice.map((entry, idx) => ({
    entry,
    score: Math.max(0, 1 - idx / Math.max(1, limit)),
  }));
  // Allocated only under explain, so the boost's default-path math stays byte-identical.
  const explainTrace = opts.explain ? new Map<string, RerankStep>() : undefined;
  let goalLog: GoalRecallLogRow[] = [];
  if (plan.goalBoost && reads.goals) {
    const boost = boostByGoals(baseScored, reads.goals, { ...plan.goalBoost, trace: explainTrace });
    baseScored = boost.results;
    goalLog = boost.log;
  }
  let substituted = substituteOverflow(opts, plan.overflow, reads.parents, limit, own);
  let heldDropped = 0;
  if (!opts.keepHeldCopies) {
    const shownIds = new Set(dropHeldCopies([...baseScored.map((r) => r.entry), ...substituted.map((s) => s.entry)], (e) => e).map((e) => e.id));
    heldDropped = baseScored.filter((r) => !shownIds.has(r.entry.id)).length;
    baseScored = baseScored.filter((r) => shownIds.has(r.entry.id));
    substituted = substituted.filter((s) => shownIds.has(s.entry.id));
  }
  const baseSlice = baseScored.map((r) => r.entry);
  const baseRanked = baseScored.map((r) => baseItem(r, opts, explainTrace));
  const summaryRanked = substituted.map((s) => summaryItem(s, opts));
  const freshRanked = (opts.freshTailCount ?? 0) > 0
    ? freshTailBand(opts, {
        recent: reads.freshRaws, baseRanked, summaryRanked, shownEntries: opts.keepHeldCopies ? [] : [...baseSlice, ...substituted.map((s) => s.entry)], own,
      })
    : [];
  return {
    rankedOut: [...freshRanked, ...baseRanked, ...summaryRanked],
    baseSlice,
    heldDropped,
    summarySubstitutions: substituted.length,
    freshTailAdded: freshRanked.length,
    goalLog,
  };
}

// When the overflow holds 2+ children of one level-2 summary, that summary stands in for them, capped at 30% of
// `limit`. Each one is tenant-scoped and re-checked against the scope filter; drillDown recovers the children.
function substituteOverflow(
  opts: RecallOpts,
  overflowByParent: Map<string, MemoryEntry[]>,
  parents: MemoryEntry[],
  limit: number,
  own: string | undefined,
): SummaryDecoration[] {
  const eligibleParents = parents.filter(
    (p) => (p.dag_level ?? 0) === 2 && !p.superseded_by && passesScopeFilterForRecall(p.scope ?? null, opts.scope, own) && inCallerProject(p, opts),
  );
  const maxSub = Math.max(1, Math.ceil(limit * SUMMARY_SUB_FRACTION));
  // Most overflowed children first; compareEntryIdentity only breaks a tie, which used to fall to scan order.
  eligibleParents.sort((a, b) => {
    const ac = overflowByParent.get(a.id)?.length ?? 0;
    const bc = overflowByParent.get(b.id)?.length ?? 0;
    return bc !== ac ? bc - ac : compareEntryIdentity(a, b);
  });
  return eligibleParents.slice(0, maxSub).map((p) => ({
    entry: p,
    childIds: (overflowByParent.get(p.id) ?? []).map((e) => e.id),
  }));
}

/** Overflowed leaf rows by summary parent, kept only for a parent with 2+ of them that is not already in the base band. */
function overflowGroups(window: CandidateWindow, limit: number): Map<string, MemoryEntry[]> {
  // The goal boost only re-scores the base band, so its ids are known before the boost runs.
  const baseIds = new Set(window.baseSlice.map((e) => e.id));
  const overflowByParent = new Map<string, MemoryEntry[]>();
  for (const e of window.entries.slice(limit)) {
    const parentId = e.dag_parent_id;
    if (!parentId) continue;
    if ((e.dag_level ?? 0) > 1) continue;
    const list = overflowByParent.get(parentId) ?? [];
    list.push(e);
    overflowByParent.set(parentId, list);
  }
  return new Map([...overflowByParent].filter(([pid, children]) => children.length >= 2 && !baseIds.has(pid)));
}

function baseItem(r: ScoredEntry, opts: RecallOpts, explainTrace: Map<string, RerankStep> | undefined): RecallResultItem {
  const item: RecallResultItem = {
    id: r.entry.id,
    content: r.entry.content,
    score: r.score,
    layer: r.entry.layer,
    strength: r.entry.strength,
  };
  // Only this band passes through the goal boost, so only it can carry a rerank step.
  if (opts.explain) {
    item.rerankPipeline = 'api';
    const step = explainTrace?.get(r.entry.id);
    if (step) item.rerankTrace = [step];
  }
  return item;
}

// A summary scores below the strong top-N matches but above the weakest leaves.
const SUMMARY_ITEM_SCORE = 0.5;
const FRESH_TAIL_ITEM_SCORE = 1.0;
// Summaries may take this share of the limit.
const SUMMARY_SUB_FRACTION = 0.3;

function summaryItem(s: SummaryDecoration, opts: RecallOpts): RecallResultItem {
  const item: RecallResultItem = {
    id: s.entry.id,
    content: s.entry.content,
    score: SUMMARY_ITEM_SCORE,
    layer: s.entry.layer,
    strength: s.entry.strength,
    isSummary: true,
    substitutedFor: s.childIds,
    descendantCount: s.entry.descendant_count ?? s.childIds.length,
  };
  if (opts.explain) item.rerankPipeline = 'api';
  return item;
}

// The last N raw rows, so "what did I just see" always covers the recent window. A recent row already in the BM25
// band is only tagged isFreshTail; new ones are prepended, so every recent row appears exactly once.
interface FreshTailBandOptions {
  readonly recent: MemoryEntry[];
  readonly baseRanked: RecallResultItem[];
  readonly summaryRanked: RecallResultItem[];
  readonly shownEntries: MemoryEntry[];
  readonly own: string | undefined;
}

function freshTailBand(opts: RecallOpts, options: FreshTailBandOptions): RecallResultItem[] {
  const { recent, baseRanked, summaryRanked, shownEntries, own } = options;
  const recentScoped = recent.filter((m) => passesScopeFilterForRecall(m.scope ?? null, opts.scope, own) && inCallerProject(m, opts));
  const recentIdSet = new Set(recentScoped.map((m) => m.id));
  for (const r of baseRanked) {
    if (recentIdSet.has(r.id)) r.isFreshTail = true;
  }
  const seenIds = new Set([...baseRanked.map((r) => r.id), ...summaryRanked.map((r) => r.id)]);
  const shownKeys = storedTextKeys(shownEntries);
  const freshRanked: RecallResultItem[] = [];
  for (const m of recentScoped) {
    if (seenIds.has(m.id) || shownKeys.has(duplicateKey(m.content))) continue;
    shownKeys.add(duplicateKey(m.content));
    const item: RecallResultItem = {
      id: m.id,
      content: m.content,
      score: FRESH_TAIL_ITEM_SCORE,
      layer: m.layer,
      strength: m.strength,
      isFreshTail: true,
    };
    if (opts.explain) item.rerankPipeline = 'api';
    freshRanked.push(item);
    seenIds.add(m.id);
  }
  return freshRanked;
}

// The trace is observability, not retrieval state; a caller that traces its own result set suppresses it.
function recallTrace(ctx: Context, opts: RecallOpts, rankedOut: RecallResultItem[]): RecallTraceInput | undefined {
  if (opts.suppressRecallTrace) return undefined;
  return {
    tenantId: ctx.tenantId,
    sessionId: opts.sessionId ?? null,
    pipeline: 'api',
    query: opts.query,
    explainMode: opts.explain === true,
    results: rankedOut.map((r) => ({
      memoryId: r.id,
      score: r.score,
      rerankSteps: r.rerankTrace,
    })),
  };
}

// The memory-recall scope rule: an explicit scope must match exactly; without one, private and legacy rows are denied.
function scopeContinuity(block: ContinuityBlock, opts: RecallOpts, own: string | undefined): ContinuityBlock {
  const rowScope = (
    r: { scope?: string | null } | null | undefined,
  ): string | null => r?.scope ?? null;
  const { activeSnapshot: snapshot, sessionHandoff } = block;
  return {
    activeSnapshot: snapshot && passesScopeFilterForRecall(rowScope(snapshot), opts.scope, own) ? snapshot : null,
    sessionHandoff: sessionHandoff && passesScopeFilterForRecall(rowScope(sessionHandoff), opts.scope, own) ? sessionHandoff : null,
    recentSessionEvents: block.recentSessionEvents.filter((e) => passesScopeFilterForRecall(rowScope(e), opts.scope, own)),
  };
}

function continuityTokensOf(c: ContinuityBlock): number {
  const filteredSnapshot = c.activeSnapshot;
  const filteredHandoff = c.sessionHandoff;
  const tokenize = (s?: string | null): number =>
    s ? estimateTokens(s) : 0;
  return tokenize(filteredSnapshot?.task) +
    tokenize(filteredSnapshot?.summary) +
    tokenize(filteredSnapshot?.next_step) +
    tokenize(filteredHandoff?.summary) +
    tokenize(filteredHandoff?.nextAction) +
    (filteredHandoff?.artifacts ?? []).reduce((acc, a) => acc + tokenize(a), 0) +
    (filteredHandoff?.constraints ?? []).reduce((acc, c) => acc + tokenize(c), 0) +
    tokenize(filteredHandoff?.evidence ? formatHandoffEvidenceLine(filteredHandoff.evidence) : null) +
    tokenize(filteredHandoff?.outcome) +
    tokenize(filteredHandoff?.targetRuntime) +
    tokenize(filteredHandoff?.cardId) +
    c.recentSessionEvents.reduce((acc, e) => acc + tokenize(e.content), 0);
}

// A pure read of the caller's recallHistory snapshot against this top-1. HIPPO_ANCHORING=off skips even the detect
// call; CLI paths pass no history (cmdRecall computes its own hint), so the hint stays absent there.
function detectRecallAnchoring(opts: RecallOpts, topMemoryId: string | null): AnchoringOutcome {
  if (!biasHintEnabled('anchoring') || !opts.recallHistory) return { anchoringHint: null, suppressedByInterference: 0 };
  const queryHash = hashQueryText(opts.query);
  const anchoringHint = detectAnchoring(opts.recallHistory, queryHash, topMemoryId);
  return { anchoringHint, suppressedByInterference: anchoringHint?.reason === 'memory_dominance' ? 1 : 0 };
}

// Compares the returned top-K's ages with the scope-filtered pool it came from, never `all`, whose hidden rows would
// leak pool shape. A soft warning only; HIPPO_AVAILABILITY=off or a caller computing its own hint skips it.
function detectRecallAvailability(
  opts: RecallOpts,
  baseSlice: MemoryEntry[],
  entries: MemoryEntry[],
): AvailabilityHint | null {
  if (!biasHintEnabled('availability') || opts.suppressAvailabilityHint) return null;
  return detectAvailabilityBias({
    topK: baseSlice.map((e) => ({ id: e.id, created: e.created })),
    pool: entries.map((e) => ({ id: e.id, created: e.created })),
  });
}

