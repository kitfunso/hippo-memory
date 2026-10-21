// POST /v1/vectors/nearest: the ids nearest a query vector, from the served store's vector graph, so a CLI on this host
// asks the daemon instead of scanning every stored vector itself.
import { nearestMemoryIds } from '../../../api/recall/nearest.js';
import type { RecallScopeFilter } from '../../../base/scope/recall-scope.js';
import { HttpError, sendJson } from '../../../base/util/http-util.js';
import { isJsonBoolean, isJsonObject, isJsonString, type JsonValue } from '../../../base/util/json.js';
import { MAX_ID_LEN, MAX_LIST_LIMIT } from '../../../base/util/limits.js';
import type { VectorCandidateSpec } from '../../../store/port/vector-reads.js';
import type { AuthedRouteRequest } from '../types.js';
import { parseJsonBody } from '../validation.js';

// Past the longest vector any configured provider returns (3072), so a real query always fits.
const MAX_VECTOR_DIM = 4096;
// Origins name projects, and a recall names its own and a few aliases.
const MAX_ORIGINS = 64;

export async function handleNearestVectors({ req, res, ctx }: AuthedRouteRequest): Promise<void> {
  const body = await parseJsonBody(req, ctx);
  const ids = await nearestMemoryIds(ctx, vectorOf(body['vector']), specOf(body['spec']));
  sendJson(res, 200, { ids });
}

function vectorOf(raw: JsonValue | undefined): number[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_VECTOR_DIM) {
    throw new HttpError(400, `vector must be an array of 1 to ${MAX_VECTOR_DIM} numbers`);
  }
  if (!raw.every((x): x is number => typeof x === 'number' && Number.isFinite(x))) {
    throw new HttpError(400, 'vector must hold finite numbers only');
  }
  return raw;
}

function idText(raw: JsonValue | undefined, field: string): string {
  if (!isJsonString(raw) || raw.length > MAX_ID_LEN) {
    throw new HttpError(400, `${field} must be a string of at most ${MAX_ID_LEN} characters`);
  }
  return raw;
}

function specOf(raw: JsonValue | undefined): VectorCandidateSpec {
  if (raw === undefined || !isJsonObject(raw)) throw new HttpError(400, 'spec must be an object');
  const { tenantId, includeSuperseded, limit, scope, origin } = raw;
  if (!isJsonBoolean(includeSuperseded)) throw new HttpError(400, 'spec.includeSuperseded must be a boolean');
  if (limit !== undefined && !(Number.isInteger(limit) && Number(limit) >= 1 && Number(limit) <= MAX_LIST_LIMIT)) {
    throw new HttpError(400, `spec.limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
  }
  return {
    tenantId: idText(tenantId, 'spec.tenantId'),
    includeSuperseded,
    ...(limit !== undefined && { limit: Number(limit) }),
    ...(scope !== undefined && { scope: scopeOf(scope) }),
    ...(origin !== undefined && { origin: originOf(origin) }),
  };
}

function scopeOf(raw: JsonValue): RecallScopeFilter {
  if (!isJsonObject(raw)) throw new HttpError(400, 'spec.scope must be an object');
  const own = raw['ownScope'] === undefined ? {} : { ownScope: idText(raw['ownScope'], 'spec.scope.ownScope') };
  if (raw['mode'] === 'default-deny') return { mode: 'default-deny', ...own };
  const value = idText(raw['value'], 'spec.scope.value');
  if (raw['mode'] === 'exact') return { mode: 'exact', value };
  if (raw['mode'] === 'default-deny-or-exact') return { mode: 'default-deny-or-exact', value, ...own };
  throw new HttpError(400, 'spec.scope.mode must be default-deny, exact or default-deny-or-exact');
}

function originOf(raw: JsonValue): string | string[] {
  if (isJsonString(raw)) return idText(raw, 'spec.origin');
  if (!Array.isArray(raw) || raw.length > MAX_ORIGINS) {
    throw new HttpError(400, `spec.origin must be a string or a list of at most ${MAX_ORIGINS}`);
  }
  return raw.map((o) => idText(o, 'spec.origin'));
}
