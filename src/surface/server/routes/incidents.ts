// /v1/incidents routes: open, list, show, resolve and close. The lifecycle is open, resolved, closed with no supersede,
// so linkedMemoryIds takes supersedesDecisionId's place on create.
import { incidentOpen, incidentResolve } from '../../../api/objects/object-kinds.js';
import { HttpError, sendJson } from '../../../base/util/http-util.js';
import type { AuthedRouteRequest } from '../types.js';
import { parseJsonBody, getString, requiredString } from '../validation.js';
import { MAX_SHORT_FIELD_LEN } from '../../../base/util/limits.js';
import { type JsonValue, isJsonString } from '../../../base/util/json.js';
import type { ObjectRouteConfig } from './object-routes.js';

const MAX_LINKED_MEMORY_IDS = 256;

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

async function handleResolveIncident(rr: AuthedRouteRequest, id: number): Promise<void> {
  const { req, res, ctx } = rr;
  const resolutionText = requiredString(await parseJsonBody(req, ctx), 'resolutionText', { max: MAX_SHORT_FIELD_LEN });
  sendJson(res, 200, { incident: await incidentResolve(ctx, id, resolutionText) });
}

export const INCIDENT_ROUTES: ObjectRouteConfig<'incident'> = {
  base: '/v1/incidents',
  kind: 'incident',
  noun: 'incident',
  field: 'incident',
  listField: 'incidents',
  create: (ctx, body) =>
    incidentOpen(ctx, {
      incidentText: requiredString(body, 'text', { max: MAX_SHORT_FIELD_LEN, untrimmed: true }),
      context: getString(body, 'context', MAX_SHORT_FIELD_LEN),
      linkedMemoryIds: linkedMemoryIds(body),
    }),
  actions: { resolve: handleResolveIncident },
};
