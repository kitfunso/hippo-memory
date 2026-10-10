// /v1/decisions routes.
import { DECISION } from '../../objects/decisions.js';
import { HttpError, sendJson } from '../../util/http-util.js';
import { NotFoundError } from '../../core/api-errors.js';
import { type JsonValue, isJsonNumber } from '../../util/json.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { MAX_SHORT_FIELD_LEN, parseJsonBody } from '../validation.js';
import { saveFor } from '../../api/objects.js';
import { closeRoute, getRoute, listRoute, type ObjectRouteConfig, optionalString, requiredString, type RequiredStringRule } from './object-routes.js';

const decisionRoutes: ObjectRouteConfig<'decision'> = { noun: 'decision', field: 'decision', listField: 'decisions', object: DECISION };

const TEXT: RequiredStringRule = { max: MAX_SHORT_FIELD_LEN, untrimmed: true };

function supersededId(body: Record<string, JsonValue>): number | undefined {
  const raw = body['supersedesDecisionId'];
  if (raw === undefined || raw === null) return undefined;
  if (!isJsonNumber(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw new HttpError(400, 'supersedesDecisionId must be a positive integer');
  }
  return raw;
}

// Routes: /v1/decisions (create, list, show, supersede, close), Bearer-authed and tenant-scoped; status is validated against VALID_DECISION_STATES.
// The HTTP surface has no legacy --supersedes <memory-id> constraint, so it supersedes by table id and never weakens a memory mirror.
export async function handleCreateDecision(rr: RouteRequest): Promise<void> {
  const { req, res } = rr;
  const ctx = await buildContextWithAuth(req, rr.opts);
  const body = await parseJsonBody(req, ctx);
  const write = {
    decisionText: requiredString(body, 'text', TEXT),
    context: optionalString(body, 'context', MAX_SHORT_FIELD_LEN),
    supersedesDecisionId: supersededId(body),
  };
  try {
    const decision = await saveFor(ctx, DECISION, write);
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
export async function handleSupersedeDecision(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  const oldId = parseInt(match[1], 10);
  const ctx = await buildContextWithAuth(rr.req, rr.opts);
  const body = await parseJsonBody(rr.req, ctx);
  const decision = await saveFor(ctx, DECISION, {
    decisionText: requiredString(body, 'text', TEXT),
    context: optionalString(body, 'context', MAX_SHORT_FIELD_LEN),
    supersedesDecisionId: oldId,
  });
  sendJson(rr.res, 201, { decision });
}

export function handleCloseDecision(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return closeRoute(decisionRoutes, rr, match);
}

export function handleGetDecision(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return getRoute(decisionRoutes, rr, match);
}
