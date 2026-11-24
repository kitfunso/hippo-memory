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

function supersededId(body: Record<string, JsonValue>): number | undefined {
  const raw = body['supersedesDecisionId'];
  if (raw === undefined || raw === null) return undefined;
  if (!isJsonNumber(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw new HttpError(400, 'supersedesDecisionId must be a positive integer');
  }
  return raw;
}

function decisionOptions(body: Record<string, JsonValue>, pathId?: number) {
  return {
    decisionText: requiredString(body, 'text', TEXT),
    context: getString(body, 'context', MAX_SHORT_FIELD_LEN),
    supersedesDecisionId: pathId ?? supersededId(body),
  };
}

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
