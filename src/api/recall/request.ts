// The recall and context input rules in one copy, so MCP and HTTP reject the same inputs with the same messages.
// retrieveWithCliCore, the CLI ranking core, ranks through retrieve() and records the list the caller shows once.
import { BadRequestError, ForbiddenError } from '../../core/api-errors.js';
import type { SearchResult } from '../../core/search-types.js';
import {
  decidePlanningFallacy,
  detectPlanningClaim,
  type PlanningFallacyDecision,
} from '../../predictions/planning-fallacy.js';
import { reportAuditWriteFailure, type AppendAuditOpts } from '../../store/audit.js';
import type { HippoStore, LastRecallWrites } from '../../store/index.js';
import type { RecallTraceInput } from '../../store/recall-trace.js';
import { type JsonValue, isJsonString } from '../../util/json.js';
import { MAX_ID_LEN } from '../../util/limits.js';
import { estimateTokens } from '../../util/token-text.js';
import type { ContextOpts } from '../context-types.js';
import { narrowContext, type Context, type StoreContext } from '../types.js';
import { rankRecall, type RankRecallResult } from './pipeline.js';
import {
  callerOf,
  heldIds,
  RECALL_RECORDING,
  recallAuditMetadata,
  recallAuditRow,
  recordShownRecall,
  strengthenOf,
} from './finish.js';
import type { CliCoreRanker, CliCoreRecall, RecallOpts, RecallResult, ShownCliCore } from './types.js';

const MAX_RECALL_LIMIT = 1000;
// recall() owns the shape rule for scorer_window (invalid_scorer_window); this cap bounds remote cost.
const MAX_SCORER_WINDOW = 1000;
// Bounds BM25 tokenisation cost while covering pasted error messages.
const MAX_CONTEXT_QUERY_LEN = 1024;
const RECALL_MODES = ['bm25', 'hybrid', 'physics'] as const;

/** A recall or context input the caller must fix; MCP answers it with an isError result, HTTP with a 400. */
export class RecallRequestError extends BadRequestError {
  constructor(message: string) {
    super(message);
    this.name = 'RecallRequestError';
  }
}

type ParamValue = JsonValue | undefined;

/** A request's named inputs; `queryName` is the surface's name for the query text. */
export interface RequestParams {
  readonly get: (name: string) => ParamValue;
  readonly queryName: 'q' | 'query';
}

export function httpParams(query: URLSearchParams): RequestParams {
  return { get: (name) => query.get(name) ?? undefined, queryName: 'q' };
}

export function toolParams(args: Readonly<Record<string, JsonValue>>): RequestParams {
  return { get: (name) => args[name], queryName: 'query' };
}

/** The recall options every surface passes through to retrieve(). */
export type SharedRecallOpts = Pick<
  RecallOpts,
  'query' | 'scope' | 'freshTailCount' | 'freshTailSessionId' | 'summarizeOverflow' | 'scorerWindow' | 'sessionId'
> & { includeContinuity: boolean };

export interface ParsedRecallRequest {
  readonly opts: SharedRecallOpts;
  readonly limit: number | undefined;
  readonly mode: RecallOpts['mode'];
  readonly explain: boolean;
}

export type ParsedContextRequest = Pick<
  ContextOpts,
  'q' | 'budget' | 'limit' | 'pinnedOnly' | 'scope' | 'includeRecent' | 'crossProject'
>;

function numberParam(params: RequestParams, name: string): number | undefined {
  const value = params.get(name);
  return value === undefined || value === null ? undefined : Number(value);
}

function nonNegativeParam(params: RequestParams, name: string): number | undefined {
  const n = numberParam(params, name);
  if (n !== undefined && (!Number.isFinite(n) || n < 0)) {
    throw new RecallRequestError(`${name} must be a non-negative number`);
  }
  return n;
}

// Only `true`, "1" and "true" turn a flag on, so `?summarize_overflow=banana` or an empty value stays off.
function flagParam(params: RequestParams, name: string): boolean {
  const value = params.get(name);
  return value === true || value === '1' || value === 'true';
}

function optionalFlagParam(params: RequestParams, name: string): boolean | undefined {
  const value = params.get(name);
  return value === undefined || value === null ? undefined : flagParam(params, name);
}

function stringParam(params: RequestParams, name: string): string | undefined {
  const value = params.get(name);
  return isJsonString(value) && value.length > 0 ? value : undefined;
}

/** An id-shaped string capped at MAX_ID_LEN; empty reads as absent. */
function idParam(params: RequestParams, name: string): string | undefined {
  const value = params.get(name);
  if (isJsonString(value) && value.length > MAX_ID_LEN) {
    throw new RecallRequestError(`${name} exceeds ${MAX_ID_LEN}-character cap`);
  }
  return stringParam(params, name);
}

function limitParam(params: RequestParams): number | undefined {
  const limit = numberParam(params, 'limit');
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > MAX_RECALL_LIMIT)) {
    throw new RecallRequestError(`limit must be a positive integer <= ${MAX_RECALL_LIMIT}`);
  }
  return limit;
}

function modeParam(params: RequestParams): RecallOpts['mode'] {
  const value = params.get('mode');
  if (value === undefined || value === null) return undefined;
  const mode = RECALL_MODES.find((m) => m === value);
  if (!mode) throw new RecallRequestError("mode must be 'bm25', 'hybrid', or 'physics'");
  return mode;
}

function scorerWindowParam(params: RequestParams): number | undefined {
  const scorerWindow = numberParam(params, 'scorer_window');
  if (scorerWindow !== undefined && scorerWindow > MAX_SCORER_WINDOW) {
    throw new RecallRequestError(`scorer_window must be <= ${MAX_SCORER_WINDOW}`);
  }
  return scorerWindow;
}

/** Trimmed, and absent when blank, so a whitespace id never keys a goal stack or a session ring. */
function sessionIdParam(params: RequestParams): string | undefined {
  const value = idParam(params, 'session_id');
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Checks in a fixed order, so the first bad input is the one reported. */
export function parseRecallRequest(params: RequestParams): ParsedRecallRequest {
  const query = params.get(params.queryName);
  if (!isJsonString(query) || query.length === 0) throw new RecallRequestError(`${params.queryName} is required`);
  const limit = limitParam(params);
  const mode = modeParam(params);
  const scope = stringParam(params, 'scope');
  const includeContinuity = flagParam(params, 'include_continuity');
  const freshTailCount = nonNegativeParam(params, 'fresh_tail_count');
  const freshTailSessionId = idParam(params, 'fresh_tail_session_id');
  const summarizeOverflow = optionalFlagParam(params, 'summarize_overflow');
  const scorerWindow = scorerWindowParam(params);
  const sessionId = sessionIdParam(params);
  const explain = flagParam(params, 'explain');
  return {
    opts: {
      query,
      scope,
      includeContinuity,
      freshTailCount,
      freshTailSessionId,
      summarizeOverflow,
      scorerWindow,
      sessionId,
    },
    limit,
    mode,
    explain,
  };
}

export function parseContextRequest(params: RequestParams): ParsedContextRequest {
  const qValue = params.get(params.queryName);
  const q = isJsonString(qValue) ? qValue : undefined;
  if (q !== undefined && q.length > MAX_CONTEXT_QUERY_LEN) {
    throw new RecallRequestError(`${params.queryName} exceeds ${MAX_CONTEXT_QUERY_LEN}-character cap`);
  }
  const budget = nonNegativeParam(params, 'budget');
  const limit = numberParam(params, 'limit');
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new RecallRequestError('limit must be a positive number');
  }
  const pinnedOnly = flagParam(params, 'pinned_only');
  const scope = idParam(params, 'scope');
  const includeRecent = nonNegativeParam(params, 'include_recent');
  const crossProject = flagParam(params, 'cross_project');
  return { q, budget, limit, pinnedOnly, scope, includeRecent, crossProject };
}

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
