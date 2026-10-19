// Memory write routes: create, graph, archive, supersede, promote, forget, outcome, sleep.
import { graphEntityOf, graphRows } from '../../api/objects/graph.js';
import { rawArchive, forget, outcome, outcomeForLastRecall, promote, remember, supersede } from '../../api/index.js';
import { MEMORY_KINDS, type MemoryKind } from '../../core/memory.js';
import { graphModelOf } from '../../graph/view.js';
import { HttpError, sendJson } from '../../util/http-util.js';
import { sleepInChild } from '../sleep-offload.js';
import { withLastRecall } from '../store-edge.js';
import type { AuthedRouteRequest } from '../types.js';
import {
  getCallerProject,
  getString,
  getStringArray,
  isSetMember,
  MAX_ARRAY_ITEMS,
  MAX_CONTENT_LEN,
  MAX_SHORT_FIELD_LEN,
  parseJsonBody,
  parseListLimit,
  validateIdSegment,
} from '../validation.js';
import { MAX_ID_LEN } from '../../util/limits.js';
import { type JsonValue, isJsonString, isJsonBoolean } from '../../util/json.js';

const VALID_KINDS: ReadonlySet<MemoryKind> = new Set(MEMORY_KINDS);
const MAX_OUTCOME_IDS = 1000;

// POST /v1/memories
export async function handleCreateMemory({ req, res, ctx }: AuthedRouteRequest): Promise<void> {
  const body = await parseJsonBody(req, ctx);
  const content = getString(body, 'content', MAX_CONTENT_LEN);
  if (!content) {
    throw new HttpError(400, 'content is required');
  }
  const kindRaw = getString(body, 'kind', MAX_ID_LEN);
  if (kindRaw !== undefined && !isSetMember(VALID_KINDS, kindRaw)) {
    throw new HttpError(400, `invalid kind: ${kindRaw}`);
  }
  const personalRaw = body['personal'];
  if (personalRaw !== undefined && !isJsonBoolean(personalRaw)) {
    throw new HttpError(400, 'personal must be a boolean');
  }
  const result = await remember(ctx, {
    content,
    kind: kindRaw,
    scope: getString(body, 'scope', MAX_ID_LEN),
    owner: getString(body, 'owner', MAX_ID_LEN),
    artifactRef: getString(body, 'artifactRef', MAX_SHORT_FIELD_LEN),
    tags: getStringArray(body, 'tags', MAX_ARRAY_ITEMS, MAX_ID_LEN),
    project: getCallerProject(body),
    personal: personalRaw === true,
  });
  sendJson(res, 200, result);
  return;
}

// GET /v1/graph?entity=NAME&limit=N — read-only entity/relation graph (tenant-scoped)
export async function handleGetGraph({ res, ctx, query }: AuthedRouteRequest): Promise<void> {
  const entity = graphEntityOf(query.get('entity'));
  const limit = parseListLimit(query.get('limit'));
  const rows = await graphRows(ctx, { entity, limit });
  sendJson(res, 200, graphModelOf(rows));
  return;
}

// /v1/memories/:id/* and DELETE /v1/memories/:id
export async function handleArchiveMemory(
  { req, res, ctx }: AuthedRouteRequest,
  archiveMatch: Record<string, string>,
): Promise<void> {
  validateIdSegment(archiveMatch.id!, 'memory id');
  const body = await parseJsonBody(req, ctx);
  const reason = getString(body, 'reason', MAX_SHORT_FIELD_LEN);
  if (!reason) {
    throw new HttpError(400, 'reason is required');
  }
  const result = await rawArchive(ctx, archiveMatch.id!, reason);
  sendJson(res, 200, result);
  return;
}

export async function handleSupersedeMemory(
  { req, res, ctx }: AuthedRouteRequest,
  supersedeMatch: Record<string, string>,
): Promise<void> {
  validateIdSegment(supersedeMatch.id!, 'memory id');
  const body = await parseJsonBody(req, ctx);
  const content = getString(body, 'content', MAX_CONTENT_LEN);
  if (!content) {
    throw new HttpError(400, 'content is required');
  }
  const result = await supersede(ctx, supersedeMatch.id!, content);
  sendJson(res, 200, result);
  return;
}

export async function handlePromoteMemory(
  { res, ctx }: AuthedRouteRequest,
  promoteMatch: Record<string, string>,
): Promise<void> {
  validateIdSegment(promoteMatch.id!, 'memory id');
  const result = await promote(ctx, promoteMatch.id!);
  sendJson(res, 200, result);
  return;
}

export async function handleForgetMemory(
  { res, ctx }: AuthedRouteRequest,
  idMatch: Record<string, string>,
): Promise<void> {
  validateIdSegment(idMatch.id!, 'memory id');
  const result = await forget(ctx, idMatch.id!);
  sendJson(res, 200, result);
  return;
}

// POST /v1/outcome: applies a positive/negative outcome to memory ids; without ids it falls back to the last-recall
// path (api.outcomeForLastRecall)
// and returns {applied, ids}, so callers can tell "no recent recall" from "all ids skipped". Each applied id writes one
// audit_log row (op='outcome').
export async function handleApplyOutcome({ req, res, ctx }: AuthedRouteRequest): Promise<void> {
  const body = await parseJsonBody(req, ctx);
  const good = body['good'];
  if (!isJsonBoolean(good)) {
    throw new HttpError(400, 'good is required (boolean)');
  }
  const idsRaw = body['ids'];
  let ids: string[] | undefined;
  if (idsRaw !== undefined) {
    if (!Array.isArray(idsRaw)) {
      throw new HttpError(400, 'ids must be an array of non-empty strings');
    }
    const isNonEmptyId = (item: JsonValue): item is string => isJsonString(item) && item.length > 0;
    if (!idsRaw.every(isNonEmptyId)) {
      throw new HttpError(400, 'ids must be an array of non-empty strings');
    }
    if (idsRaw.some((id) => id.length > MAX_ID_LEN)) {
      throw new HttpError(400, `each ids entry exceeds ${MAX_ID_LEN}-character cap`);
    }
    // Bounds the ids one call binds and audits: outcome runs a fixed set of statements whatever the count, and writes
    // the mirrors after its job. Auth runs first, so only a caller with a key reaches it.
    if (idsRaw.length > MAX_OUTCOME_IDS) {
      throw new HttpError(400, `ids exceeds ${MAX_OUTCOME_IDS}-id cap`);
    }
    ids = idsRaw;
  }
  if (ids !== undefined) {
    const { applied } = await outcome(ctx, ids, good);
    sendJson(res, 200, { applied });
  } else {
    // Its own 501 text: a client of such a store can still apply the outcome by sending the ids its recall returned.
    const result = await outcomeForLastRecall(withLastRecall(ctx), good);
    sendJson(res, 200, result);
  }
  return;
}

// POST /v1/sleep: host-wide consolidation (consolidate, dedup, audit, share, ambient); api.sleep spans the WHOLE
// hippoRoot, cross-tenant by design, so the
// row's host-admin-local gate is the trust boundary. Body {dry_run?, no_share?}; returns SleepResult JSON.
export async function handleSleep({ req, res, ctx }: AuthedRouteRequest): Promise<void> {
  const body = await parseJsonBody(req, ctx);
  const dryRunRaw = body['dry_run'];
  if (dryRunRaw !== undefined && !isJsonBoolean(dryRunRaw)) {
    throw new HttpError(400, 'dry_run must be a boolean');
  }
  const noShareRaw = body['no_share'];
  if (noShareRaw !== undefined && !isJsonBoolean(noShareRaw)) {
    throw new HttpError(400, 'no_share must be a boolean');
  }
  const result = await sleepInChild(ctx, {
    dryRun: dryRunRaw === true,
    noShare: noShareRaw === true,
  });
  sendJson(res, 200, result);
  return;
}
