// /v1/decisions routes.
import { objectCreate } from '../../../api/objects/objects.js';
import { HttpError } from '../../../base/errors/http-errors.js';
import { sendJson } from '../../http/http-util.js';
import { type JsonValue, isJsonNumber } from '../../../base/util/json.js';
import {
  parseJsonBody,
  getString,
  requiredString,
  type RequiredStringRule,
} from '../validation.js';
import { MAX_SHORT_FIELD_LEN } from '../../../base/util/limits.js';
import type { ObjectRouteConfig } from './object-routes.js';
import type { ObjectRequest } from './kind-routes.js';

const TEXT: RequiredStringRule = { max: MAX_SHORT_FIELD_LEN };

// The HTTP surface has no legacy --supersedes <memory-id> constraint, so it supersedes by table id
// and never weakens a memory mirror.
function supersededId(body: Record<string, JsonValue>): number | undefined {
  const raw = body['supersedesDecisionId'];
  if (raw === undefined || raw === null) return undefined;
  if (!isJsonNumber(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw new HttpError(400, 'supersedesDecisionId must be a positive integer');
  }
  return raw;
}

// A supersede takes the id from its path. A create reads the body field last, so a bad text is
// reported first.
function decisionOptions(body: Record<string, JsonValue>, pathId?: number) {
  return {
    decisionText: requiredString(body, 'text', TEXT),
    context: getString(body, 'context', MAX_SHORT_FIELD_LEN),
    supersedesDecisionId: pathId ?? supersededId(body),
  };
}

// Not the shared supersede: this one answers 201 and leaves the missing-row 404 to the store, where
// the other kinds answer 200 after their own lookup.
async function handleSupersedeDecision(rr: ObjectRequest, id: number): Promise<void> {
  const { ctx } = rr;
  const body = await parseJsonBody(rr.req, ctx);
  const decision = await objectCreate(ctx, 'decision', decisionOptions(body, id));
  sendJson(rr.res, 201, { decision });
}

export const DECISION_ROUTES: ObjectRouteConfig<'decision'> = {
  base: '/v1/decisions',
  kind: 'decision',
  noun: 'decision',
  field: 'decision',
  listField: 'decisions',
  create: (ctx, body) => objectCreate(ctx, 'decision', decisionOptions(body)),
  actions: { supersede: handleSupersedeDecision },
};
