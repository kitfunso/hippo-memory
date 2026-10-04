// /v1/decisions routes.
import { closeDecision, loadDecisionById, loadDecisions, saveDecision, VALID_DECISION_STATES } from '../../decisions.js';
import { HttpError, sendJson } from '../../http-util.js';
import { NotFoundError } from '../../api-errors.js';
import { buildContextWithAuth } from '../auth.js';
import { byCreatedAt, pageOf, parseCursor } from '../cursor.js';
import type { RouteRequest } from '../types.js';
import { isJsonNumber, isJsonString, isSetMember, parseJsonBody, parseListLimit } from '../validation.js';

// ── decisions (E2 first-class object) ──
//
// 5 routes: POST /v1/decisions (create, optional supersedesDecisionId),
// GET /v1/decisions (list, status filter), GET /v1/decisions/:id (show),
// POST /v1/decisions/:id/supersede (create a successor + supersede :id),
// POST /v1/decisions/:id/close (retire). Bearer-authed + tenant-scoped via
// buildContextWithAuth. status validated against VALID_DECISION_STATES.
// DoS caps: text 4096, context 4096 (v1.11.4 pattern). The HTTP surface is
// new (no legacy --supersedes <memory-id> constraint), so it supersedes by
// table id and never weakens a memory mirror.
export async function handleCreateDecision({ req, res, opts }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const text = body['text'];
  if (!isJsonString(text) || text.length === 0) {
    throw new HttpError(400, 'text is required (non-empty string)');
  }
  if (text.length > 4096) {
    throw new HttpError(400, 'text exceeds 4096-character cap');
  }
  const contextRaw = body['context'];
  let context: string | undefined;
  if (contextRaw !== undefined && contextRaw !== null) {
    if (!isJsonString(contextRaw)) {
      throw new HttpError(400, 'context must be a string');
    }
    if (contextRaw.length > 4096) {
      throw new HttpError(400, 'context exceeds 4096-character cap');
    }
    context = contextRaw;
  }
  const supRaw = body['supersedesDecisionId'];
  let supersedesDecisionId: number | undefined;
  if (supRaw !== undefined && supRaw !== null) {
    if (!isJsonNumber(supRaw) || !Number.isInteger(supRaw) || supRaw <= 0) {
      throw new HttpError(400, 'supersedesDecisionId must be a positive integer');
    }
    supersedesDecisionId = supRaw;
  }
  try {
    const decision = saveDecision(opts.hippoRoot, ctx.tenantId, {
      decisionText: text,
      context,
      supersedesDecisionId,
    }, ctx.actor.subject);
    sendJson(res, 201, { decision });
  } catch (e) {
    // A missing referenced row is a conflict with the create, not a missing target.
    if (e instanceof NotFoundError) throw new HttpError(409, e.message);
    throw e;
  }
  return;
}

export async function handleListDecisions({ req, res, opts, query }: RouteRequest): Promise<void> {
  const status = query.get('status') ?? 'all';
  const limit = parseListLimit(query.get('limit'));
  const after = parseCursor(query.get('cursor'), 'string', 'integer');
  const ctx = await buildContextWithAuth(req, opts);
  let decisions;
  if (status === 'all') {
    decisions = loadDecisions(opts.hippoRoot, ctx.tenantId, { limit: limit + 1, after });
  } else {
    if (!isSetMember(VALID_DECISION_STATES, status)) {
      throw new HttpError(400, `status must be one of: active | superseded | closed | all (got "${status}")`);
    }
    decisions = loadDecisions(opts.hippoRoot, ctx.tenantId, {
      status,
      limit: limit + 1,
      after,
    });
  }
  const page = pageOf(decisions, limit, byCreatedAt);
  sendJson(res, 200, { decisions: page.items, next_cursor: page.nextCursor });
  return;
}

export async function handleSupersedeDecision({ req, res, opts }: RouteRequest, decisionSupersedeMatch: RegExpMatchArray): Promise<void> {
  const oldId = parseInt(decisionSupersedeMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const text = body['text'];
  if (!isJsonString(text) || text.length === 0) {
    throw new HttpError(400, 'text is required (non-empty string)');
  }
  if (text.length > 4096) {
    throw new HttpError(400, 'text exceeds 4096-character cap');
  }
  const contextRaw = body['context'];
  let context: string | undefined;
  if (contextRaw !== undefined && contextRaw !== null) {
    if (!isJsonString(contextRaw)) {
      throw new HttpError(400, 'context must be a string');
    }
    if (contextRaw.length > 4096) {
      throw new HttpError(400, 'context exceeds 4096-character cap');
    }
    context = contextRaw;
  }
  const decision = saveDecision(opts.hippoRoot, ctx.tenantId, {
    decisionText: text,
    context,
    supersedesDecisionId: oldId,
  }, ctx.actor.subject);
  sendJson(res, 201, { decision });
  return;
}

export async function handleCloseDecision({ req, res, opts }: RouteRequest, decisionCloseMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(decisionCloseMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const decision = closeDecision(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
  sendJson(res, 200, { decision });
  return;
}

export async function handleGetDecision({ req, res, opts }: RouteRequest, decisionByIdMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(decisionByIdMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const decision = loadDecisionById(opts.hippoRoot, ctx.tenantId, id);
  if (!decision) {
    throw new HttpError(404, `decision ${id} not found`);
  }
  sendJson(res, 200, { decision });
  return;
}
