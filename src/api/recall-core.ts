// The CLI ranking core as a ranker of retrieve(): rank, let the caller pick the list it shows, then record that list once.

import { ForbiddenError } from '../api-errors.js';
import { reportAuditWriteFailure, type AppendAuditOpts } from '../store/audit.js';
import { decidePlanningFallacy, detectPlanningClaim, type PlanningFallacyDecision } from '../predictions/planning-fallacy.js';
import { rankRecall, type RankRecallResult } from '../recall-pipeline.js';
import { writeRecallTraceAtRoot } from '../store/recall-trace.js';
import type { SearchResult } from '../core/search-types.js';
import { saveIndex } from '../store/index-and-stats.js';
import { sqliteStore, type HippoStore, type RecallWrites } from '../store-port.js';
import { estimateTokens } from '../util/token-text.js';
import { callerOf, recallAuditMetadata, recallAuditRow, strengthenOf } from './recall-record.js';
import type { CliCoreRanker, CliCoreRecall, RecallOpts, RecallResult, ShownCliCore } from './recall-types.js';
import { recordTokens } from './tokens.js';
import type { Context } from './types.js';

// entriesByIds reads at most this many ids a call.
const ID_READ_CHUNK = 500;

export async function retrieveWithCliCore(ctx: Context, opts: RecallOpts, core: CliCoreRanker): Promise<RecallResult> {
  // This ranker applies the operator's scope rule and may search a second store, so no bearer client may reach it.
  if (!ctx.actor.hostAdmin) throw new ForbiddenError('The CLI ranking core serves the host admin only');
  const globalRoot = core.sources?.globalRoot;
  // The ranking core reads hippo.db itself, so its writes go to the same file whatever store the context names.
  const store = sqliteStore(ctx.hippoRoot);
  const ranking = await rankRecall(
    { hippoRoot: ctx.hippoRoot, globalRoot, tenantId: ctx.tenantId, note: core.note },
    { ...core.rank, query: opts.query, sessionId: opts.sessionId, goalTag: opts.goalTag },
  );
  if (ranking.halted) {
    // The stages that ran earned these rows, so the caller's flag error does not drop them.
    if (ranking.goalRecallLog.length > 0) await store.finishRecall({ goalLog: ranking.goalRecallLog, audit: [] });
    return resultOf(ranking, []);
  }
  if ('inspect' in core) {
    core.inspect(ranking);
    return resultOf(ranking, ranking.results);
  }
  const planning = await planningFor(ctx, store, opts.query);
  const shown = core.show(ranking, planning?.output ?? {});
  await recordShown(ctx, store, opts, core, { ranking, shown, planningAudit: planning?.audit });
  const result = resultOf(ranking, shown.results);
  if (planning?.output.hint) result.planningFallacyHint = planning.output.hint;
  if (planning?.output.watching) result.planningFallacyWatching = planning.output.watching;
  return result;
}

async function planningFor(ctx: Context, store: HippoStore, query: string): Promise<PlanningFallacyDecision | null> {
  const claim = detectPlanningClaim(query);
  if (!claim) return null;
  return decidePlanningFallacy(claim, await store.planningFallacyEvidence(ctx.tenantId, claim.classQueryTokens), ctx.tenantId, ctx.actor.subject);
}

function resultOf(ranking: RankRecallResult, shown: readonly SearchResult[]): RecallResult {
  const results = shown.map((r) => ({ id: r.entry.id, content: r.entry.content, score: r.score, layer: r.entry.layer, strength: r.entry.strength }));
  return {
    results,
    total: ranking.totalCandidates + ranking.graphAdded,
    tokens: results.reduce((sum, r) => sum + estimateTokens(r.content), 0),
  };
}

interface ShownRanking {
  readonly ranking: RankRecallResult;
  readonly shown: ShownCliCore;
  readonly planningAudit: AppendAuditOpts | undefined;
}

/** Audit rows first: a recall they cannot be written for leaves no strengthen, trace, marker or count, as under the other rankers. */
async function recordShown(ctx: Context, store: HippoStore, opts: RecallOpts, core: CliCoreRecall, done: ShownRanking): Promise<void> {
  const { ranking, shown, planningAudit } = done;
  const ids = shown.results.map((r) => r.entry.id);
  const recallRow = recallAuditRow(callerOf(ctx), 'recall', undefined, recallAuditMetadata(opts.query, ids.length));
  const second = core.sources?.globalRoot !== undefined && core.sources.globalRoot !== ctx.hippoRoot ? core.sources.globalRoot : undefined;
  const heldElsewhere = second !== undefined ? await idsNotHeld(store, ids, ctx.tenantId) : [];
  const audited = await finishOrReport(store, {
    goalLog: ranking.goalRecallLog,
    audit: [...(planningAudit ? [planningAudit] : []), ...shown.audit, recallRow],
    strengthen: strengthenOf(ctx, ids),
  });
  if (audited) {
    // The second store logs that it was searched, and strengthens only the rows the first does not hold.
    if (second !== undefined) await finishOrReport(sqliteStore(second), { goalLog: [], audit: [recallRow], strengthen: strengthenOf(ctx, heldElsewhere) });
    await traceAndMark(ctx, store, opts, core, shown.results);
  }
  // The ledger books the text the caller prints, and it prints whether or not the record was written.
  await recordTokens(ctx, 'recall', { items: ids.length, tokens: shown.tokens, sessionId: core.hostSessionId ?? null });
}

// The caller has ranked and is about to print, so a failed audit write is logged and counted, never thrown.
async function finishOrReport(store: HippoStore, writes: RecallWrites): Promise<boolean> {
  try {
    await store.finishRecall(writes);
    return true;
  } catch (err) {
    reportAuditWriteFailure('recall', String(err));
    return false;
  }
}

async function idsNotHeld(store: HippoStore, ids: readonly string[], tenantId: string): Promise<string[]> {
  const held = new Set<string>();
  for (let i = 0; i < ids.length; i += ID_READ_CHUNK) {
    for (const entry of await store.entriesByIds(ids.slice(i, i + ID_READ_CHUNK), tenantId)) held.add(entry.id);
  }
  return ids.filter((id) => !held.has(id));
}

async function traceAndMark(ctx: Context, store: HippoStore, opts: RecallOpts, core: CliCoreRecall, shown: readonly SearchResult[]): Promise<void> {
  // An empty list is traced too, so a coverage gap still reaches the training corpus.
  const traceId = writeRecallTraceAtRoot(ctx.hippoRoot, {
    tenantId: ctx.tenantId,
    sessionId: opts.sessionId || core.hostSessionId || null,
    pipeline: 'cli',
    query: opts.query,
    explainMode: core.rank.why === true,
    results: shown.map((r) => ({ memoryId: r.entry.id, score: r.score, rerankSteps: r.rerankTrace })),
  });
  if (shown.length === 0) return;
  // One write for both markers, so `hippo outcome` never pairs these ids with an older trace.
  saveIndex(ctx.hippoRoot, { last_retrieval_ids: shown.map((r) => r.entry.id), last_trace_id: traceId !== null ? String(traceId) : null });
  await store.bumpRecallStats(shown.length);
}
