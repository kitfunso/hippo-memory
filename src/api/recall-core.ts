// The CLI ranking core as a ranker of retrieve(): rank, let the
// caller pick the list it shows, then record that list once.

import { ForbiddenError } from '../core/api-errors.js';
import { reportAuditWriteFailure, type AppendAuditOpts } from '../store/audit.js';
import {
  decidePlanningFallacy,
  detectPlanningClaim,
  type PlanningFallacyDecision,
} from '../predictions/planning-fallacy.js';
import { rankRecall, type RankRecallResult } from './recall-pipeline.js';
import type { SearchResult } from '../core/search-types.js';
import type { HippoStore, LastRecallWrites } from '../store/index.js';
import type { RecallTraceInput } from '../store/recall-trace.js';
import { estimateTokens } from '../util/token-text.js';
import { callerOf, heldIds, recallAuditMetadata, recallAuditRow, strengthenOf } from './recall-record.js';
import { RECALL_RECORDING, recordShownRecall } from './recall-finish.js';
import type { CliCoreRanker, CliCoreRecall, RecallOpts, RecallResult, ShownCliCore } from './recall-types.js';
import { narrowContext, type Context, type StoreContext } from './types.js';

export async function retrieveWithCliCore(
  ctx: StoreContext,
  opts: RecallOpts,
  core: CliCoreRanker,
): Promise<RecallResult> {
  // This ranker applies the operator's scope rule and may search a second store, so no bearer client may reach it.
  if (!ctx.actor.hostAdmin) throw new ForbiddenError('The CLI ranking core serves the host admin only');
  const globalRoot = core.sources?.globalRoot;
  // The ranking core reads hippo.db under hippoRoot, yet writes through the caller's store, whose finishRecall skips
  // any id it does not hold.
  const store = ctx.store;
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
  const shown = await core.show(ranking, planning?.output ?? {});
  await recordShown(ctx, store, opts, core, { ranking, shown, planningAudit: planning?.audit });
  const result = resultOf(ranking, shown.results);
  if (planning?.output.hint) result.planningFallacyHint = planning.output.hint;
  if (planning?.output.watching) result.planningFallacyWatching = planning.output.watching;
  return result;
}

async function planningFor(ctx: Context, store: HippoStore, query: string): Promise<PlanningFallacyDecision | null> {
  const claim = detectPlanningClaim(query);
  if (!claim) return null;
  return decidePlanningFallacy(
    claim,
    await store.planningFallacyEvidence(ctx.tenantId, claim.classQueryTokens),
    ctx.tenantId,
    ctx.actor.subject,
  );
}

function resultOf(ranking: RankRecallResult, shown: readonly SearchResult[]): RecallResult {
  const results = shown.map((r) => ({
    id: r.entry.id,
    content: r.entry.content,
    score: r.score,
    layer: r.entry.layer,
    strength: r.entry.strength,
  }));
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

/** Audit rows first: a recall they cannot be written for leaves no
 * strengthen, trace, marker or count, as under the other rankers. */
async function recordShown(
  ctx: StoreContext,
  store: HippoStore,
  opts: RecallOpts,
  core: CliCoreRecall,
  done: ShownRanking,
): Promise<void> {
  const { ranking, shown, planningAudit } = done;
  const ids = shown.results.map((r) => r.entry.id);
  const recallRow = recallAuditRow(callerOf(ctx), 'recall', undefined, recallAuditMetadata(opts.query, ids.length));
  const second = secondStore(ctx, core);
  const heldElsewhere = second !== undefined ? await idsNotHeld(store, ids, ctx.tenantId) : [];
  const writes = {
    goalLog: ranking.goalRecallLog,
    audit: [...(planningAudit ? [planningAudit] : []), ...shown.audit, recallRow],
    strengthen: strengthenOf(ctx, ids),
    trace: traceOf(ctx, opts, core, shown.results),
  };
  const audited = await finishOrReport(() => finishShown(ctx, writes, ids.length > 0));
  if (audited) {
    // The second store logs that it was searched, and strengthens only the rows the first does not hold.
    if (second !== undefined) {
      await finishOrReport(() =>
        second.finishRecall({ goalLog: [], audit: [recallRow], strengthen: strengthenOf(ctx, heldElsewhere) }),
      );
    }
  }
  // The caller prints whether or not the record was written, so the ring and the ledger still take this list; `written`
  // holds back the count.
  await recordShownRecall(ctx, store, RECALL_RECORDING.cli, {
    query: opts.query,
    sessionId: opts.sessionId,
    topId: ids[0] ?? null,
    anchoredOn: shown.anchoredOn,
    items: ids.length,
    tokens: shown.tokens,
    ledgerSessionId: core.hostSessionId ?? null,
    written: audited,
  });
}

/** The second store takes its own recall rows, unless it is the root being searched already. */
function secondStore(ctx: Context, core: CliCoreRecall): HippoStore | undefined {
  const sources = core.sources;
  return sources !== undefined && sources.globalRoot !== ctx.hippoRoot ? sources.globalStore : undefined;
}

// The caller has ranked and is about to print, so a failed audit write is logged and counted, never thrown.
async function finishOrReport(finish: () => Promise<number | null | void>): Promise<boolean> {
  try {
    await finish();
    return true;
  } catch (err) {
    reportAuditWriteFailure('recall', String(err));
    return false;
  }
}

async function idsNotHeld(store: HippoStore, ids: readonly string[], tenantId: string): Promise<string[]> {
  const held = await heldIds(store, ids, tenantId);
  return ids.filter((id) => !held.has(id));
}

// An empty list is traced too, so a coverage gap still reaches the training corpus.
function traceOf(
  ctx: Context,
  opts: RecallOpts,
  core: CliCoreRecall,
  shown: readonly SearchResult[],
): RecallTraceInput {
  return {
    tenantId: ctx.tenantId,
    sessionId: opts.sessionId || core.hostSessionId || null,
    pipeline: 'cli',
    query: opts.query,
    explainMode: core.rank.why === true,
    results: shown.map((r) => ({ memoryId: r.entry.id, score: r.score, rerankSteps: r.rerankTrace })),
  };
}

// A non-empty list is also the last recall, one write with its trace so `hippo outcome` never pairs these ids with an
// older trace; an empty one leaves the marker on the previous recall.
function finishShown(ctx: StoreContext, writes: LastRecallWrites, marks: boolean): Promise<number | null | void> {
  if (!marks) return ctx.store.finishRecall(writes);
  return narrowContext(ctx, 'lastRecall').store.lastRecall.finishRecall(writes, undefined);
}
