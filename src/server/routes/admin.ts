// Admin routes: API keys, quarantine and the audit log.
import { AUDIT_OPS, type AuditOp } from '../../store/audit.js';
import { auditList, authCreate, authListRows, authRevoke, quarantineApprove, quarantineList, quarantineReject } from '../../api.js';
import { HttpError, readBody, sendJson } from '../../http-util.js';
import { log } from '../../log.js';
import { assertCrossTenantAdmin, buildContextWithAuth } from '../auth.js';
import { pageOf, parseCursor, setNextCursorHeader } from '../cursor.js';
import type { RouteRequest } from '../types.js';
import { isSetMember, parseJsonObjectText, parseListLimit, validateIdSegment } from '../validation.js';
import { isJsonString } from '../../json.js';

const VALID_AUDIT_OPS: ReadonlySet<AuditOp> = new Set<AuditOp>(AUDIT_OPS);

// POST /v1/auth/keys reads its body before auth, so an unauthenticated caller can make the server buffer at most this many bytes and wait at most this many ms.
// ServeOpts.mintBodyDeadlineMs overrides the wait for tests only, so a 408 test need not sit through it.
const MINT_BODY_MAX_BYTES = 4 * 1024;
const MINT_BODY_DEADLINE_MS = 10_000;

// Cap on GET /v1/audit?limit=. Matches docs/api.md (when written) and is large
// enough to dump a small deployment's full audit log without paginating, but
// small enough that a malicious client can't ask for the world.
const MAX_AUDIT_LIMIT = 10000;

// GET /v1/auth/keys had no limit, so its default page is the cap: a deployment below 1000 keys sees no change.
const MAX_AUTH_KEYS_PAGE = 1000;

// POST /v1/auth/keys — mint a new API key. Plaintext lands in the response
// body: the HTTP layer hands it to the client; the user-facing
// "store this somewhere safe" warning belongs in the CLI client, not here.
export async function handleCreateAuthKey({ req, res, opts }: RouteRequest): Promise<void> {
  // Body first, so the resolver's check (and any gate in it) runs right before the mint with no wait between.
  const raw = await readBody(req, { maxBytes: MINT_BODY_MAX_BYTES, deadlineMs: opts.mintBodyDeadlineMs ?? MINT_BODY_DEADLINE_MS });
  const ctx = await buildContextWithAuth(req, opts);
  const body = parseJsonObjectText(raw);
  const labelRaw = body['label'];
  if (labelRaw !== undefined && !isJsonString(labelRaw)) {
    throw new HttpError(400, 'label must be a string');
  }
  // Optional body.role mirrors the --role CLI flag. Validated
  // strictly — anything other than 'admin'|'member' is a 400 (no silent
  // fallback to admin). authCreate refuses a member caller with a 403.
  const roleRaw = body['role'];
  let role: 'admin' | 'member' | undefined;
  if (roleRaw !== undefined) {
    if (roleRaw !== 'admin' && roleRaw !== 'member') {
      throw new HttpError(400, "role must be 'admin' or 'member'");
    }
    role = roleRaw;
  }
  // Security: any `tenantId` in the body is IGNORED. The minted key is
  // bound to the caller's authenticated tenant (ctx.tenantId, resolved
  // from the Bearer token). Forwarding body.tenantId here would let
  // tenant A mint a key for tenant B — see authCreate doc comment.
  const result = await authCreate(ctx, {
    label: labelRaw,
    role,
  });
  // The reply cannot change shape, so the server log is where a defaulted admin key gets noticed.
  if (role === undefined && result.role === 'admin') {
    log.warn(`auth key ${result.keyId} was minted with no role in the body, so it is an admin key, and it never expires; send "role": "member" for a narrower one`);
  }
  sendJson(res, 200, result);
  return;
}

// GET /v1/auth/keys?active=true&limit=&cursor=: list keys visible to ctx.tenantId.
// `active` defaults to true so the common case (show me usable keys) is
// a single GET; ?active=false includes revoked and expired rows.
export async function handleListAuthKeys({ req, res, opts, query }: RouteRequest): Promise<void> {
  const activeRaw = query.get('active');
  let active = true;
  if (activeRaw !== null) {
    if (activeRaw === 'true') active = true;
    else if (activeRaw === 'false') active = false;
    else throw new HttpError(400, "active must be 'true' or 'false'");
  }
  const limit = parseListLimit(query.get('limit'), MAX_AUTH_KEYS_PAGE, MAX_AUTH_KEYS_PAGE);
  const after = parseCursor(query.get('cursor'), 'integer', 'integer');
  const ctx = await buildContextWithAuth(req, opts);
  const page = pageOf(await authListRows(ctx, { active, limit: limit + 1, after }), limit, (r) => ({ key: r.rowId, id: r.rowId }));
  setNextCursorHeader(res, page.nextCursor);
  sendJson(res, 200, page.items.map((r) => r.key));
  return;
}

// DELETE /v1/auth/keys/:keyId — revoke. Missing or cross-tenant keys are 404 (no info leak); a member
// is 403 on any key but its own key or, signed in through the resolver, the keys it minted.
// 200 with the body rather than 204 so the caller sees revokedAt.
export async function handleRevokeAuthKey({ req, res, opts }: RouteRequest, keyMatch: Record<string, string>): Promise<void> {
  validateIdSegment(keyMatch.keyId!, 'key id');
  const ctx = await buildContextWithAuth(req, opts);
  const result = await authRevoke(ctx, keyMatch.keyId!);
  sendJson(res, 200, result);
  return;
}

// GET /v1/quarantine?status=&limit=&cursor=: quarantine review queue. quarantineList carries no role gate itself, so it's checked here.
export async function handleListQuarantine({ req, res, opts, query }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
  if (ctx.actor.role !== 'admin') {
    throw new HttpError(403, '/v1/quarantine requires admin role');
  }
  const statusRaw = query.get('status');
  let status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending';
  if (statusRaw !== null) {
    if (statusRaw !== 'pending' && statusRaw !== 'approved' && statusRaw !== 'rejected' && statusRaw !== 'all') {
      throw new HttpError(400, 'status must be one of: pending | approved | rejected | all');
    }
    status = statusRaw;
  }
  const limit = parseListLimit(query.get('limit'));
  const after = parseCursor(query.get('cursor'), 'string', 'string');
  const page = pageOf(await quarantineList(ctx, { status, limit: limit + 1, after }), limit, (q) => ({ key: q.quarantinedAt, id: q.id }));
  sendJson(res, 200, { quarantine: page.items, next_cursor: page.nextCursor });
  return;
}

// POST /v1/quarantine/:id/approve: admin only; ForbiddenError falls through to mapApiError's 403.
export async function handleApproveQuarantine({ req, res, opts }: RouteRequest, quarantineApproveMatch: Record<string, string>): Promise<void> {
  validateIdSegment(quarantineApproveMatch.id!, 'memory id');
  const ctx = await buildContextWithAuth(req, opts);
  await quarantineApprove(ctx, quarantineApproveMatch.id!);
  sendJson(res, 200, { approved: quarantineApproveMatch.id });
  return;
}

// POST /v1/quarantine/:id/reject: admin only; ForbiddenError falls through to mapApiError's 403.
export async function handleRejectQuarantine({ req, res, opts }: RouteRequest, quarantineRejectMatch: Record<string, string>): Promise<void> {
  validateIdSegment(quarantineRejectMatch.id!, 'memory id');
  const ctx = await buildContextWithAuth(req, opts);
  await quarantineReject(ctx, quarantineRejectMatch.id!);
  sendJson(res, 200, { rejected: quarantineRejectMatch.id });
  return;
}

// GET /v1/audit?op=&since=&limit=&cursor=: read audit events. All three filters
// validated at the route boundary so an invalid value lands a 400 before
// we hit the DB.
export async function handleListAudit({ req, res, opts, query }: RouteRequest): Promise<void> {
  const opRaw = query.get('op');
  let op: AuditOp | undefined;
  if (opRaw !== null) {
    if (!isSetMember(VALID_AUDIT_OPS, opRaw)) {
      throw new HttpError(400, `invalid op: ${opRaw}`);
    }
    op = opRaw;
  }
  const sinceRaw = query.get('since');
  let since: string | undefined;
  if (sinceRaw !== null) {
    const parsed = Date.parse(sinceRaw);
    if (!Number.isFinite(parsed)) {
      throw new HttpError(400, `invalid since: ${sinceRaw}`);
    }
    since = sinceRaw;
  }
  const limitRaw = query.get('limit');
  let limit = 100;
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > MAX_AUDIT_LIMIT) {
      throw new HttpError(400, `limit must be an integer between 1 and ${MAX_AUDIT_LIMIT}`);
    }
    limit = parsed;
  }
  const after = parseCursor(query.get('cursor'), 'string', 'integer');
  const ctx = await buildContextWithAuth(req, opts);
  // ?tenant=<t> reads another tenant (e.g. '__host__' for consolidate rows); admin only.
  const tenantOverride = query.get('tenant');
  const crossTenant = tenantOverride !== null && tenantOverride !== '' && tenantOverride !== ctx.tenantId;
  if (crossTenant) assertCrossTenantAdmin(ctx, '/v1/audit?tenant= for another tenant');
  const effectiveCtx = crossTenant ? { ...ctx, tenantId: tenantOverride } : ctx;
  const page = pageOf(await auditList(effectiveCtx, { op, since, limit: limit + 1, after }), limit, (e) => ({ key: e.ts, id: e.id }));
  setNextCursorHeader(res, page.nextCursor);
  sendJson(res, 200, page.items);
  return;
}
