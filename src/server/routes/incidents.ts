// /v1/incidents routes.
import { closeIncident, loadIncidentById, loadIncidents, resolveIncident, saveIncident, VALID_INCIDENT_STATES } from '../../incidents.js';
import { HttpError, type JsonValue, sendJson } from '../../http-util.js';
import { NotFoundError } from '../../api-errors.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { isJsonString, isSetMember, parseJsonBody, parseListLimit } from '../validation.js';

// ── incidents (E2 first-class object) ──
//
// 5 routes: POST /v1/incidents (open; body text + context + linkedMemoryIds[]),
// GET /v1/incidents (list, status filter), GET /v1/incidents/:id (show),
// POST /v1/incidents/:id/resolve (open -> resolved; body resolutionText),
// POST /v1/incidents/:id/close (open|resolved -> closed). Bearer-authed +
// tenant-scoped via buildContextWithAuth. status validated against
// VALID_INCIDENT_STATES. DoS caps: text 4096, context 4096, resolutionText
// 4096 (v1.11.4 pattern). Mirrors /v1/decisions; lifecycle is
// open->resolved->closed (no supersede), so linkedMemoryIds replaces
// supersedesDecisionId on create.
export async function handleCreateIncident({ req, res, opts }: RouteRequest): Promise<void> {
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
  const linkedRaw = body['linkedMemoryIds'];
  let linkedMemoryIds: string[] | undefined;
  if (linkedRaw !== undefined && linkedRaw !== null) {
    if (!Array.isArray(linkedRaw)) {
      throw new HttpError(400, 'linkedMemoryIds must be an array of memory ids');
    }
    if (linkedRaw.length > 256) {
      throw new HttpError(400, 'linkedMemoryIds exceeds 256-item cap');
    }
    const isValidMemoryId = (item: JsonValue): item is string =>
      isJsonString(item) && item.length > 0 && item.length <= 4096;
    if (!linkedRaw.every(isValidMemoryId)) {
      throw new HttpError(400, 'each linkedMemoryIds entry must be a non-empty string <= 4096 chars');
    }
    linkedMemoryIds = linkedRaw;
  }
  try {
    const incident = saveIncident(opts.hippoRoot, ctx.tenantId, {
      incidentText: text,
      context,
      linkedMemoryIds,
    }, ctx.actor.subject);
    sendJson(res, 201, { incident });
  } catch (e) {
    // A missing referenced row is a conflict with the create, not a missing target.
    if (e instanceof NotFoundError) throw new HttpError(409, e.message);
    throw e;
  }
  return;
}

export async function handleListIncidents({ req, res, opts, query }: RouteRequest): Promise<void> {
  const status = query.get('status') ?? 'all';
  const limit = parseListLimit(query.get('limit'));
  const ctx = await buildContextWithAuth(req, opts);
  let incidents;
  if (status === 'all') {
    incidents = loadIncidents(opts.hippoRoot, ctx.tenantId, { limit });
  } else {
    if (!isSetMember(VALID_INCIDENT_STATES, status)) {
      throw new HttpError(400, `status must be one of: open | resolved | closed | all (got "${status}")`);
    }
    incidents = loadIncidents(opts.hippoRoot, ctx.tenantId, {
      status,
      limit,
    });
  }
  sendJson(res, 200, { incidents });
  return;
}

export async function handleResolveIncident({ req, res, opts }: RouteRequest, incidentResolveMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(incidentResolveMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const resolutionText = body['resolutionText'];
  if (!isJsonString(resolutionText) || resolutionText.trim().length === 0) {
    throw new HttpError(400, 'resolutionText is required (non-empty string)');
  }
  if (resolutionText.length > 4096) {
    throw new HttpError(400, 'resolutionText exceeds 4096-character cap');
  }
  const incident = resolveIncident(opts.hippoRoot, ctx.tenantId, id, resolutionText, ctx.actor.subject);
  sendJson(res, 200, { incident });
  return;
}

export async function handleCloseIncident({ req, res, opts }: RouteRequest, incidentCloseMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(incidentCloseMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const incident = closeIncident(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
  sendJson(res, 200, { incident });
  return;
}

export async function handleGetIncident({ req, res, opts }: RouteRequest, incidentByIdMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(incidentByIdMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const incident = loadIncidentById(opts.hippoRoot, ctx.tenantId, id);
  if (!incident) {
    throw new HttpError(404, `incident ${id} not found`);
  }
  sendJson(res, 200, { incident });
  return;
}
