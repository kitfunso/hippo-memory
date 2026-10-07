// Recall routes: /v1/memories search, assemble, drill and /v1/context.
import { dirname, resolve } from 'node:path';
import { assertCallerProject, resolveProjectIdentity, type ProjectRef } from '../../project-identity.js';
import { isSharedStore } from '../../config.js';
import { assembleCost, contextCost, drillCost } from '../../context-render.js';
import { closeHippoDb, openHippoDb } from '../../db.js';
import { updateStats } from '../../store/index-and-stats.js';
import { appendRecall, biasHintEnabled, buildSessionKey, getOrCreateRing, hashQueryText, RingBuffer, snapshotRing } from '../../recall-history.js';
import { appendAuditEvent, auditQueryFields } from '../../audit.js';
import { assemble, type AssembleOpts, type Context, drillDown, type DrillDownOpts, getContext, type RecallOpts, recordTokens, retrieve } from '../../api.js';
import { HttpError, MAX_ID_LEN, sendJson } from '../../http-util.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { parseListLimit, validateIdSegment } from '../validation.js';

// Module-level per-(tenant, session) recall-history ring map
// for the HTTP pipeline. Separate from CLI/MCP rings (per-
// pipeline rings; no IPC). HTTP is the only caller that threads its
// snapshot through opts.recallHistory to api.recall — api.recall's
// anchoringHint on the returned RecallResult IS the user-visible hint
// here (no separate compute needed).
const sessionRecallHistoryHttp = new Map<string, RingBuffer>();

/** Test-only: reset the module-level recall-history Map. Call from beforeEach. */
export function __resetSessionRecallHistoryHttp(): void {
  sessionRecallHistoryHttp.clear();
}

/** The /v1/memories query, parsed and checked in a fixed order so the first bad param is the one reported. */
interface RecallQuery {
  q: string;
  limit: number | undefined;
  mode: 'bm25' | 'hybrid' | 'physics' | null;
  scope: string | null;
  includeContinuity: boolean;
  freshTailCount: number | undefined;
  freshTailSessionId: string | undefined;
  summarizeOverflow: boolean | undefined;
  scorerWindow: number | undefined;
  sessionId: string | undefined;
  explain: boolean;
}

function parseFreshTail(query: URLSearchParams): Pick<RecallQuery, 'freshTailCount' | 'freshTailSessionId'> {
  // Surface the fresh-tail RecallOpts to HTTP callers so session-scoped
  // fresh-tail and summary substitution are not JS-only.
  const freshTailCountRaw = query.get('fresh_tail_count');
  const freshTailCount = freshTailCountRaw === null ? undefined : Number(freshTailCountRaw);
  if (freshTailCount !== undefined && (!Number.isFinite(freshTailCount) || freshTailCount < 0)) {
    throw new HttpError(400, 'fresh_tail_count must be a non-negative number');
  }
  // Cap session_id length consistent with the
  // rest of the API. Untrimmed strings round-trip through the SQL layer
  // and through any downstream metric/log; 256 is generous for a session
  // id and matches the rest of this file's id-shaped param parsers.
  const freshTailSessionIdRaw = query.get('fresh_tail_session_id');
  if (freshTailSessionIdRaw !== null && freshTailSessionIdRaw.length > MAX_ID_LEN) {
    throw new HttpError(400, `fresh_tail_session_id exceeds ${MAX_ID_LEN}-character cap`);
  }
  const freshTailSessionId = freshTailSessionIdRaw && freshTailSessionIdRaw.length > 0
    ? freshTailSessionIdRaw
    : undefined;
  return { freshTailCount, freshTailSessionId };
}

function parseSessionId(query: URLSearchParams): string | undefined {
  // session_id for the dlPFC goal-stack boost. 256-char cap mirrors
  // fresh_tail_session_id (above). Trim then drop if empty so api.recall
  // sees undefined when the param is omitted or whitespace-only.
  const sessionIdRaw = query.get('session_id');
  if (sessionIdRaw !== null && sessionIdRaw.length > MAX_ID_LEN) {
    throw new HttpError(400, `session_id exceeds ${MAX_ID_LEN}-character cap`);
  }
  return sessionIdRaw && sessionIdRaw.trim().length > 0
    ? sessionIdRaw.trim()
    : undefined;
}

function parseRecallQuery(query: URLSearchParams): RecallQuery {
  const q = query.get('q');
  if (!q) {
    throw new HttpError(400, 'q is required');
  }
  const limitRaw = query.get('limit');
  const limit = limitRaw === null ? undefined : parseListLimit(limitRaw);
  const mode = query.get('mode');
  if (mode !== null && mode !== 'bm25' && mode !== 'hybrid' && mode !== 'physics') {
    throw new HttpError(400, "mode must be 'bm25', 'hybrid', or 'physics'");
  }
  const scope = query.get('scope');
  const includeContinuityRaw = query.get('include_continuity');
  const includeContinuity = includeContinuityRaw === '1'
    || includeContinuityRaw === 'true';
  const { freshTailCount, freshTailSessionId } = parseFreshTail(query);
  // Strict parse matching the includeContinuity convention, so values
  // like `?summarize_overflow=banana` or an empty value do not turn it on.
  const summarizeOverflowRaw = query.get('summarize_overflow');
  const summarizeOverflow = summarizeOverflowRaw === null
    ? undefined
    : (summarizeOverflowRaw === '1' || summarizeOverflowRaw === 'true');
  // recall() owns the shape rule (NaN, 0 and negatives throw invalid_scorer_window); the transport caps remote cost.
  const scorerWindowRaw = query.get('scorer_window');
  const scorerWindow = scorerWindowRaw === null ? undefined : Number(scorerWindowRaw);
  if (scorerWindow !== undefined && scorerWindow > 1000) {
    throw new HttpError(400, 'scorer_window must be <= 1000');
  }
  const sessionId = parseSessionId(query);
  // Recall-trace: opt-in explain flag. When set, api.recall attaches the
  // lifecycle re-ranking trace (goal-boost step on the api pipeline) +
  // rerankPipeline:'api' to each result item; the field then rides on the
  // serialized RecallResult. Mirrors the include_continuity convention.
  const explainRaw = query.get('explain');
  const explain = explainRaw === '1' || explainRaw === 'true';
  return { q, limit, mode, scope, includeContinuity, freshTailCount, freshTailSessionId, summarizeOverflow, scorerWindow, sessionId, explain };
}

interface SessionRing {
  httpRecallHistory: ReturnType<typeof snapshotRing> | undefined;
  httpRingKey: string | undefined;
}

// HTTP per-pipeline anchoring detector. HTTP threads its
// ring snapshot via opts.recallHistory so api.recall's own
// anchoringHint compute path activates. Unlike CLI (which computes
// its own hint separately because cmdRecall runs its own physics/
// hybrid pipeline outside api.recall), HTTP's /v1/memories response
// body IS api.recall's result directly. So the api.recall-computed
// hint flows through. HIPPO_ANCHORING=off short-circuits.
function snapshotSessionRing(ctx: Context, hippoRoot: string, q: string, sessionId: string | undefined): SessionRing {
  let httpRecallHistory: ReturnType<typeof snapshotRing> | undefined;
  let httpRingKey: string | undefined;
  if (biasHintEnabled('anchoring')) {
    if (sessionId) {
      // Do NOT mutate sessionRecallHistoryHttp before recall() preflight: a request
      // that 400s would otherwise create-or-touch a ring and LRU-evict valid sessions.
      httpRingKey = buildSessionKey(ctx.tenantId, sessionId);
      const existingRing = sessionRecallHistoryHttp.get(httpRingKey);
      httpRecallHistory = existingRing ? snapshotRing(existingRing) : [];
    } else {
      // Telemetry: caller had no session_id so ring tracking skipped.
      // Per the normal recall-audit convention (api.ts:854 stores
      // SHA-256/16 hash of the query, NOT raw text), avoid retaining
      // prompts in audit_log here too — query content can contain
      // secrets, PII, or RTBF-restricted material. hashQueryText is a 32-bit
      // FNV-1a, NOT a privacy hash, so use the recall audit's SHA-256/16 truncation.
      const dbForAudit = openHippoDb(hippoRoot);
      try {
        appendAuditEvent(dbForAudit, {
          tenantId: ctx.tenantId,
          actor: ctx.actor.subject,
          op: 'recall_anchor_skipped_no_session',
          targetId: undefined,
          metadata: auditQueryFields(q),
        });
      } finally {
        closeHippoDb(dbForAudit);
      }
    }
  }
  return { httpRecallHistory, httpRingKey };
}

type RecallExtra = Pick<
  RecallOpts,
  'freshTailCount' | 'freshTailSessionId' | 'summarizeOverflow' | 'scorerWindow' | 'sessionId' | 'recallHistory' | 'explain'
>;

function recallExtraOpts(parsed: RecallQuery, httpRecallHistory: SessionRing['httpRecallHistory']): RecallExtra {
  const recallExtra: RecallExtra = {};
  if (parsed.freshTailCount !== undefined) recallExtra.freshTailCount = parsed.freshTailCount;
  if (parsed.freshTailSessionId !== undefined) recallExtra.freshTailSessionId = parsed.freshTailSessionId;
  if (parsed.summarizeOverflow !== undefined) recallExtra.summarizeOverflow = parsed.summarizeOverflow;
  if (parsed.scorerWindow !== undefined) recallExtra.scorerWindow = parsed.scorerWindow;
  if (parsed.sessionId !== undefined) recallExtra.sessionId = parsed.sessionId;
  if (httpRecallHistory !== undefined) recallExtra.recallHistory = httpRecallHistory;
  if (parsed.explain) recallExtra.explain = parsed.explain;
  return recallExtra;
}

// GET /v1/memories?q=...&limit=...&mode=...&scope=...&include_continuity=1
export async function handleRecallMemories({ req, res, opts, query }: RouteRequest): Promise<void> {
  const parsed = parseRecallQuery(query);
  const { q, includeContinuity, sessionId } = parsed;
  const ctx = await buildContextWithAuth(req, opts);

  const { httpRecallHistory, httpRingKey } = snapshotSessionRing(ctx, opts.hippoRoot, q, sessionId);

  const result = await retrieve(ctx, {
    query: q,
    limit: parsed.limit,
    mode: parsed.mode ?? undefined,
    scope: parsed.scope ?? undefined,
    includeContinuity,
    ...recallExtraOpts(parsed, httpRecallHistory),
  });

  // Append only after recall succeeds, so a 400 cannot LRU-evict valid sessions;
  // anchoredOn feeds the cooldown logic for the NEXT recall on this session.
  if (httpRingKey) {
    const httpRing = getOrCreateRing(sessionRecallHistoryHttp, httpRingKey);
    const topId = result.results[0]?.id ?? null;
    appendRecall(httpRing, hashQueryText(q), topId, result.anchoringHint?.memoryId);
  }

  // Each recall surface counts its own hits; api.recall is no chokepoint,
  // since the CLI never calls it and MCP shows the user a different band.
  updateStats(opts.hippoRoot, { recalled: result.results.length });

  // Continuity payloads should never be cached. The caller is asking for
  // session-state-aware data; intermediaries must not reuse it across users.
  if (includeContinuity) {
    res.setHeader('Cache-Control', 'no-store');
  }
  recordTokens(ctx, 'http_recall', { items: result.results.length, tokens: result.tokens + (result.continuityTokens ?? 0), sessionId: sessionId ?? null });
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
  const result = assemble(ctx, assembleMatch.id!, { ...assembleExtra, cost: assembleCost(assembleMatch.id!) });
  recordTokens(ctx, 'http_assemble', { items: result.items.length, tokens: result.tokens, sessionId: assembleMatch.id! });
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
  const result = drillDown(ctx, drillMatch.id!, { ...drillExtra, cost: drillCost });
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
  const q = query.get('q') ?? undefined;
  // DoS cap on q-param length. 1024 covers real multi-clause queries
  // (pasted error messages, multi-stem searches) while bounding BM25
  // tokenisation cost (~150 tokens worst case at 1024 chars).
  if (q !== undefined && q.length > 1024) {
    throw new HttpError(400, 'q exceeds 1024-character cap');
  }
  const budgetRaw = query.get('budget');
  let budget: number | undefined;
  if (budgetRaw !== null) {
    budget = Number(budgetRaw);
    if (!Number.isFinite(budget) || budget < 0) {
      throw new HttpError(400, 'budget must be a non-negative number');
    }
  }
  const limitRaw = query.get('limit');
  let limit: number | undefined;
  if (limitRaw !== null) {
    limit = Number(limitRaw);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new HttpError(400, 'limit must be a positive number');
    }
  }
  const pinnedOnlyRaw = query.get('pinned_only');
  const pinnedOnly = pinnedOnlyRaw === '1' || pinnedOnlyRaw === 'true';
  const scopeRaw = query.get('scope');
  if (scopeRaw !== null && scopeRaw.length > MAX_ID_LEN) {
    throw new HttpError(400, `scope exceeds ${MAX_ID_LEN}-character cap`);
  }
  const scope = scopeRaw === null ? undefined : scopeRaw;
  const includeRecentRaw = query.get('include_recent');
  let includeRecent: number | undefined;
  if (includeRecentRaw !== null) {
    includeRecent = Number(includeRecentRaw);
    if (!Number.isFinite(includeRecent) || includeRecent < 0) {
      throw new HttpError(400, 'include_recent must be a non-negative number');
    }
  }
  // v39 memory scope isolation: cross_project=1|true re-includes
  // other-project rows (tagged category 'cross-project' in the response).
  // The partition identity comes from the SERVED STORE's location, not the
  // daemon's process cwd - a daemon started from anywhere still isolates
  // the project it serves.
  const crossProjectRaw = query.get('cross_project');
  const crossProject = crossProjectRaw === '1' || crossProjectRaw === 'true';
  const ctx = await buildContextWithAuth(req, opts);
  const result = await getContext(ctx, {
    q,
    budget,
    limit,
    pinnedOnly,
    scope,
    includeRecent,
    crossProject,
    currentProject: contextReader(opts.hippoRoot, query),
    cost: contextCost('markdown', 'observe'), // clients render; the budget prices the block `hippo context` would print
  });
  recordTokens(ctx, 'http_context', { items: result.entries.length, tokens: result.tokens });
  sendJson(res, 200, result);
  return;
}
