// Read path: recall (sync) and retrieve (async, adds the vector arm).

import { openHippoDb, closeHippoDb } from '../db.js';
import { DEFAULT_SEARCH_CANDIDATE_LIMIT } from '../store/rows.js';
import { strengthenRetrieved } from '../store/entry-writes.js';
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
import { computePlanningFallacyOutput } from '../predictions.js';
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
  strengthenRetrieved(ctx.hippoRoot, result.results.map((r) => r.id), ctx.tenantId);
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
  strengthenRetrieved(ctx.hippoRoot, shown, ctx.tenantId);
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
    process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL === '1'
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

function recallFrom(ctx: Context, opts: RecallOpts, windowSize: number, all: MemoryEntry[]): RecallResult {
  const limit = opts.limit ?? 10;
  // v1.7.1 — root-cause fix for the `unknown:legacy` leak. Scope predicate
  // is now pushed into `loadSearchRows` SQL via `loadRecallSearchEntries`.
  // - opts.scope undefined / '': SQL excludes `unknown:legacy`.
  // - opts.scope non-empty: SQL exact-matches m.scope = opts.scope.
  // Tenant predicate still runs first, so a tenant-mismatched scope cannot
  // surface another tenant's row even when both share the same scope string.
  //
  // **CALLER CONTRACT:** any future recall-mode loader MUST go through
  // `loadRecallSearchEntries` (or invoke the SQL scope predicate equivalently).
  // Calling `loadSearchEntries` from this code path re-introduces the v1.6.5
  // codex-flagged leak. See `passesScopeFilterForRecall` in this file for
  // the canonical recall-side scope rule (kept in sync with the SQL clause
  // in loadSearchRows).
  //
  // Also fixes a latent code smell: pre-v1.7.1 passed `opts.scorerWindow`
  // (raw, possibly undefined) where `windowSize` was intended.
  // v1.12.13 / C5 — WYSIATI counters. Declared BEFORE the load step so the
  // assignments at the existing filter sites (load / scope-filter / limit-
  // slice / substitution / fresh-tail) are after declaration. The return at
  // end-of-function reads them via buildSuppressionSummary.
  let totalCandidatesCount = 0;
  let droppedPreRankCount = 0;
  let droppedByBudgetCount = 0;
  let summarySubstitutionsCount = 0;
  let freshTailAddedCount = 0;

  // v1.12.13 / C5 — WYSIATI totalCandidates counter (post tenant + SQL scope
  // predicate, pre JS scope filter).
  totalCandidatesCount = all.length;
  const current = all.filter((e) => !e.superseded_by);
  let entries: typeof all;
  if (opts.scope !== undefined && opts.scope !== '') {
    // SQL already exact-matched in loadRecallSearchEntries; keep the JS
    // filter as defense-in-depth so a future SQL-clause regression cannot
    // silently surface cross-scope rows.
    entries = current.filter((e) => e.scope === opts.scope);
  } else {
    // SQL already excluded `unknown:legacy` AND (v1.25.0) pre-filtered
    // ':private:' scopes with a conservative LIKE before the candidate
    // window, so private rows can no longer starve admitted rows out of the
    // LIMIT (codex review-stage P2). This JS filter stays as the exact
    // anchored `<source>:private:*` rule (v1.2.1 generalization) and
    // defense-in-depth: connector authors cannot silently surface private
    // rows to no-scope callers even if the SQL clause regresses.
    entries = current.filter((e) => !isRestrictedScope(e.scope ?? null));
  }
  // v1.12.13 / C5 — WYSIATI dropped_pre_rank counter (JS scope filter drops
  // for api.recall; cmdRecall pipeline rolls --outcome/--layer/--as-of/etc.
  // into the same field per the plan's Task 3 mapping table).
  droppedPreRankCount = all.length - entries.length;
  entries = entries
    .map((e, i) => ({ e, s: (1 - i / entries.length) * churnStaleFactor(e) }))
    .sort((a, b) => b.s - a.s)
    .map((r) => r.e);
  // BM25 ordering already comes from loadRecallSearchEntries; cap to `limit`.
  // Score is a placeholder — the physics/hybrid scorers in src/search.ts
  // produce richer breakdowns and will replace this when wired up.
  let baseSlice = entries.slice(0, limit);
  // v1.12.13 / C5 — WYSIATI dropped_by_budget counter (candidates loaded but
  // excluded by the final limit slice).
  droppedByBudgetCount = entries.length - baseSlice.length;

  // v1.7.4 -- single db handle for the goal-stack boost AND the audit-event
  // emit below (codex P1: do not open a second short-lived handle for the
  // appendAuditEvent call). The handle is closed in the matching `finally`
  // immediately above the continuity block.
  const db = openHippoDb(ctx.hippoRoot);
  // v1.7.4 -- declared outside the try so the return statement (which lives
  // outside, after the continuity block) can read the final values.
  let rankedOut: RecallResultItem[] = [];
  let tokensOut = 0;
  let totalOut = 0;
  // v1.7.4 -- dlPFC goal-stack boost on the PRIMARY band only. Appendix paths
  // (fresh-tail, summary substitutions) are appended AFTER and keep their
  // semantically-special placement.
  let baseScored: Array<{ entry: typeof baseSlice[number]; score: number }> =
    baseSlice.map((entry, idx) => ({
      entry,
      score: Math.max(0, 1 - idx / Math.max(1, limit)),
    }));
  // A7 recall-trace: separate side-channel accumulator, allocated ONLY under
  // explain. applyGoalStackBoost writes goal-boost steps here keyed by entry
  // id; the baseRanked map reads it. When !explain it stays undefined and is
  // never passed → the helper's default-path math is byte-identical.
  const explainTrace = opts.explain ? new Map<string, RerankStep>() : undefined;
  try {
    if (opts.sessionId && !opts.goalTag) {
      baseScored = applyGoalStackBoost(db, baseScored, {
        sessionId: opts.sessionId,
        tenantId: ctx.tenantId,
        limit,
        // trace is optional on applyGoalStackBoost; explicitly passing
        // undefined when !explain is identical to omitting the key.
        trace: explainTrace,
      });
      baseSlice = baseScored.map((r) => r.entry);
    }

  // v1.5.0 DAG-aware substitution (Phase 1, Task 2). When entries overflow the
  // limit and ≥2 of them share a level-2 parent summary, append the parent
  // summary so the user sees a compact pointer to the dropped detail. Capped
  // at ceil(limit * 0.3) substitutions so a runaway DAG can't expand results.
  // Each substituted summary is tenant-scoped via loadEntriesByIds and
  // re-checked against the active scope filter (default-deny on private).
  // Drill-down (Task 3) reverses substitution: caller passes substitutedFor[]
  // ids back through `drillDown` to recover the children.
  const summarizeOverflow = opts.summarizeOverflow ?? true;
  type SummaryDecoration = { entry: typeof baseSlice[number]; childIds: string[] };
  let substituted: SummaryDecoration[] = [];
  if (summarizeOverflow && entries.length > limit) {
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
    if (eligibleParentIds.length > 0) {
      const parents = loadEntriesByIds(ctx.hippoRoot, eligibleParentIds, ctx.tenantId);
      const eligibleParents = parents.filter(
        (p) => (p.dag_level ?? 0) === 2 && !p.superseded_by && passesScopeFilterForRecall(p.scope ?? null, opts.scope),
      );
      const maxSub = Math.max(1, Math.ceil(limit * 0.3));
      // Order parents by overflow count descending so the most
      // information-dense substitutions come first. Overflow count is the
      // true primary key (unchanged); compareEntryIdentity is only a TAIL
      // for the case two parents overflow the same number of children —
      // without it that tie fell to SQLite scan order / loadEntriesByIds
      // batch order (T2, deterministic tie keys).
      eligibleParents.sort((a, b) => {
        const ac = overflowByParent.get(a.id)?.length ?? 0;
        const bc = overflowByParent.get(b.id)?.length ?? 0;
        return bc !== ac ? bc - ac : compareEntryIdentity(a, b);
      });
      substituted = eligibleParents.slice(0, maxSub).map((p) => ({
        entry: p,
        childIds: (overflowByParent.get(p.id) ?? []).map((e) => e.id),
      }));
    }
  }
  if (!opts.keepHeldCopies) {
    const shownIds = new Set(dropHeldCopies([...baseScored.map((r) => r.entry), ...substituted.map((s) => s.entry)], (e) => e).map((e) => e.id));
    droppedPreRankCount += baseScored.filter((r) => !shownIds.has(r.entry.id)).length;
    baseScored = baseScored.filter((r) => shownIds.has(r.entry.id));
    baseSlice = baseScored.map((r) => r.entry);
    substituted = substituted.filter((s) => shownIds.has(s.entry.id));
  }
  // v1.12.13 / C5 — WYSIATI summary_substitutions_added counter.
  summarySubstitutionsCount = substituted.length;

  // v1.7.4 -- baseScored carries the (possibly boosted) per-row scores. When
  // the goal-stack boost did not run, scores are identical to the original
  // positional placeholder; when it did run, scores reflect the boost AND the
  // rows are in the boosted order (helper sort()).
  const baseRanked: RecallResultItem[] = baseScored.map((r) => {
    const item: RecallResultItem = {
      id: r.entry.id,
      content: r.entry.content,
      score: r.score,
      layer: r.entry.layer,
      strength: r.entry.strength,
    };
    // A7 recall-trace: under explain, every api band carries rerankPipeline:'api';
    // only baseRanked passes through the goal-boost helper, so only it can carry
    // a step (and only for rows that actually matched an active goal).
    if (opts.explain) {
      item.rerankPipeline = 'api';
      const step = explainTrace?.get(r.entry.id);
      if (step) item.rerankTrace = [step];
    }
    return item;
  });
  // Substituted summaries land at the end with score = 0.5 (mid-rank), so
  // they don't outrank top-N strong matches but stay above lowest-rank
  // leaves on the consumer side. Caller sorts/filters as it sees fit.
  const summaryRanked: RecallResultItem[] = substituted.map((s) => {
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
    // A7 recall-trace: summary band runs no re-ranking, but under explain it
    // still carries the pipeline marker (no steps). Absent when !explain.
    if (opts.explain) item.rerankPipeline = 'api';
    return item;
  });
  // v1.5.2 fresh-tail. Surface the last N kind='raw' rows so an agent's
  // "what did I just see" recall path always covers the recent window even
  // when the query terms don't match. Tenant + scope filtered.
  //
  // Dual-membership semantics: `loadSearchEntries` returns all tenant-scoped
  // rows scored by BM25 (even rows with no token overlap can surface at
  // score≈0), so a row in the recent window often ALSO appears as a BM25
  // hit. We don't duplicate. Instead:
  //   1. Mark any baseRanked entry that's in the recent set with isFreshTail.
  //   2. Prepend genuinely-new recent rows (not in BM25 hits or summaries).
  // Net: every recent row carries `isFreshTail=true`, exactly once.
  const freshTailCount = opts.freshTailCount ?? 0;
  const freshRanked: RecallResultItem[] = [];
  if (freshTailCount > 0) {
    // F5 contract guard fires at recall() preflight (top of function).
    // No re-check needed here — by the time we reach this block the
    // env/session policy has already been validated.
    const recent = loadFreshRawMemories(
      ctx.hippoRoot,
      freshTailCount,
      ctx.tenantId,
      opts.freshTailSessionId,
    );
    const recentScoped = recent.filter((m) =>
      passesScopeFilterForRecall(m.scope ?? null, opts.scope),
    );
    const recentIdSet = new Set(recentScoped.map((m) => m.id));
    for (const r of baseRanked) {
      if (recentIdSet.has(r.id)) r.isFreshTail = true;
    }
    const seenIds = new Set([
      ...baseRanked.map((r) => r.id),
      ...summaryRanked.map((r) => r.id),
    ]);
    const shownKeys = storedTextKeys(opts.keepHeldCopies ? [] : [...baseSlice, ...substituted.map((s) => s.entry)]);
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
      // A7 recall-trace: fresh-tail band runs no re-ranking; under explain
      // it carries the pipeline marker (no steps). Absent when !explain.
      if (opts.explain) item.rerankPipeline = 'api';
      freshRanked.push(item);
      seenIds.add(m.id);
    }
  }
  // v1.12.13 / C5 — WYSIATI fresh_tail_added counter. Captures the new rows
  // prepended (NOT rows already in baseRanked that got tagged isFreshTail).
  freshTailAddedCount = freshRanked.length;

  rankedOut = [...freshRanked, ...baseRanked, ...summaryRanked];
  tokensOut = rankedOut.reduce((acc, r) => acc + estimateTokens(r.content), 0);
  totalOut = entries.length;

  // TODO(a1-task-4): emit via the shared audit hook in store.ts so we don't
  // double-emit. Recall does not currently write through writeEntry, so no
  // duplicate exists today, but we keep the same shape for symmetry.
  // v1.7.4: reuse the `db` handle opened above for the goal-stack boost --
  // single open/close spans both side effects.
  // GDPR Path A: store a sha256 hash (16 hex chars) of the query text
  // instead of the truncated query itself. If a caller queries with content
  // that matches an archived (RTBF) memory, the original text must not
  // persist in audit_log. query_length is preserved for debugging
  // long-prompt patterns and compliance metrics.
  appendAuditEvent(db, {
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    op: 'recall',
    metadata: {
      ...auditQueryFields(opts.query),
      results: rankedOut.length,
    },
  });

  // LC1 (docs/plans/2026-08-02-lc1-recall-trace-persistence.md): trace the
  // returned ids+ranks+scores next to the audit emit, on the SAME open
  // handle. v1.11.5 contract lock holds — api.recall does NOT write
  // last_trace_id (tests/api-recall-no-side-effects.test.ts); a trace INSERT
  // is the same observability class as the audit row it sits beside, not
  // retrieval state. F2 fix: suppressed when the caller traces its own,
  // different result set (retrieve under showRanked traces the shown list as
  // 'mcp'). Fail-soft internally; never throws.
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
  } finally {
    closeHippoDb(db);
  }

  let continuity: ContinuityBlock | undefined;
  let continuityTokens: number | undefined;
  if (opts.includeContinuity) {
    const snapshot = loadActiveTaskSnapshot(ctx.hippoRoot, ctx.tenantId);
    // No active snapshot = no anchor = no handoff/events. Avoids resurrecting
    // a stale handoff from a deleted/completed session.
    const sessionId = snapshot?.session_id ?? undefined;
    const sessionHandoff = sessionId
      ? loadLatestHandoff(ctx.hippoRoot, ctx.tenantId, sessionId)
      : null;
    const recentSessionEvents = sessionId
      ? listSessionEvents(ctx.hippoRoot, ctx.tenantId, { session_id: sessionId, limit: 5 })
      : [];
    // Scope filtering on continuity. Mirrors the memory-recall path:
    //   - opts.scope set: EXACT match required (no cross-scope leakage)
    //   - opts.scope unset: default-deny on ANY `<source>:private:*` AND on
    //     legacy 'unknown:legacy' rows quarantined by the v23 migration.
    //     Public and null scopes pass through.
    // v1.1.0 wrongly wrote this as `opts.scope || isPublic`, which allowed
    // ANY explicit scope to see ALL continuity rows. v1.2 closed the latent
    // leak. v1.2.1 generalizes the private check from slack-only to any
    // source so v1.3 GitHub (and future Jira/Linear/etc.) cannot leak.
    const rowScope = (
      r: { scope?: string | null } | null | undefined,
    ): string | null => r?.scope ?? null;
    // v1.2: TaskSnapshot / SessionHandoff / SessionEvent now carry scope; the
    // wrapper just normalizes null vs undefined. W1: was its own copy of
    // passesScopeFilterForRecall (cloned 3x); calls the shared helper now.
    const filteredSnapshot =
      snapshot && passesScopeFilterForRecall(rowScope(snapshot), opts.scope) ? snapshot : null;
    const filteredHandoff =
      sessionHandoff && passesScopeFilterForRecall(rowScope(sessionHandoff), opts.scope) ? sessionHandoff : null;
    const filteredEvents = recentSessionEvents.filter((e) => passesScopeFilterForRecall(rowScope(e), opts.scope));
    continuity = {
      activeSnapshot: filteredSnapshot,
      sessionHandoff: filteredHandoff,
      recentSessionEvents: filteredEvents,
    };
    const tokenize = (s?: string | null): number =>
      s ? estimateTokens(s) : 0;
    continuityTokens =
      tokenize(filteredSnapshot?.task) +
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
      filteredEvents.reduce((acc, e) => acc + tokenize(e.content), 0);
  }

  // v0.32 / J3.2 — auto-injection of reference-class baserate when the
  // query carries a forward-prediction phrase AND the closest matching
  // class has closed historical data. Pipeline-invariant (queryText-
  // derived), so MCP and CLI both read this as the single source of
  // truth instead of recomputing (unlike suppressionSummary which IS
  // per-pipeline). opts.actor threads through to the inner
  // computePredictionBaserate call so MCP/HTTP-originated hints attribute
  // correctly instead of defaulting to 'cli'. Disabled by HIPPO_AUTODEBIAS=off.
  // The hint and the no-class-match / tiebreak watching variant are mutually exclusive; both go out as optional fields.
  const planningFallacyOutput = computePlanningFallacyOutput(
    ctx.hippoRoot,
    ctx.tenantId,
    opts.query,
    { actor: ctx.actor.subject },
  );
  const planningFallacyHint = planningFallacyOutput.hint ?? null;
  const planningFallacyWatching = planningFallacyOutput.watching ?? null;

  // v0.33 / J1 (v1.13.2) — recall-recurrence anchoring detection.
  // Uses opts.recallHistory (caller-supplied snapshot) + this pipeline's
  // own top-1 from rankedOut[0]. PURE read — does NOT mutate the snapshot
  // or any caller-side Map. Disabled by HIPPO_ANCHORING=off (which gates
  // even the detectAnchoring call so disabled tenants pay zero work on
  // this surface). On CLI-routed call paths opts.recallHistory is
  // undefined because cmdRecall computes its own hint separately; the
  // detect call returns null and api.recall's anchoringHint stays absent.
  let anchoringHint: AnchoringHint | null = null;
  let suppressedByInterferenceCount = 0;
  if (biasHintEnabled('anchoring') && opts.recallHistory) {
    const queryHash = hashQueryText(opts.query);
    const topMemoryId = rankedOut[0]?.id ?? null;
    anchoringHint = detectAnchoring(opts.recallHistory, queryHash, topMemoryId);
    if (anchoringHint?.reason === 'memory_dominance') {
      suppressedByInterferenceCount = 1;
      // Emit audit op for the memory-dominance detection.
      const db = openHippoDb(ctx.hippoRoot);
      try {
        appendAuditEvent(db, {
          tenantId: ctx.tenantId,
          actor: ctx.actor.subject,
          op: 'recall_anchor_detected_memory_dominance',
          targetId: anchoringHint.memoryId,
          metadata: {
            memory_id: anchoringHint.memoryId,
            query_count: anchoringHint.queryCount ?? null,
          },
        });
      } finally {
        closeHippoDb(db);
      }
    } else if (anchoringHint?.reason === 'query_repeat') {
      const db = openHippoDb(ctx.hippoRoot);
      try {
        appendAuditEvent(db, {
          tenantId: ctx.tenantId,
          actor: ctx.actor.subject,
          op: 'recall_anchor_detected_query_repeat',
          targetId: anchoringHint.memoryId,
          metadata: { memory_id: anchoringHint.memoryId },
        });
      } finally {
        closeHippoDb(db);
      }
    }
  }

  // v1.13.x / J2 — availability/recency-bias detection. PURE read: compares
  // the age distribution of the returned top-K (baseSlice, the post-goal-boost
  // slice) against the matched candidate pool it was drawn from (entries, the
  // scope/private-FILTERED candidate set baseSlice is sliced from — NOT `all`,
  // which still holds private/cross-scope rows the caller is not eligible to see
  // and that could never enter the top-K; counting them would leak hidden pool
  // shape and inflate the signal). Soft warning only — does NOT filter, reorder,
  // or suppress. Disabled by HIPPO_AVAILABILITY=off (gates even the detect call
  // so disabled tenants pay zero work). Suppressed via opts.suppressAvailabilityHint
  // when the caller computes its own per-pipeline hint (MCP), mirroring the J1
  // opts.recallHistory gate above so we never double-emit the audit op. Audit
  // emission is pipeline-local, mirroring the J1 block above.
  let availabilityHint: AvailabilityHint | null = null;
  if (biasHintEnabled('availability') && !opts.suppressAvailabilityHint) {
    availabilityHint = detectAvailabilityBias({
      topK: baseSlice.map((e) => ({ id: e.id, created: e.created })),
      pool: entries.map((e) => ({ id: e.id, created: e.created })),
    });
    if (availabilityHint) {
      const db = openHippoDb(ctx.hippoRoot);
      try {
        appendAuditEvent(db, {
          tenantId: ctx.tenantId,
          actor: ctx.actor.subject,
          op: 'recall_availability_detected',
          metadata: {
            recent_fraction: availabilityHint.recentFraction,
            older_passed_over: availabilityHint.olderCandidatesPassedOver,
            returned_count: availabilityHint.returnedCount,
          },
        });
      } finally {
        closeHippoDb(db);
      }
    }
  }

  const result: RecallResult = {
    results: rankedOut,
    total: totalOut,
    tokens: tokensOut,
    continuity,
    continuityTokens,
    windowSize,
    suppressionSummary: buildSuppressionSummary({
      totalCandidates: totalCandidatesCount,
      droppedPreRank: droppedPreRankCount,
      droppedByBudget: droppedByBudgetCount,
      summarySubstitutionsAdded: summarySubstitutionsCount,
      freshTailAdded: freshTailAddedCount,
      suppressedByInterference: suppressedByInterferenceCount,
    }),
  };
  if (planningFallacyHint) result.planningFallacyHint = planningFallacyHint;
  if (planningFallacyWatching) result.planningFallacyWatching = planningFallacyWatching;
  if (anchoringHint) result.anchoringHint = anchoringHint;
  if (availabilityHint) result.availabilityHint = availabilityHint;
  return result;
}
