// /v1/incidents routes.
import { INCIDENT, openIncident, resolveOpenIncident } from '../../../domain/objects/incidents.js';
import { HttpError, sendJson } from '../../../base/util/http-util.js';
import { NotFoundError } from '../../../base/errors/api-errors.js';
import type { AuthedRouteRequest } from '../types.js';
import { MAX_SHORT_FIELD_LEN, parseJsonBody, getString, requiredString } from '../validation.js';
import { type JsonValue, isJsonString } from '../../../base/util/json.js';
import { objectsOf } from '../../../api/objects/objects.js';
import { closeRoute, getRoute, listRoute, type ObjectRouteConfig } from './object-routes.js';

const MAX_LINKED_MEMORY_IDS = 256;

const incidentRoutes: ObjectRouteConfig<'incident'> = {
  noun: 'incident',
  field: 'incident',
  listField: 'incidents',
  object: INCIDENT,
};

function linkedMemoryIds(body: Record<string, JsonValue>): string[] | undefined {
  const raw = body['linkedMemoryIds'];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new HttpError(400, 'linkedMemoryIds must be an array of memory ids');
  }
  if (raw.length > MAX_LINKED_MEMORY_IDS) {
    throw new HttpError(400, `linkedMemoryIds exceeds ${MAX_LINKED_MEMORY_IDS}-item cap`);
  }
  const isValidMemoryId = (item: JsonValue): item is string =>
    isJsonString(item) && item.length > 0 && item.length <= MAX_SHORT_FIELD_LEN;
  if (!raw.every(isValidMemoryId)) {
    throw new HttpError(400, `each linkedMemoryIds entry must be a non-empty string <= ${MAX_SHORT_FIELD_LEN} chars`);
  }
  return raw;
}

// Routes: /v1/incidents (open, list, show, resolve, close), mirroring /v1/decisions; status is validated against
// VALID_INCIDENT_STATES.
// Lifecycle is open->resolved->closed (no supersede), so linkedMemoryIds replaces supersedesDecisionId on create.
export async function handleCreateIncident(rr: AuthedRouteRequest): Promise<void> {
  const { req, res, ctx } = rr;
  const body = await parseJsonBody(req, ctx);
  const write = {
    incidentText: requiredString(body, 'text', { max: MAX_SHORT_FIELD_LEN, untrimmed: true }),
    context: getString(body, 'context', MAX_SHORT_FIELD_LEN),
    linkedMemoryIds: linkedMemoryIds(body),
  };
  try {
    const { defaultHalfLifeDays } = ctx.config;
    const incident = await openIncident(objectsOf(ctx), defaultHalfLifeDays, ctx.tenantId, write, ctx.actor.subject);
    sendJson(res, 201, { incident });
  } catch (e) {
    // A missing referenced row is a conflict with the create, not a missing target.
    if (e instanceof NotFoundError) throw new HttpError(409, e.message);
    throw e;
  }
}

export function handleListIncidents(rr: AuthedRouteRequest): Promise<void> {
  return listRoute(incidentRoutes, rr);
}

export async function handleResolveIncident(rr: AuthedRouteRequest, match: RegExpMatchArray): Promise<void> {
  const { req, res, ctx } = rr;
  const id = parseInt(match[1], 10);
  const resolutionText = requiredString(await parseJsonBody(req, ctx), 'resolutionText', { max: MAX_SHORT_FIELD_LEN });
  const incident = await resolveOpenIncident(objectsOf(ctx), ctx.tenantId, id, resolutionText, ctx.actor.subject);
  sendJson(res, 200, { incident });
}

export function handleCloseIncident(rr: AuthedRouteRequest, match: RegExpMatchArray): Promise<void> {
  return closeRoute(incidentRoutes, rr, match);
}

export function handleGetIncident(rr: AuthedRouteRequest, match: RegExpMatchArray): Promise<void> {
  return getRoute(incidentRoutes, rr, match);
}
