// Memory write routes: create, graph, archive, supersede, promote, forget, outcome, sleep.
import { archiveRaw, forget, outcome, outcomeForLastRecall, promote, remember, sleep, supersede } from '../../api.js';
import type { MemoryKind } from '../../memory.js';
import { buildGraphModel } from '../../graph-view.js';
import { MAX_ENTITY_NAME_LEN } from '../../graph/types.js';
import { HttpError, sendJson } from '../../http-util.js';
import { assertCrossTenantAdmin, buildContextWithAuth, isLoopback } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { getString, getStringArray, isJsonBoolean, isSetMember, parseJsonBody, parseListLimit, validateIdSegment } from '../validation.js';
import { type JsonValue, isJsonString } from '../../json.js';

const VALID_KINDS: ReadonlySet<MemoryKind> = new Set([
  'raw',
  'distilled',
  'superseded',
  'archived',
]);

// POST /v1/memories
export async function handleCreateMemory({ req, res, opts }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const content = getString(body, 'content');
  if (!content) {
    throw new HttpError(400, 'content is required');
  }
  const kindRaw = getString(body, 'kind');
  if (kindRaw !== undefined && !isSetMember(VALID_KINDS, kindRaw)) {
    throw new HttpError(400, `invalid kind: ${kindRaw}`);
  }
  const result = remember(ctx, {
    content,
    kind: kindRaw,
    scope: getString(body, 'scope'),
    owner: getString(body, 'owner'),
    artifactRef: getString(body, 'artifactRef'),
    tags: getStringArray(body, 'tags'),
  });
  sendJson(res, 200, result);
  return;
}

// GET /v1/graph?entity=NAME&limit=N — read-only entity/relation graph (tenant-scoped)
export async function handleGetGraph({ req, res, opts, query }: RouteRequest): Promise<void> {
  const entityRaw = query.get('entity');
  // Cap at the graph entity-name cap (512), not the id-shaped 256, so a valid
  // long decision/policy name remains focusable over HTTP (codex P2).
  if (entityRaw !== null && entityRaw.length > MAX_ENTITY_NAME_LEN) {
    throw new HttpError(400, `entity exceeds the ${MAX_ENTITY_NAME_LEN}-character cap`);
  }
  const limit = parseListLimit(query.get('limit'));
  const ctx = await buildContextWithAuth(req, opts);
  const model = buildGraphModel(ctx.hippoRoot, ctx.tenantId, {
    entity: entityRaw ?? undefined,
    limit,
  });
  sendJson(res, 200, model);
  return;
}

// /v1/memories/:id/* and DELETE /v1/memories/:id
export async function handleArchiveMemory({ req, res, opts }: RouteRequest, archiveMatch: Record<string, string>): Promise<void> {
  validateIdSegment(archiveMatch.id!, 'memory id');
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const reason = getString(body, 'reason');
  if (!reason) {
    throw new HttpError(400, 'reason is required');
  }
  const result = archiveRaw(ctx, archiveMatch.id!, reason);
  sendJson(res, 200, result);
  return;
}

export async function handleSupersedeMemory({ req, res, opts }: RouteRequest, supersedeMatch: Record<string, string>): Promise<void> {
  validateIdSegment(supersedeMatch.id!, 'memory id');
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const content = getString(body, 'content');
  if (!content) {
    throw new HttpError(400, 'content is required');
  }
  const result = supersede(ctx, supersedeMatch.id!, content);
  sendJson(res, 200, result);
  return;
}

export async function handlePromoteMemory({ req, res, opts }: RouteRequest, promoteMatch: Record<string, string>): Promise<void> {
  validateIdSegment(promoteMatch.id!, 'memory id');
  const ctx = await buildContextWithAuth(req, opts);
  const result = promote(ctx, promoteMatch.id!);
  sendJson(res, 200, result);
  return;
}

export async function handleForgetMemory({ req, res, opts }: RouteRequest, idMatch: Record<string, string>): Promise<void> {
  validateIdSegment(idMatch.id!, 'memory id');
  const ctx = await buildContextWithAuth(req, opts);
  const result = forget(ctx, idMatch.id!);
  sendJson(res, 200, result);
  return;
}

// POST /v1/outcome — apply a positive/negative outcome to memory ids.
// Body: {ids?: string[], good: boolean}. If ids omitted, falls back to
// the last-recall path (api.outcomeForLastRecall); returned shape is
// {applied, ids} in that case so callers can disambiguate "no recent
// recall" from "all ids skipped". Each applied id writes one audit_log
// row (op='outcome', actor from Bearer).
export async function handleApplyOutcome({ req, res, opts }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
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
    // v1.11.5: DoS cap on ids.length. Each id triggers ~3 DB ops (readEntry +
    // writeEntry + appendAuditEvent). N=1000 keeps per-request work bounded
    // to sub-second wall time on SQLite hot path. Cap BEFORE buildContextWithAuth
    // so attack traffic doesn't pay the api-key lookup cost.
    if (idsRaw.length > 1000) {
      throw new HttpError(400, 'ids exceeds 1000-id cap');
    }
    ids = idsRaw;
  }
  if (ids !== undefined) {
    const { applied } = outcome(ctx, ids, good);
    sendJson(res, 200, { applied });
  } else {
    const result = outcomeForLastRecall(ctx, good);
    sendJson(res, 200, result);
  }
  return;
}

// POST /v1/sleep — host-wide consolidation pipeline (consolidate + dedup +
// audit + share + ambient). serve() refuses non-loopback hosts at boot, AND
// this per-request loopback assertion makes the host-wide semantic fail-
// closed regardless of any future serve() boot-config change. Body:
// {dry_run?, no_share?}. Returns SleepResult JSON.
//
// Tenant scope (Episode A follow-up tracked in TODOS.md): api.sleep operates
// on the WHOLE hippoRoot (cross-tenant by design, matching CLI cmdSleep).
// The loopback-only guard is the trust boundary today. Future non-loopback
// serving must also zero the cross-tenant counters for other tenants
// (D1 in docs/decisions/2026-05-24-blocked-items.md).
export async function handleSleep({ req, res, opts }: RouteRequest): Promise<void> {
  // Defensive per-request loopback guard. Uses the canonical isLoopback()
  // helper above so any future extension (additional mapped/IPv6 forms,
  // NAT64 prefixes) flows through without drift. serve()'s boot-time host
  // check is the primary trust boundary; this is belt-and-suspenders.
  if (!isLoopback(req.socket.remoteAddress)) {
    throw new HttpError(403, '/v1/sleep is loopback-only (host-wide consolidation; see CHANGELOG v1.11.4)');
  }
  // v1.12.0 A5 v2 sub-1: admin-role gate. Forward-defensive — exists today
  // under loopback-only enforcement (loopback fallback is admin by default;
  // any Bearer-authed caller now carries an explicit role from the api_keys
  // row). When non-loopback serving lands, this gate is the actual auth
  // boundary on host-wide sleep.
  const sleepCtx = await buildContextWithAuth(req, opts);
  // Sleep consolidates every tenant under hippoRoot, so it is a cross-tenant action.
  assertCrossTenantAdmin(sleepCtx, '/v1/sleep');
  const body = await parseJsonBody(req, sleepCtx);
  const dryRunRaw = body['dry_run'];
  if (dryRunRaw !== undefined && !isJsonBoolean(dryRunRaw)) {
    throw new HttpError(400, 'dry_run must be a boolean');
  }
  const noShareRaw = body['no_share'];
  if (noShareRaw !== undefined && !isJsonBoolean(noShareRaw)) {
    throw new HttpError(400, 'no_share must be a boolean');
  }
  // v1.12.0: sleepCtx already built above for the admin-role gate; reuse.
  const result = await sleep(sleepCtx, {
    dryRun: dryRunRaw === true,
    noShare: noShareRaw === true,
  });
  sendJson(res, 200, result);
  return;
}
