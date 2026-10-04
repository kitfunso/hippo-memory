// Read path: recall (sync) and retrieve (async, adds the vector arm).

import { envRequireSessionScopedFreshTail } from '../env.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../db.js';
import { DEFAULT_SEARCH_CANDIDATE_LIMIT } from '../store/rows.js';
import { strengthenRetrieved } from '../store/entry-writes.js';
import { isRecallBoostAblated } from '../ablation.js';
import { loadEntriesByIds, loadFreshRawMemories } from '../store/entry-reads.js';
import { loadRecallSearchEntries, recallScopeFilter } from '../store/search-rows.js';
import { loadActiveTaskSnapshot, listSessionEvents } from '../store/sessions.js';
import { loadLatestHandoff } from '../store/handoffs.js';
import { estimateTokens } from '../token-ledger.js';
import { formatHandoffEvidenceLine } from '../handoff.js';
import type { MemoryEntry } from '../memory.js';
import { appendAuditEvent, auditQueryFields } from '../audit.js';
import { writeRecallTrace, writeRecallTraceAtRoot } from '../recall-trace.js';
import { applyGoalStackBoost } from '../goals.js';
import { hybridSearch } from '../search/hybrid.js';
import { physicsSearch } from '../search/physics-search.js';
import { churnStaleFactor } from '../search/boosts.js';
import type { HybridVectorCandidates } from '../search/vector.js';
import type { RerankStep } from '../search/types.js';
import { compareEntryIdentity } from '../compare.js';
import { dropHeldCopies, duplicateKey, storedTextKeys } from '../same-text.js';
import { loadConfig } from '../config.js';
import { computePlanningFallacyOutput } from '../predictions/planning-fallacy.js';
import { detectAnchoring, hashQueryText, biasHintEnabled, type AnchoringHint } from '../recall-history.js';
import { detectAvailabilityBias, type AvailabilityHint } from '../availability.js';
import { passesScopeFilterForRecall, assertScopeRequestAllowed, isRestrictedScope } from '../recall-scope.js';
import type { RecallSuppressionSummary, RecallOpts, RecallResult, RecallResultItem, ContinuityBlock } from './recall-types.js';
import { type Context, RecallContractError } from './types.js';

/**
 * Shared construction helper for `RecallSuppressionSummary`. Used by
 * `api.recall`, `cmdRecall`, and the MCP `hippo_recall` handler so all three
 * pipelines produce the same shape without duplicating field-construction
 * logic. Pass-through identity today; kept as a helper so future field
 * additions (B4 interference counter wiring, etc.) land at one site.
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
 * Domain-level recall. Loads BM25-ranked candidates from SQLite scoped to
 * `ctx.tenantId` and keeps that order whatever `mode` says; `retrieve` is the
 * mode-aware, strengthening variant the HTTP route uses.
 *
 * **api.recall does NOT mutate `index.last_retrieval_ids`** (v1.11.5 contract
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
  return recallFrom(ctx, opts, windowSize, loadRecallSearchEntries(ctx.hippoRoot, opts.query, windowSize, ctx.tenantId, opts.scope, 'exact', false));
}

/** Mode-aware recall that strengthens each returned row; never writes last_retrieval_ids (v1.11.5 lock). */
export async function retrieve(ctx: Context, opts: RecallOpts): Promise<RecallResult> {
  assertScopeRequestAllowed(ctx.actor, opts.scope);
  const windowSize = recallWindowSize(opts);
  if (opts.showRanked) return retrieveFromStore(ctx, opts, windowSize, opts.showRanked);
  let candidates = loadRecallSearchEntries(ctx.hippoRoot, opts.query, windowSize, ctx.tenantId, opts.scope, 'exact', false);
  if (opts.mode === 'hybrid' || opts.mode === 'physics') {
    const searchOpts = { budget: Infinity, hippoRoot: ctx.hippoRoot, scope: opts.scope ?? null, vectorCandidates: recallVectorSpec(ctx, opts) };
    const ranked = opts.mode === 'physics'
      ? await physicsSearch(opts.query, candidates, { ...searchOpts, physicsConfig: loadConfig(ctx.hippoRoot).physics })
      : await hybridSearch(opts.query, candidates, searchOpts);
    const rankedIds = new Set(ranked.map((r) => r.entry.id));
    candidates = [...ranked.map((r) => r.entry), ...candidates.filter((e) => !rankedIds.has(e.id))];
  }
  const result = recallFrom(ctx, opts, windowSize, candidates);
  strengthenRetrieved(ctx.hippoRoot, result.results.map((r) => r.id), { tenantId: ctx.tenantId, recallBoostAblated: isRecallBoostAblated() });
  return result;
}

/** api.retrieve's vector arm: the recall load's exact-scope rule, current rows only. */
function recallVectorSpec(ctx: Context, opts: RecallOpts): HybridVectorCandidates {
  return {
    tenantId: ctx.tenantId,
    scope: recallScopeFilter(opts.scope, 'exact'),
    includeSuperseded: false,
    admit: (e) => passesScopeFilterForRecall(e.scope ?? null, opts.scope),
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
): Promise<RecallResult> {
  const loaded = loadRecallSearchEntries(
    ctx.hippoRoot, opts.query, Math.max(windowSize, SHOW_RANKED_LEXICAL_WINDOW), ctx.tenantId, opts.scope, 'exact', false,
  );
  const pool = loaded.filter((e) => passesScopeFilterForRecall(e.scope ?? null, opts.scope));
  // No scope option: the scope boost follows HIPPO_SCOPE and the skill env, as MCP recall always ranked.
  const searchOpts = { budget: Infinity, hippoRoot: ctx.hippoRoot, vectorCandidates: recallVectorSpec(ctx, opts) };
  let ranked = opts.mode === 'physics'
    ? await physicsSearch(opts.query, pool, { ...searchOpts, physicsConfig: loadConfig(ctx.hippoRoot).physics })
    : await hybridSearch(opts.query, pool, searchOpts);
  if (opts.sessionId && !opts.goalTag) {
    const db = openHippoDb(ctx.hippoRoot);
    try {
      ranked = applyGoalStackBoost(db, ranked, { sessionId: opts.sessionId, tenantId: ctx.tenantId, limit: ranked.length });
    } finally {
      closeHippoDb(db);
    }
  }
  const window = ranked.slice(0, windowSize).map((r) => r.entry);
  const result = recallFrom(ctx, { ...opts, suppressRecallTrace: true }, windowSize, window);
  // Rows the vector arm added count as candidates too.
  const inPool = new Set(pool.map((e) => e.id));
  const candidates = [...pool, ...ranked.map((r) => r.entry).filter((e) => !inPool.has(e.id))];
  const shown = show({ ranked, pool: candidates, droppedByScope: loaded.length - pool.length }, result);
  strengthenRetrieved(ctx.hippoRoot, shown, { tenantId: ctx.tenantId, recallBoostAblated: isRecallBoostAblated() });
  if (!opts.suppressRecallTrace) {
    const scores = new Map(ranked.map((r) => [r.entry.id, r.score]));
    writeRecallTraceAtRoot(ctx.hippoRoot, {
      tenantId: ctx.tenantId,
      sessionId: opts.sessionId ?? null,
      pipeline: 'mcp',
      query: opts.query,
      results: shown.map((id) => ({ memoryId: id, score: scores.get(id) ?? 0 })),
    });
  }
  return result;
}

/** Contract preflight: throws before any store-touching work. */
function recallWindowSize(opts: RecallOpts): number {
  // F5 (v1.6.5) preflight — codex P1: original guard fired AFTER
  // loadSearchEntries (which runs initStore, migrating legacy state on first
  // call). For a true contract preflight we want the throw before any
  // store-touching work. Single check here; the consumer site at
  // `if (freshTailCount > 0)` does NOT re-validate (would be a no-op).
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
  // F3 (v1.7.0): scorerWindow opt-in. When undefined (default),
  // loadSearchEntries uses its own store-internal default — this
  // preserves every pre-v1.7.0 caller's behaviour bit-for-bit (codex
  // mk2-pass P0-1: defaulting to `limit` would have shrunk the
  // candidate pool and killed overflow summaries).
  // DEFAULT_SEARCH_CANDIDATE_LIMIT is imported from store.ts so the two
  // values cannot drift (codex diff-pass P1 #3).
  // Validate the input — codex diff-pass P1 #1 caught that scorerWindow=0
  // would route through FTS/LIKE LIMIT 0 and then fall through to an
  // uncapped full-store fallback. Reject non-positive / non-finite values.
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

/** The bands recall returns, plus the counts the suppression summary reports. */
interface RankedBands {
  rankedOut: RecallResultItem[];
  baseSlice: MemoryEntry[];
  heldDropped: number;
  summarySubstitutions: number;
  freshTailAdded: number;
}

interface ContinuityPart {
  continuity: ContinuityBlock;
  continuityTokens: number;
}

interface AnchoringOutcome {
  anchoringHint: AnchoringHint | null;
  suppressedByInterference: number;
}

type ScoredEntry = { entry: MemoryEntry; score: number };
type SummaryDecoration = { entry: MemoryEntry; childIds: string[] };

function recallFrom(ctx: Context, opts: RecallOpts, windowSize: number, all: MemoryEntry[]): RecallResult {
  const limit = opts.limit ?? 10;
  const window = admitCandidates(opts, all, limit);

  // One db handle spans the goal-stack boost and the audit and trace rows; it closes before the continuity block.
  const db = openHippoDb(ctx.hippoRoot);
  let bands: RankedBands;
  try {
    bands = rankBands(db, ctx, opts, window, limit);
    auditAndTraceRecall(db, ctx, opts, bands.rankedOut);
  } finally {
    closeHippoDb(db);
  }
  const rankedOut = bands.rankedOut;

  const { continuity, continuityTokens } = opts.includeContinuity
    ? loadContinuity(ctx, opts)
    : { continuity: undefined, continuityTokens: undefined };

  // Query-derived, so MCP and CLI read this one hint instead of recomputing; HIPPO_AUTODEBIAS=off disables it.
  // The hint and the no-class-match / tiebreak watching variant are mutually exclusive; both go out as optional fields.
  const planningFallacyOutput = computePlanningFallacyOutput(
    ctx.hippoRoot,
    ctx.tenantId,
    opts.query,
    { actor: ctx.actor.subject },
  );
  const planningFallacyHint = planningFallacyOutput.hint ?? null;
  const planningFallacyWatching = planningFallacyOutput.watching ?? null;
  const { anchoringHint, suppressedByInterference } = detectRecallAnchoring(ctx, opts, rankedOut[0]?.id ?? null);
  const availabilityHint = detectRecallAvailability(ctx, opts, bands.baseSlice, window.entries);

  const result: RecallResult = {
    results: rankedOut,
    total: window.entries.length,
    tokens: rankedOut.reduce((acc, r) => acc + estimateTokens(r.content), 0),
    continuity,
    continuityTokens,
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
  if (planningFallacyHint) result.planningFallacyHint = planningFallacyHint;
  if (planningFallacyWatching) result.planningFallacyWatching = planningFallacyWatching;
  if (anchoringHint) result.anchoringHint = anchoringHint;
  if (availabilityHint) result.availabilityHint = availabilityHint;
  return result;
}

// The SQL load already applied tenant and scope; any recall-mode loader must go through loadRecallSearchEntries.
function admitCandidates(opts: RecallOpts, all: MemoryEntry[], limit: number): CandidateWindow {
  const current = all.filter((e) => !e.superseded_by);
  let entries: typeof all;
  if (opts.scope !== undefined && opts.scope !== '') {
    // SQL already exact-matched; the JS filter is defense-in-depth against a SQL-clause regression.
    entries = current.filter((e) => e.scope === opts.scope);
  } else {
    // SQL pre-filtered ':private:' loosely before the window; this is the exact anchored `<source>:private:*` rule.
    entries = current.filter((e) => !isRestrictedScope(e.scope ?? null));
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
function rankBands(db: DatabaseSyncLike, ctx: Context, opts: RecallOpts, window: CandidateWindow, limit: number): RankedBands {
  let baseScored: ScoredEntry[] = window.baseSlice.map((entry, idx) => ({
    entry,
    score: Math.max(0, 1 - idx / Math.max(1, limit)),
  }));
  // Allocated only under explain, so the boost's default-path math stays byte-identical.
  const explainTrace = opts.explain ? new Map<string, RerankStep>() : undefined;
  if (opts.sessionId && !opts.goalTag) {
    baseScored = applyGoalStackBoost(db, baseScored, {
      sessionId: opts.sessionId,
      tenantId: ctx.tenantId,
      limit,
      trace: explainTrace,
    });
  }
  let substituted = (opts.summarizeOverflow ?? true) && window.entries.length > limit
    ? substituteOverflow(ctx, opts, window.entries, baseScored.map((r) => r.entry), limit)
    : [];
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
    ? freshTailBand(ctx, opts, baseRanked, summaryRanked, opts.keepHeldCopies ? [] : [...baseSlice, ...substituted.map((s) => s.entry)])
    : [];
  return {
    rankedOut: [...freshRanked, ...baseRanked, ...summaryRanked],
    baseSlice,
    heldDropped,
    summarySubstitutions: substituted.length,
    freshTailAdded: freshRanked.length,
  };
}

// When the overflow holds 2+ children of one level-2 summary, that summary stands in for them, capped at 30% of
// `limit`. Each one is tenant-scoped and re-checked against the scope filter; drillDown recovers the children.
function substituteOverflow(
  ctx: Context,
  opts: RecallOpts,
  entries: MemoryEntry[],
  baseSlice: MemoryEntry[],
  limit: number,
): SummaryDecoration[] {
  const overflow = entries.slice(limit);
  const baseIds = new Set(baseSlice.map((e) => e.id));
  const overflowByParent = new Map<string, typeof overflow>();
  for (const e of overflow) {
    const parentId = e.dag_parent_id;
    if (!parentId) continue;
    if ((e.dag_level ?? 0) > 1) continue;
    const list = overflowByParent.get(parentId) ?? [];
    list.push(e);
    overflowByParent.set(parentId, list);
  }
  const eligibleParentIds = Array.from(overflowByParent.keys()).filter(
    (pid) => (overflowByParent.get(pid)?.length ?? 0) >= 2 && !baseIds.has(pid),
  );
  if (eligibleParentIds.length === 0) return [];
  const parents = loadEntriesByIds(ctx.hippoRoot, eligibleParentIds, ctx.tenantId);
  const eligibleParents = parents.filter(
    (p) => (p.dag_level ?? 0) === 2 && !p.superseded_by && passesScopeFilterForRecall(p.scope ?? null, opts.scope),
  );
  const maxSub = Math.max(1, Math.ceil(limit * 0.3));
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

// Score 0.5 keeps a summary below the strong top-N matches but above the weakest leaves.
function summaryItem(s: SummaryDecoration, opts: RecallOpts): RecallResultItem {
  const item: RecallResultItem = {
    id: s.entry.id,
    content: s.entry.content,
    score: 0.5,
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
function freshTailBand(
  ctx: Context,
  opts: RecallOpts,
  baseRanked: RecallResultItem[],
  summaryRanked: RecallResultItem[],
  shownEntries: MemoryEntry[],
): RecallResultItem[] {
  // The session-id contract was already checked by recallWindowSize's preflight.
  const recent = loadFreshRawMemories(ctx.hippoRoot, opts.freshTailCount ?? 0, ctx.tenantId, opts.freshTailSessionId);
  const recentScoped = recent.filter((m) => passesScopeFilterForRecall(m.scope ?? null, opts.scope));
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
      score: 1.0,
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

// The audit row stores a hash of the query, never its text, so an archived memory's words cannot persist there.
// The trace sits beside it as observability, not retrieval state; a caller that traces its own result set suppresses it.
function auditAndTraceRecall(db: DatabaseSyncLike, ctx: Context, opts: RecallOpts, rankedOut: RecallResultItem[]): void {
  appendAuditEvent(db, {
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    op: 'recall',
    metadata: {
      ...auditQueryFields(opts.query),
      results: rankedOut.length,
    },
  });
  if (!opts.suppressRecallTrace) {
    writeRecallTrace(db, {
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
    });
  }
}

// No active snapshot means no anchor, so no handoff or events: a stale handoff from a closed session never resurfaces.
function loadContinuity(ctx: Context, opts: RecallOpts): ContinuityPart {
  const snapshot = loadActiveTaskSnapshot(ctx.hippoRoot, ctx.tenantId);
  const sessionId = snapshot?.session_id ?? undefined;
  const sessionHandoff = sessionId
    ? loadLatestHandoff(ctx.hippoRoot, ctx.tenantId, sessionId)
    : null;
  const recentSessionEvents = sessionId
    ? listSessionEvents(ctx.hippoRoot, ctx.tenantId, { session_id: sessionId, limit: 5 })
    : [];
  // The memory-recall scope rule: an explicit scope must match exactly; without one, private and legacy rows are denied.
  const rowScope = (
    r: { scope?: string | null } | null | undefined,
  ): string | null => r?.scope ?? null;
  const filteredSnapshot =
    snapshot && passesScopeFilterForRecall(rowScope(snapshot), opts.scope) ? snapshot : null;
  const filteredHandoff =
    sessionHandoff && passesScopeFilterForRecall(rowScope(sessionHandoff), opts.scope) ? sessionHandoff : null;
  const filteredEvents = recentSessionEvents.filter((e) => passesScopeFilterForRecall(rowScope(e), opts.scope));
  const continuity: ContinuityBlock = {
    activeSnapshot: filteredSnapshot,
    sessionHandoff: filteredHandoff,
    recentSessionEvents: filteredEvents,
  };
  return { continuity, continuityTokens: continuityTokensOf(continuity) };
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

/** One audit row on its own short-lived handle, as each bias detector writes it. */
function appendRecallAudit(ctx: Context, event: Omit<Parameters<typeof appendAuditEvent>[1], 'tenantId' | 'actor'>): void {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    appendAuditEvent(db, { tenantId: ctx.tenantId, actor: ctx.actor.subject, ...event });
  } finally {
    closeHippoDb(db);
  }
}

// A pure read of the caller's recallHistory snapshot against this top-1. HIPPO_ANCHORING=off skips even the detect
// call; CLI paths pass no history (cmdRecall computes its own hint), so the hint stays absent there.
function detectRecallAnchoring(
  ctx: Context,
  opts: RecallOpts,
  topMemoryId: string | null,
): AnchoringOutcome {
  if (!biasHintEnabled('anchoring') || !opts.recallHistory) return { anchoringHint: null, suppressedByInterference: 0 };
  const queryHash = hashQueryText(opts.query);
  const anchoringHint = detectAnchoring(opts.recallHistory, queryHash, topMemoryId);
  if (anchoringHint?.reason === 'memory_dominance') {
    appendRecallAudit(ctx, {
      op: 'recall_anchor_detected_memory_dominance',
      targetId: anchoringHint.memoryId,
      metadata: {
        memory_id: anchoringHint.memoryId,
        query_count: anchoringHint.queryCount ?? null,
      },
    });
    return { anchoringHint, suppressedByInterference: 1 };
  }
  if (anchoringHint?.reason === 'query_repeat') {
    appendRecallAudit(ctx, {
      op: 'recall_anchor_detected_query_repeat',
      targetId: anchoringHint.memoryId,
      metadata: { memory_id: anchoringHint.memoryId },
    });
  }
  return { anchoringHint, suppressedByInterference: 0 };
}

// Compares the returned top-K's ages with the scope-filtered pool it came from, never `all`, whose hidden rows would
// leak pool shape. A soft warning only; HIPPO_AVAILABILITY=off or a caller computing its own hint skips it.
function detectRecallAvailability(
  ctx: Context,
  opts: RecallOpts,
  baseSlice: MemoryEntry[],
  entries: MemoryEntry[],
): AvailabilityHint | null {
  if (!biasHintEnabled('availability') || opts.suppressAvailabilityHint) return null;
  const availabilityHint = detectAvailabilityBias({
    topK: baseSlice.map((e) => ({ id: e.id, created: e.created })),
    pool: entries.map((e) => ({ id: e.id, created: e.created })),
  });
  if (availabilityHint) {
    appendRecallAudit(ctx, {
      op: 'recall_availability_detected',
      metadata: {
        recent_fraction: availabilityHint.recentFraction,
        older_passed_over: availabilityHint.olderCandidatesPassedOver,
        returned_count: availabilityHint.returnedCount,
      },
    });
  }
  return availabilityHint;
}

