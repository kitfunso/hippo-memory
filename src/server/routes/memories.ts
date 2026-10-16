// Memory write routes: create, graph, archive, supersede, promote, forget, outcome, sleep.
import { graphEntityOf, graphRows } from '../../api/objects/graph.js';
import { archiveRaw, forget, outcome, outcomeForLastRecall, promote, remember, supersede } from '../../api/index.js';
import { MEMORY_KINDS, type MemoryKind } from '../../core/memory.js';
import { graphModelOf } from '../../graph/view.js';
import { HttpError, sendJson } from '../../util/http-util.js';
import { sleepInChild } from '../sleep-offload.js';
import type { AuthedRouteRequest } from '../types.js';
import {
  getCallerProject,
  getString,
  getStringArray,
  isSetMember,
  parseJsonBody,
  parseListLimit,
  validateIdSegment,
} from '../validation.js';
import { type JsonValue, isJsonString, isJsonBoolean } from '../../util/json.js';

const VALID_KINDS: ReadonlySet<MemoryKind> = new Set(MEMORY_KINDS);

// POST /v1/memories
export async function handleCreateMemory({ req, res, ctx }: AuthedRouteRequest<'entryWrites'>): Promise<void> {
  const body = await parseJsonBody(req, ctx);
  const content = getString(body, 'content');
  if (!content) {
    throw new HttpError(400, 'content is required');
  }
  const kindRaw = getString(body, 'kind');
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
    scope: getString(body, 'scope'),
    owner: getString(body, 'owner'),
    artifactRef: getString(body, 'artifactRef'),
    tags: getStringArray(body, 'tags'),
    project: getCallerProject(body),
    personal: personalRaw === true,
  });
  sendJson(res, 200, result);
  return;
}

// GET /v1/graph?entity=NAME&limit=N — read-only entity/relation graph (tenant-scoped)
export async function handleGetGraph({ res, ctx, query }: AuthedRouteRequest<'graphReads'>): Promise<void> {
  const entity = graphEntityOf(query.get('entity'));
  const limit = parseListLimit(query.get('limit'));
  const rows = await graphRows(ctx, { entity, limit });
  sendJson(res, 200, graphModelOf(rows));
  return;
}

// /v1/memories/:id/* and DELETE /v1/memories/:id
export async function handleArchiveMemory(
  { req, res, ctx }: AuthedRouteRequest<'entryWrites'>,
  archiveMatch: Record<string, string>,
): Promise<void> {
  validateIdSegment(archiveMatch.id!, 'memory id');
  const body = await parseJsonBody(req, ctx);
  const reason = getString(body, 'reason');
  if (!reason) {
    throw new HttpError(400, 'reason is required');
  }
  const result = await archiveRaw(ctx, archiveMatch.id!, reason);
  sendJson(res, 200, result);
  return;
}

export async function handleSupersedeMemory(
  { req, res, ctx }: AuthedRouteRequest<'entryWrites'>,
  supersedeMatch: Record<string, string>,
): Promise<void> {
  validateIdSegment(supersedeMatch.id!, 'memory id');
  const body = await parseJsonBody(req, ctx);
  const content = getString(body, 'content');
  if (!content) {
    throw new HttpError(400, 'content is required');
  }
  const result = await supersede(ctx, supersedeMatch.id!, content);
  sendJson(res, 200, result);
  return;
}

export async function handlePromoteMemory(
  { res, ctx }: AuthedRouteRequest<'localFiles'>,
  promoteMatch: Record<string, string>,
): Promise<void> {
  validateIdSegment(promoteMatch.id!, 'memory id');
  const result = promote(ctx, promoteMatch.id!);
  sendJson(res, 200, result);
  return;
}

export async function handleForgetMemory(
  { res, ctx }: AuthedRouteRequest<'entryWrites'>,
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
export async function handleApplyOutcome({ req, res, ctx }: AuthedRouteRequest<'entryWrites'>): Promise<void> {
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
    // DoS cap on ids.length (each id costs ~3 DB ops): N=1000 keeps per-request work sub-second on SQLite. Auth runs
    // first, so only a caller with a key
    // reaches it.
    if (idsRaw.length > 1000) {
      throw new HttpError(400, 'ids exceeds 1000-id cap');
    }
    ids = idsRaw;
  }
  if (ids !== undefined) {
    const { applied } = await outcome(ctx, ids, good);
    sendJson(res, 200, { applied });
  } else {
    const result = await outcomeForLastRecall(ctx, good);
    sendJson(res, 200, result);
  }
  return;
}

// POST /v1/sleep: host-wide consolidation (consolidate, dedup, audit, share, ambient); api.sleep spans the WHOLE
// hippoRoot, cross-tenant by design, so the
// row's host-admin-local gate is the trust boundary. Body {dry_run?, no_share?}; returns SleepResult JSON.
export async function handleSleep({ req, res, ctx }: AuthedRouteRequest<'localFiles'>): Promise<void> {
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
