// /v1/incidents routes: open, list, show, resolve and close. The lifecycle is open, resolved, closed with no supersede,
// so linkedMemoryIds takes supersedesDecisionId's place on create.
import { incidentOpen, incidentResolve } from '../../../api/objects/object-kinds.js';
import { sendJson } from '../../http/http-util.js';
import type { AuthedRouteRequest } from '../types.js';
import { parseJsonBody, getString, getStringArray, requiredString } from '../validation.js';
import { MAX_SHORT_FIELD_LEN } from '../../../base/util/limits.js';
import type { JsonValue } from '../../../base/util/json.js';
import type { ObjectRouteConfig } from './object-routes.js';

const MAX_LINKED_MEMORY_IDS = 256;

function linkedMemoryIds(body: Record<string, JsonValue>): string[] | undefined {
  const entry = `each linkedMemoryIds entry must be a non-empty string <= ${MAX_SHORT_FIELD_LEN} chars`;
  return getStringArray(body, 'linkedMemoryIds', MAX_LINKED_MEMORY_IDS, MAX_SHORT_FIELD_LEN, {
    nonEmpty: 'raw',
    messages: {
      notArray: 'linkedMemoryIds must be an array of memory ids',
      itemType: entry,
      empty: entry,
      length: entry,
    },
  });
}

async function handleResolveIncident(rr: AuthedRouteRequest, id: number): Promise<void> {
  const { req, res, ctx } = rr;
  const resolutionText = requiredString(await parseJsonBody(req, ctx), 'resolutionText', {
    max: MAX_SHORT_FIELD_LEN,
  });
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
      incidentText: requiredString(body, 'text', { max: MAX_SHORT_FIELD_LEN }),
      context: getString(body, 'context', MAX_SHORT_FIELD_LEN),
      linkedMemoryIds: linkedMemoryIds(body),
    }),
  actions: { resolve: handleResolveIncident },
};
