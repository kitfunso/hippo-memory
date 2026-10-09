// Recall routes: /v1/memories search, assemble, drill and /v1/context.
import { dirname, resolve } from 'node:path';
import { assertCallerProject, resolveProjectIdentity, type ProjectRef } from '../../project-identity.js';
import { isSharedStore } from '../../config.js';
import { assembleCost, contextCost, drillCost } from '../../context-render.js';
import { storeFor } from '../../store-port.js';
import { biasHintEnabled, type RecallHistorySnapshot } from '../../recall-history.js';
import { assemble, type AssembleOpts, type Context, drillDown, type DrillDownOpts, getContext, recordTokens, retrieve } from '../../api.js';
import { httpParams, parseContextRequest, parseRecallRequest } from '../../api/recall-request.js';
import { anchorSkippedRows, noteRecall, peekSessionRing, resetSessionRings, sessionRing } from '../../api/recall-record.js';
import { HttpError, sendJson } from '../../http-util.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { validateIdSegment } from '../validation.js';

/** Test-only: reset the HTTP recall rings. Call from beforeEach. */
export function __resetSessionRecallHistoryHttp(): void {
  resetSessionRings('http');
}

// HTTP threads the ring through opts.recallHistory, so the hint retrieve() returns is the one the caller sees.
function recallHistoryFor(ctx: Context, sessionId: string | undefined): RecallHistorySnapshot | undefined {
  return sessionId && biasHintEnabled('anchoring') ? peekSessionRing('http', ctx.tenantId, sessionId) : undefined;
}

// GET /v1/memories?q=...&limit=...&mode=...&scope=...&include_continuity=1
export async function handleRecallMemories({ req, res, opts, query }: RouteRequest): Promise<void> {
  const { opts: recallOpts, limit, mode, explain } = parseRecallRequest(httpParams(query));
  const { query: q, includeContinuity, sessionId } = recallOpts;
  const ctx = await buildContextWithAuth(req, opts);

  const recallHistory = recallHistoryFor(ctx, sessionId);
  // Written first in the recall's own write, so a recall that fails leaves no row.
  const leadingAudit = sessionId ? [] : anchorSkippedRows({ tenantId: ctx.tenantId, actor: ctx.actor.subject }, q);
  const result = await retrieve(ctx, { ...recallOpts, limit, mode, explain, recallHistory, leadingAudit });

  // The ring is created only after recall succeeds, so a 400 cannot LRU-evict a live session.
  const ring = sessionRing('http', ctx.tenantId, sessionId);
  if (ring) noteRecall(ring, q, result.results[0]?.id ?? null, result.anchoringHint?.memoryId);

  // HTTP counts the rows it returns here; `retrieve` cannot count for every ranker, since MCP shows a different band and counts none.
  await storeFor(ctx).bumpRecallStats(result.results.length);

  // Continuity payloads should never be cached. The caller is asking for
  // session-state-aware data; intermediaries must not reuse it across users.
  if (includeContinuity) {
    res.setHeader('Cache-Control', 'no-store');
  }
  await recordTokens(ctx, 'http_recall', { items: result.results.length, tokens: result.tokens + (result.continuityTokens ?? 0), sessionId: sessionId ?? null });
  sendJson(res, 200, result);
  return;
}

// GET /v1/sessions/:id/assemble?budget=N&freshTail=N&summarizeOlder=0|1
// Phase 2 context-engine API. Returns ordered AssembledContextItem[]
// with fresh-tail raws + summary substitutions + bio-aware budget fit.
// Tenant scope from Bearer; default-deny on private rows.
export async function handleAssembleSession({ req, res, opts, query }: RouteRequest, assembleMatch: Record<string, string>): Promise<void> {
  validateIdSegment(assembleMatch.id!, 'session id');
  const budgetRaw = query.get('budget');
  const budget = budgetRaw === null ? undefined : Number(budgetRaw);
  if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) {
    throw new HttpError(400, 'budget must be a positive number');
  }
  const ftRaw = query.get('freshTail');
  const freshTailCount = ftRaw === null ? undefined : Number(ftRaw);
  if (freshTailCount !== undefined && (!Number.isFinite(freshTailCount) || freshTailCount < 0)) {
    throw new HttpError(400, 'freshTail must be a non-negative number');
  }
  // Same strict-parse convention as summarize_overflow on /v1/memories:
  // ?summarizeOlder=banana is false (matches includeContinuity convention).
  const sumOlderRaw = query.get('summarizeOlder');
  const summarizeOlder = sumOlderRaw === null
    ? undefined
    : (sumOlderRaw === '1' || sumOlderRaw === 'true');
  const scopeQ = query.get('scope');
  const scope = scopeQ !== null && scopeQ.length > 0 ? scopeQ : undefined;
  const ctx = await buildContextWithAuth(req, opts);
  const assembleExtra: Pick<AssembleOpts, 'budget' | 'freshTailCount' | 'summarizeOlder' | 'scope'> = {};
  if (budget !== undefined) assembleExtra.budget = budget;
  if (freshTailCount !== undefined) assembleExtra.freshTailCount = freshTailCount;
  if (summarizeOlder !== undefined) assembleExtra.summarizeOlder = summarizeOlder;
  if (scope !== undefined) assembleExtra.scope = scope;
  const result = await assemble(ctx, assembleMatch.id!, { ...assembleExtra, cost: assembleCost(assembleMatch.id!) });
  await recordTokens(ctx, 'http_assemble', { items: result.items.length, tokens: result.tokens, sessionId: assembleMatch.id! });
  sendJson(res, 200, result);
  return;
}

// GET /v1/recall/drill/:id?limit=N&budget=N
// Companion to /v1/memories. When recall surfaces a level-2 summary in
// place of overflowed children (RecallResultItem.isSummary === true), the
// caller drills into the summary id to recover the originals. Tenant
// scoped via Bearer; default-deny on private scopes for both summary
// and children.
export async function handleDrillRecall({ req, res, opts, query }: RouteRequest, drillMatch: Record<string, string>): Promise<void> {
  validateIdSegment(drillMatch.id!, 'summary id');
  const limitRaw = query.get('limit');
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new HttpError(400, 'limit must be a positive number');
  }
  const budgetRaw = query.get('budget');
  const budget = budgetRaw === null ? undefined : Number(budgetRaw);
  if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) {
    throw new HttpError(400, 'budget must be a positive number');
  }
  // depth query param walks N levels (default 1, hard cap 10).
  const depthRaw = query.get('depth');
  let depth: number | undefined;
  if (depthRaw !== null) {
    const parsed = Number(depthRaw);
    // Reject out-of-range explicitly (no silent clamp).
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
      throw new HttpError(400, 'depth must be a positive integer between 1 and 10');
    }
    depth = parsed;
  }
  const ctx = await buildContextWithAuth(req, opts);
  const drillExtra: Pick<DrillDownOpts, 'limit' | 'budget' | 'depth'> = {};
  if (limit !== undefined) drillExtra.limit = limit;
  if (budget !== undefined) drillExtra.budget = budget;
  if (depth !== undefined) drillExtra.depth = depth;
  const result = await drillDown(ctx, drillMatch.id!, { ...drillExtra, cost: drillCost });
  if ('failure' in result) {
    // Leaf id maps to 422 (caller-actionable). Other cases stay
    // as 404 to avoid leaking cross-tenant existence or scope grants.
    if (result.failure === 'not_drillable') {
      throw new HttpError(422, 'Id is a leaf row, not a level-2+ summary; nothing to drill into');
    }
    throw new HttpError(404, 'No drillable summary at this id');
  }
  sendJson(res, 200, result);
  return;
}

/** A shared store's folder is no caller's project, so the caller names it (`project`, repeated `alias`); with none, getContext refuses. */
function contextReader(hippoRoot: string, query: URLSearchParams): ProjectRef {
  if (!isSharedStore(hippoRoot)) return resolveProjectIdentity(dirname(resolve(hippoRoot)));
  const name = query.get('project');
  if (name === null) return '';
  const aliases = query.getAll('alias');
  assertCallerProject({ name, aliases });
  return { name, legacyName: name, aliases };
}

// GET /v1/context — assemble a budget-bounded context bundle. Returns
// ContextResult JSON (entries + tokens + activeSnapshot + sessionHandoff
// + recentEvents). No server-side rendering; clients render. Tenant-scoped
// via the Bearer. Pinned-only + '*' fallback skip the recall audit emit
// (matches cmdContext); real-query hybrid search emits one 'recall' row.
export async function handleGetContext({ req, res, opts, query }: RouteRequest): Promise<void> {
  const parsed = parseContextRequest(httpParams(query));
  const ctx = await buildContextWithAuth(req, opts);
  const result = await getContext(ctx, {
    ...parsed,
    currentProject: contextReader(opts.hippoRoot, query),
    cost: contextCost('markdown', 'observe'), // clients render; the budget prices the block `hippo context` would print
  });
  await recordTokens(ctx, 'http_context', { items: result.entries.length, tokens: result.tokens });
  sendJson(res, 200, result);
  return;
}
