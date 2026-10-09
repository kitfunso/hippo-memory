// /v1/decisions routes.
import { closeDecision, type Decision, type DecisionStatus, loadDecisionById, loadDecisions, saveDecision, VALID_DECISION_STATES } from '../../decisions.js';
import { HttpError, sendJson } from '../../http-util.js';
import { NotFoundError } from '../../api-errors.js';
import { type JsonValue, isJsonNumber } from '../../json.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { parseJsonBody } from '../validation.js';
import { closeRoute, getRoute, listRoute, type ObjectRouteConfig, optionalString, requiredString, type RequiredStringRule } from './object-routes.js';

const decisionRoutes: ObjectRouteConfig<Decision, DecisionStatus> = {
  noun: 'decision',
  field: 'decision',
  listField: 'decisions',
  statuses: VALID_DECISION_STATES,
  list: loadDecisions,
  get: loadDecisionById,
  close: closeDecision,
};

const TEXT: RequiredStringRule = { max: 4096, untrimmed: true };

function supersededId(body: Record<string, JsonValue>): number | undefined {
  const raw = body['supersedesDecisionId'];
  if (raw === undefined || raw === null) return undefined;
  if (!isJsonNumber(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw new HttpError(400, 'supersedesDecisionId must be a positive integer');
  }
  return raw;
}

// ── decisions (first-class object) ──
//
// 5 routes: POST /v1/decisions (create, optional supersedesDecisionId),
// GET /v1/decisions (list, status filter), GET /v1/decisions/:id (show),
// POST /v1/decisions/:id/supersede (create a successor + supersede :id),
// POST /v1/decisions/:id/close (retire). Bearer-authed + tenant-scoped via
// buildContextWithAuth. status validated against VALID_DECISION_STATES.
// DoS caps: text 4096, context 4096. The HTTP surface is
// new (no legacy --supersedes <memory-id> constraint), so it supersedes by
// table id and never weakens a memory mirror.
export async function handleCreateDecision({ req, res, opts }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const write = {
    decisionText: requiredString(body, 'text', TEXT),
    context: optionalString(body, 'context', 4096),
    supersedesDecisionId: supersededId(body),
  };
  try {
    const decision = saveDecision(opts.hippoRoot, ctx.tenantId, write, ctx.actor.subject);
    sendJson(res, 201, { decision });
  } catch (e) {
    // A missing referenced row is a conflict with the create, not a missing target.
    if (e instanceof NotFoundError) throw new HttpError(409, e.message);
    throw e;
  }
}

export function handleListDecisions(rr: RouteRequest): Promise<void> {
  return listRoute(decisionRoutes, rr);
}

// Not on supersedeRoute: this one answers 201 and leaves the missing-row 404 to the store, where the other five answer 200 after their own lookup.
export async function handleSupersedeDecision({ req, res, opts }: RouteRequest, match: RegExpMatchArray): Promise<void> {
  const oldId = parseInt(match[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const decision = saveDecision(opts.hippoRoot, ctx.tenantId, {
    decisionText: requiredString(body, 'text', TEXT),
    context: optionalString(body, 'context', 4096),
    supersedesDecisionId: oldId,
  }, ctx.actor.subject);
  sendJson(res, 201, { decision });
}

export function handleCloseDecision(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return closeRoute(decisionRoutes, rr, match);
}

export function handleGetDecision(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return getRoute(decisionRoutes, rr, match);
}
