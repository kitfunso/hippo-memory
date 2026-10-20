// /v1/decisions routes.
import { objectCreate } from '../../../api/objects/objects.js';
import { HttpError, sendJson } from '../../../base/util/http-util.js';
import { type JsonValue, isJsonNumber } from '../../../base/util/json.js';
import type { AuthedRouteRequest } from '../types.js';
import {
  MAX_SHORT_FIELD_LEN,
  parseJsonBody,
  getString,
  requiredString,
  type RequiredStringRule,
} from '../validation.js';
import type { ObjectRouteConfig } from './object-routes.js';

const TEXT: RequiredStringRule = { max: MAX_SHORT_FIELD_LEN, untrimmed: true };

// The HTTP surface has no legacy --supersedes <memory-id> constraint, so it supersedes by table id and never weakens a
// memory mirror.
function supersededId(body: Record<string, JsonValue>): number | undefined {
  const raw = body['supersedesDecisionId'];
  if (raw === undefined || raw === null) return undefined;
  if (!isJsonNumber(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw new HttpError(400, 'supersedesDecisionId must be a positive integer');
  }
  return raw;
}

// Not the shared supersede: this one answers 201 and leaves the missing-row 404 to the store, where the other kinds
// answer 200 after their own lookup.
async function handleSupersedeDecision(rr: AuthedRouteRequest, id: number): Promise<void> {
  const { ctx } = rr;
  const body = await parseJsonBody(rr.req, ctx);
  const decision = await objectCreate(ctx, 'decision', {
    decisionText: requiredString(body, 'text', TEXT),
    context: getString(body, 'context', MAX_SHORT_FIELD_LEN),
    supersedesDecisionId: id,
  });
  sendJson(rr.res, 201, { decision });
}

export const DECISION_ROUTES: ObjectRouteConfig<'decision'> = {
  base: '/v1/decisions',
  kind: 'decision',
  noun: 'decision',
  field: 'decision',
  listField: 'decisions',
  create: (ctx, body) =>
    objectCreate(ctx, 'decision', {
      decisionText: requiredString(body, 'text', TEXT),
      context: getString(body, 'context', MAX_SHORT_FIELD_LEN),
      supersedesDecisionId: supersededId(body),
    }),
  actions: { supersede: handleSupersedeDecision },
};
