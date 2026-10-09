// /v1/incidents routes.
import { closeIncident, type Incident, type IncidentStatus, loadIncidentById, loadIncidents, resolveIncident, saveIncident, VALID_INCIDENT_STATES } from '../../incidents.js';
import { HttpError, sendJson } from '../../http-util.js';
import { NotFoundError } from '../../api-errors.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { parseJsonBody } from '../validation.js';
import { type JsonValue, isJsonString } from '../../json.js';
import { closeRoute, getRoute, listRoute, type ObjectRouteConfig, optionalString, requiredString } from './object-routes.js';

const MAX_LINKED_MEMORY_IDS = 256;

const incidentRoutes: ObjectRouteConfig<Incident, IncidentStatus> = {
  noun: 'incident',
  field: 'incident',
  listField: 'incidents',
  statuses: VALID_INCIDENT_STATES,
  list: loadIncidents,
  get: loadIncidentById,
  close: closeIncident,
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
    isJsonString(item) && item.length > 0 && item.length <= 4096;
  if (!raw.every(isValidMemoryId)) {
    throw new HttpError(400, 'each linkedMemoryIds entry must be a non-empty string <= 4096 chars');
  }
  return raw;
}

// ── incidents (first-class object) ──
//
// 5 routes: POST /v1/incidents (open; body text + context + linkedMemoryIds[]),
// GET /v1/incidents (list, status filter), GET /v1/incidents/:id (show),
// POST /v1/incidents/:id/resolve (open -> resolved; body resolutionText),
// POST /v1/incidents/:id/close (open|resolved -> closed). Bearer-authed +
// tenant-scoped via buildContextWithAuth. status validated against
// VALID_INCIDENT_STATES. DoS caps: text 4096, context 4096, resolutionText
// 4096. Mirrors /v1/decisions; lifecycle is
// open->resolved->closed (no supersede), so linkedMemoryIds replaces
// supersedesDecisionId on create.
export async function handleCreateIncident({ req, res, opts }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const write = {
    incidentText: requiredString(body, 'text', { max: 4096, untrimmed: true }),
    context: optionalString(body, 'context', 4096),
    linkedMemoryIds: linkedMemoryIds(body),
  };
  try {
    const incident = saveIncident(opts.hippoRoot, ctx.tenantId, write, ctx.actor.subject);
    sendJson(res, 201, { incident });
  } catch (e) {
    // A missing referenced row is a conflict with the create, not a missing target.
    if (e instanceof NotFoundError) throw new HttpError(409, e.message);
    throw e;
  }
}

export function handleListIncidents(rr: RouteRequest): Promise<void> {
  return listRoute(incidentRoutes, rr);
}

export async function handleResolveIncident({ req, res, opts }: RouteRequest, match: RegExpMatchArray): Promise<void> {
  const id = parseInt(match[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const resolutionText = requiredString(await parseJsonBody(req, ctx), 'resolutionText', { max: 4096 });
  const incident = resolveIncident(opts.hippoRoot, ctx.tenantId, id, resolutionText, ctx.actor.subject);
  sendJson(res, 200, { incident });
}

export function handleCloseIncident(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return closeRoute(incidentRoutes, rr, match);
}

export function handleGetIncident(rr: RouteRequest, match: RegExpMatchArray): Promise<void> {
  return getRoute(incidentRoutes, rr, match);
}
