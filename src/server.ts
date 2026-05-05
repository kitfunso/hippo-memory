import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { writePidfile, removePidfile } from './server-detect.js';
import { resolveTenantId } from './tenant.js';
import { openHippoDb, closeHippoDb } from './db.js';
import { PACKAGE_VERSION } from './version.js';
import { validateApiKey } from './auth.js';
import {
  remember,
  recall,
  drillDown,
  assemble,
  forget,
  promote,
  supersede,
  archiveRaw,
  authCreate,
  authList,
  authRevoke,
  auditList,
  type Context,
} from './api.js';
import type { MemoryKind } from './memory.js';
import type { AuditOp } from './audit.js';
import { handleMcpRequest, type McpRequest } from './mcp/server.js';
import { verifySlackSignature } from './connectors/slack/signature.js';
import { isSlackEventEnvelope, isSlackMessageEvent } from './connectors/slack/types.js';
import { ingestMessage } from './connectors/slack/ingest.js';
import { handleMessageDeleted } from './connectors/slack/deletion.js';
import { writeToDlq } from './connectors/slack/dlq.js';
import { resolveTenantForTeam } from './connectors/slack/tenant-routing.js';
import { verifyGitHubSignature } from './connectors/github/signature.js';
import {
  isGitHubWebhookEnvelope,
  isGitHubIssueEvent,
  isGitHubIssueCommentEvent,
  isGitHubPullRequestEvent,
  isGitHubPullRequestReviewCommentEvent,
} from './connectors/github/types.js';
import { ingestEvent as ingestGitHubEvent, type IngestEvent as GitHubIngestEvent } from './connectors/github/ingest.js';
import { handleCommentDeleted as handleGitHubCommentDeleted } from './connectors/github/deletion.js';
import { writeToDlq as writeToGitHubDlq } from './connectors/github/dlq.js';
import { resolveTenantForGitHub } from './connectors/github/tenant-routing.js';
import { computeIdempotencyKey as computeGitHubIdempotencyKey, computeDeletionKey as computeGitHubDeletionKey } from './connectors/github/signature.js';

// Review patch #2: explicit allow-list for unauthenticated /v1/* routes.
// New unauth routes MUST be added here AND get a corresponding entry in
// tests/server-bearer-lockdown.test.ts. Do not gate auth elsewhere by
// `path.startsWith` — pattern-positional auth is bypass-by-accident.
//
// The route handlers consult `isPublicRoute` before invoking
// `buildContextWithAuth` / `requireAuth`. Adding a route here without
// adding the corresponding `isPublicRoute` short-circuit in a handler is
// a no-op (auth still applies), so the failure mode is fail-closed.
const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'POST /v1/connectors/slack/events',
  'POST /v1/connectors/github/events',
]);

function isPublicRoute(method: string, path: string): boolean {
  return PUBLIC_ROUTES.has(`${method} ${path}`);
}

const VALID_AUDIT_OPS: ReadonlySet<AuditOp> = new Set([
  'remember',
  'recall',
  'promote',
  'supersede',
  'forget',
  'archive_raw',
  'auth_revoke',
]);

// Cap on GET /v1/audit?limit=. Matches docs/api.md (when written) and is large
// enough to dump a small deployment's full audit log without paginating, but
// small enough that a malicious client can't ask for the world.
const MAX_AUDIT_LIMIT = 10000;

const VALID_KINDS: ReadonlySet<MemoryKind> = new Set([
  'raw',
  'distilled',
  'superseded',
  'archived',
]);

// Pinned at module load. Bumped alongside package.json on releases. The
// HTTP /health response uses this; reading package.json synchronously here
// would couple the daemon to its on-disk install path, which we want to
// avoid for tests that mkdtemp a hippoRoot.
// v1.3.1: source from src/version.ts so /health no longer reports stale 0.39.0.
const VERSION = PACKAGE_VERSION;

// 1 MB body cap. The CLI never sends payloads near this; anything bigger is
// almost certainly a misconfigured client or a deliberate memory-blowup attempt.
const MAX_BODY_BYTES = 1024 * 1024;

export interface ServerHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

export interface ServeOpts {
  hippoRoot: string;
  port?: number;
  host?: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

class BodyTooLargeError extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/**
 * Read the entire request body into a Buffer. Caps at MAX_BODY_BYTES to keep
 * a malicious or buggy client from exhausting memory. The cap is enforced
 * mid-stream so we don't wait for an attacker to finish before erroring out.
 */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new BodyTooLargeError('request body exceeds 1MB');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'invalid JSON body');
  }
}

/**
 * Map an error thrown by an api.* function into an HTTP status + message.
 * api.* uses plain Error, so we discriminate by message pattern. Stable
 * patterns we rely on:
 *   - /not found/i  → 404 (forget on unknown id, supersede on unknown old id, etc.)
 *   - /unknown/i    → 404 (auth_revoke on unknown key_id)
 *   - /already superseded/i → 409 (chain conflict)
 *   - /not raw/i    → 400 (archive_raw on non-raw row)
 * Everything else maps to 400 (bad input).
 */
function mapApiError(err: unknown): { status: number; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (/not found/.test(lower) || /^unknown /.test(lower)) {
    return { status: 404, message };
  }
  if (/already superseded/.test(lower)) {
    return { status: 409, message };
  }
  return { status: 400, message };
}

interface ParsedRoute {
  method: string;
  path: string;
  query: URLSearchParams;
}

function parseRequest(req: IncomingMessage): ParsedRoute {
  const url = new URL(req.url ?? '/', 'http://placeholder');
  return {
    method: req.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
  };
}

/**
 * Lightweight pattern matcher for /v1/memories/:id/<action>. Avoids pulling
 * in a router dependency for the half-dozen patterns we actually use.
 *
 * Returns null if `path` does not match `pattern`. Otherwise returns an object
 * mapping each :param name to its value. Path segments are exact-matched
 * except for parameter slots.
 */
function matchPath(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i]!;
    const ap = pathParts[i]!;
    if (pp.startsWith(':')) {
      if (ap.length === 0) return null;
      params[pp.slice(1)] = decodeURIComponent(ap);
    } else if (pp !== ap) {
      return null;
    }
  }
  return params;
}

/**
 * Recognise loopback remote addresses. Node reports IPv6-mapped IPv4 as
 * '::ffff:127.0.0.1' on dual-stack sockets, so we accept that alongside
 * the bare v4 and v6 loopbacks. Anything else is treated as remote.
 */
export function isLoopback(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  if (remoteAddress === '127.0.0.1') return true;
  if (remoteAddress === '::1') return true;
  if (remoteAddress === '::ffff:127.0.0.1') return true;
  return false;
}

/**
 * Read the Authorization header in a case-insensitive way and pull the
 * bearer token out. Returns:
 *   - { kind: 'absent' } when no Authorization header is present
 *   - { kind: 'malformed' } when the header is set but not 'Bearer <token>'
 *   - { kind: 'bearer', token } when a non-empty bearer token is present
 *
 * The header NAME is case-insensitive (Node lowercases all header names on
 * IncomingMessage.headers); the SCHEME ('Bearer') is also matched
 * case-insensitively per RFC 6750.
 */
type AuthHeader =
  | { kind: 'absent' }
  | { kind: 'malformed' }
  | { kind: 'bearer'; token: string };

function readAuthHeader(req: IncomingMessage): AuthHeader {
  const raw = req.headers['authorization'];
  if (raw === undefined) return { kind: 'absent' };
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length === 0) return { kind: 'malformed' };
  const space = value.indexOf(' ');
  if (space < 0) return { kind: 'malformed' };
  const scheme = value.slice(0, space);
  const token = value.slice(space + 1).trim();
  if (scheme.toLowerCase() !== 'bearer') return { kind: 'malformed' };
  if (token.length === 0) return { kind: 'malformed' };
  return { kind: 'bearer', token };
}

/**
 * Build a per-client key for MCP state isolation under HTTP-MCP. Used by
 * mcp/server.ts to scope `lastRecalledIds` to the calling client so two
 * clients on the same tenant cannot poison each other's outcome feedback.
 *
 * Token is hashed (sha256, 16-hex-char prefix) so we never log or persist
 * the raw bearer. Combined with remoteAddress so two clients sharing a key
 * (e.g. on a shared Postman environment) are still separable in the common
 * case. 'noauth' covers loopback no-auth and is acceptable because that
 * path is single-host single-user.
 */
function buildMcpClientKey(req: IncomingMessage): string {
  const auth = readAuthHeader(req);
  const tokenHash = auth.kind === 'bearer'
    ? createHash('sha256').update(auth.token).digest('hex').slice(0, 16)
    : 'noauth';
  const addr = req.socket.remoteAddress ?? 'unknown';
  return `http:${tokenHash}:${addr}`;
}

/**
 * Build a per-request Context from the Authorization header and remote
 * address. Throws HttpError(401) for invalid / missing credentials. Opens
 * the DB only when a Bearer token is present so loopback no-auth requests
 * stay cheap.
 */
function buildContextWithAuth(req: IncomingMessage, hippoRoot: string): Context {
  const auth = readAuthHeader(req);

  if (auth.kind === 'malformed') {
    throw new HttpError(401, 'invalid api key');
  }

  if (auth.kind === 'bearer') {
    const db = openHippoDb(hippoRoot);
    try {
      const result = validateApiKey(db, auth.token);
      if (!result.valid || !result.tenantId || !result.keyId) {
        throw new HttpError(401, 'invalid api key');
      }
      return {
        hippoRoot,
        tenantId: result.tenantId,
        actor: `api_key:${result.keyId}`,
      };
    } finally {
      closeHippoDb(db);
    }
  }

  // No Authorization header. Loopback-only fallback, unless explicitly
  // disabled via HIPPO_REQUIRE_AUTH=1 (used by the bearer-lockdown test
  // and by deployments that want to forbid the local-CLI escape hatch).
  if (process.env.HIPPO_REQUIRE_AUTH === '1') {
    throw new HttpError(401, 'auth required');
  }
  if (!isLoopback(req.socket.remoteAddress)) {
    throw new HttpError(401, 'auth required');
  }

  return {
    hippoRoot,
    tenantId: resolveTenantId({}),
    actor: 'localhost:cli',
  };
}

/**
 * Auth check for routes that do not need a tenant Context (e.g. MCP transport,
 * which builds its own root resolution via findHippoRoot). Throws HttpError
 * 401 the same way buildContextWithAuth does, but skips building the Context
 * envelope. Loopback no-auth still passes.
 */
function requireAuth(req: IncomingMessage, hippoRoot: string): void {
  const auth = readAuthHeader(req);
  if (auth.kind === 'malformed') {
    throw new HttpError(401, 'invalid api key');
  }
  if (auth.kind === 'bearer') {
    const db = openHippoDb(hippoRoot);
    try {
      const result = validateApiKey(db, auth.token);
      if (!result.valid) {
        throw new HttpError(401, 'invalid api key');
      }
    } finally {
      closeHippoDb(db);
    }
    return;
  }
  if (process.env.HIPPO_REQUIRE_AUTH === '1') {
    throw new HttpError(401, 'auth required');
  }
  if (!isLoopback(req.socket.remoteAddress)) {
    throw new HttpError(401, 'auth required');
  }
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function getStringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = obj[key];
  if (!Array.isArray(v)) return undefined;
  if (!v.every((x) => typeof x === 'string')) return undefined;
  return v as string[];
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServeOpts,
  startedAt: string,
): Promise<void> {
  const { method, path, query } = parseRequest(req);

  if (method === 'GET' && path === '/health') {
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      started_at: startedAt,
      pid: process.pid,
    });
    return;
  }

  // POST /v1/memories
  if (method === 'POST' && path === '/v1/memories') {
    const body = await parseJsonBody(req);
    const content = getString(body, 'content');
    if (!content) {
      throw new HttpError(400, 'content is required');
    }
    const kindRaw = getString(body, 'kind');
    if (kindRaw !== undefined && !VALID_KINDS.has(kindRaw as MemoryKind)) {
      throw new HttpError(400, `invalid kind: ${kindRaw}`);
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = remember(ctx, {
      content,
      kind: kindRaw as MemoryKind | undefined,
      scope: getString(body, 'scope'),
      owner: getString(body, 'owner'),
      artifactRef: getString(body, 'artifactRef'),
      tags: getStringArray(body, 'tags'),
    });
    sendJson(res, 200, result);
    return;
  }

  // GET /v1/memories?q=...&limit=...&mode=...&scope=...&include_continuity=1
  if (method === 'GET' && path === '/v1/memories') {
    const q = query.get('q');
    if (!q) {
      throw new HttpError(400, 'q is required');
    }
    const limitRaw = query.get('limit');
    const limit = limitRaw === null ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
      throw new HttpError(400, 'limit must be a positive number');
    }
    const mode = query.get('mode');
    if (mode !== null && mode !== 'bm25' && mode !== 'hybrid' && mode !== 'physics') {
      throw new HttpError(400, "mode must be 'bm25', 'hybrid', or 'physics'");
    }
    const scope = query.get('scope');
    const includeContinuityRaw = query.get('include_continuity');
    const includeContinuity = includeContinuityRaw === '1'
      || includeContinuityRaw === 'true';
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = recall(ctx, {
      query: q,
      limit,
      mode: (mode ?? undefined) as 'bm25' | 'hybrid' | 'physics' | undefined,
      scope: scope ?? undefined,
      includeContinuity,
    });
    // Continuity payloads should never be cached. The caller is asking for
    // session-state-aware data; intermediaries must not reuse it across users.
    if (includeContinuity) {
      res.setHeader('Cache-Control', 'no-store');
    }
    sendJson(res, 200, result);
    return;
  }

  // GET /v1/sessions/:id/assemble?budget=N&freshTail=N&summarizeOlder=0|1
  // Phase 2 context-engine API. Returns ordered AssembledContextItem[]
  // with fresh-tail raws + summary substitutions + bio-aware budget fit.
  // Tenant scope from Bearer; default-deny on private rows.
  const assembleMatch = matchPath('/v1/sessions/:id/assemble', path);
  if (method === 'GET' && assembleMatch) {
    const budgetRaw = query.get('budget');
    const budget = budgetRaw === null ? undefined : Number(budgetRaw);
    if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) {
      throw new HttpError(400, 'budget must be a positive number');
    }
    const ftRaw = query.get('freshTail');
    const freshTailCount = ftRaw === null ? undefined : Number(ftRaw);
    if (freshTailCount !== undefined && (!Number.isFinite(freshTailCount) || freshTailCount < 0)) {
      throw new HttpError(400, 'freshTail must be a non-negative number');
    }
    const sumOlderRaw = query.get('summarizeOlder');
    const summarizeOlder = sumOlderRaw === null ? undefined : sumOlderRaw !== '0' && sumOlderRaw !== 'false';
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = assemble(ctx, assembleMatch.id!, {
      ...(budget !== undefined ? { budget } : {}),
      ...(freshTailCount !== undefined ? { freshTailCount } : {}),
      ...(summarizeOlder !== undefined ? { summarizeOlder } : {}),
    });
    sendJson(res, 200, result);
    return;
  }

  // GET /v1/recall/drill/:id?limit=N&budget=N
  // Companion to /v1/memories. When recall surfaces a level-2 summary in
  // place of overflowed children (RecallResultItem.isSummary === true), the
  // caller drills into the summary id to recover the originals. Tenant
  // scoped via Bearer; default-deny on private scopes for both summary
  // and children.
  const drillMatch = matchPath('/v1/recall/drill/:id', path);
  if (method === 'GET' && drillMatch) {
    const limitRaw = query.get('limit');
    const limit = limitRaw === null ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
      throw new HttpError(400, 'limit must be a positive number');
    }
    const budgetRaw = query.get('budget');
    const budget = budgetRaw === null ? undefined : Number(budgetRaw);
    if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) {
      throw new HttpError(400, 'budget must be a positive number');
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = drillDown(ctx, drillMatch.id!, {
      ...(limit !== undefined ? { limit } : {}),
      ...(budget !== undefined ? { budget } : {}),
    });
    if (!result) {
      throw new HttpError(404, 'No drillable summary at this id');
    }
    sendJson(res, 200, result);
    return;
  }

  // /v1/memories/:id/* and DELETE /v1/memories/:id
  const archiveMatch = matchPath('/v1/memories/:id/archive', path);
  if (method === 'POST' && archiveMatch) {
    const body = await parseJsonBody(req);
    const reason = getString(body, 'reason');
    if (!reason) {
      throw new HttpError(400, 'reason is required');
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = archiveRaw(ctx, archiveMatch.id!, reason);
    sendJson(res, 200, result);
    return;
  }

  const supersedeMatch = matchPath('/v1/memories/:id/supersede', path);
  if (method === 'POST' && supersedeMatch) {
    const body = await parseJsonBody(req);
    const content = getString(body, 'content');
    if (!content) {
      throw new HttpError(400, 'content is required');
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = supersede(ctx, supersedeMatch.id!, content);
    sendJson(res, 200, result);
    return;
  }

  const promoteMatch = matchPath('/v1/memories/:id/promote', path);
  if (method === 'POST' && promoteMatch) {
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = promote(ctx, promoteMatch.id!);
    sendJson(res, 200, result);
    return;
  }

  const idMatch = matchPath('/v1/memories/:id', path);
  if (method === 'DELETE' && idMatch) {
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = forget(ctx, idMatch.id!);
    sendJson(res, 200, result);
    return;
  }

  // POST /v1/auth/keys — mint a new API key. Plaintext lands in the response
  // body (Task 8): the HTTP layer hands it to the client; the user-facing
  // "store this somewhere safe" warning belongs in the CLI client, not here.
  if (method === 'POST' && path === '/v1/auth/keys') {
    const body = await parseJsonBody(req);
    const labelRaw = body['label'];
    if (labelRaw !== undefined && typeof labelRaw !== 'string') {
      throw new HttpError(400, 'label must be a string');
    }
    // Security: any `tenantId` in the body is IGNORED. The minted key is
    // bound to the caller's authenticated tenant (ctx.tenantId, resolved
    // from the Bearer token). Forwarding body.tenantId here would let
    // tenant A mint a key for tenant B — see authCreate doc comment.
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = authCreate(ctx, {
      label: labelRaw,
    });
    sendJson(res, 200, result);
    return;
  }

  // GET /v1/auth/keys?active=true — list keys visible to ctx.tenantId.
  // `active` defaults to true so the common case (show me usable keys) is
  // a single GET; ?active=false includes revoked rows.
  if (method === 'GET' && path === '/v1/auth/keys') {
    const activeRaw = query.get('active');
    let active = true;
    if (activeRaw !== null) {
      if (activeRaw === 'true') active = true;
      else if (activeRaw === 'false') active = false;
      else throw new HttpError(400, "active must be 'true' or 'false'");
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = authList(ctx, { active });
    sendJson(res, 200, result);
    return;
  }

  // DELETE /v1/auth/keys/:keyId — revoke. authRevoke throws "Unknown key_id"
  // for missing OR cross-tenant keys (no info leak), which mapApiError
  // converts to 404. We return 200 with the result body rather than 204 to
  // surface revokedAt to the caller.
  const keyMatch = matchPath('/v1/auth/keys/:keyId', path);
  if (method === 'DELETE' && keyMatch) {
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = authRevoke(ctx, keyMatch.keyId!);
    sendJson(res, 200, result);
    return;
  }

  // GET /v1/audit?op=&since=&limit= — read audit events. All three filters
  // validated at the route boundary so an invalid value lands a 400 before
  // we hit the DB.
  if (method === 'GET' && path === '/v1/audit') {
    const opRaw = query.get('op');
    let op: AuditOp | undefined;
    if (opRaw !== null) {
      if (!VALID_AUDIT_OPS.has(opRaw as AuditOp)) {
        throw new HttpError(400, `invalid op: ${opRaw}`);
      }
      op = opRaw as AuditOp;
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
    let limit: number | undefined;
    if (limitRaw !== null) {
      const parsed = Number(limitRaw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > MAX_AUDIT_LIMIT) {
        throw new HttpError(400, `limit must be an integer between 1 and ${MAX_AUDIT_LIMIT}`);
      }
      limit = parsed;
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = auditList(ctx, { op, since, limit });
    sendJson(res, 200, result);
    return;
  }

  // ── POST /v1/connectors/slack/events ──
  //
  // Slack Events API webhook. Auth is signature-based (HMAC over the raw
  // body with SLACK_SIGNING_SECRET); Bearer is NOT required, which is why
  // this route is in PUBLIC_ROUTES. The route is responsible for:
  //   1. Echoing the one-time url_verification challenge.
  //   2. Verifying the HMAC on every other inbound payload.
  //   3. Resolving body.team_id → tenantId via slack_workspaces, falling
  //      back to HIPPO_TENANT then 'default'.
  //   4. Dispatching event_callback envelopes to ingestMessage /
  //      handleMessageDeleted.
  //   5. Parking malformed or unhandled payloads in slack_dlq and STILL
  //      ACKing 200 — Slack retries forever otherwise.
  //
  // Review patch #7: when SLACK_SIGNING_SECRET is unset we return 404, not
  // 503, so an external probe cannot distinguish "route gated off by config"
  // from "route does not exist on this build".
  if (method === 'POST' && path === '/v1/connectors/slack/events') {
    // Bearer auth deliberately skipped — this route is in PUBLIC_ROUTES
    // and authenticates via the Slack HMAC signature instead.
    if (!isPublicRoute(method, path)) {
      // Defensive: PUBLIC_ROUTES drift would land here. Fail closed.
      throw new HttpError(401, 'auth required');
    }
    const rawBody = await readBody(req);
    const secret = process.env.SLACK_SIGNING_SECRET;
    if (!secret) {
      res.writeHead(404, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const previousSecret = process.env.SLACK_SIGNING_SECRET_PREVIOUS;
    const sig = req.headers['x-slack-signature'];
    const tsHdr = req.headers['x-slack-request-timestamp'];
    const sigStr = typeof sig === 'string' ? sig : null;
    const tsStr = typeof tsHdr === 'string' ? tsHdr : null;
    if (
      sigStr === null ||
      tsStr === null ||
      !verifySlackSignature({
        rawBody,
        timestamp: tsStr,
        signature: sigStr,
        signingSecret: secret,
        previousSecret,
      })
    ) {
      throw new HttpError(401, 'invalid Slack signature');
    }
    // Cheap regex extracts team_id from a (possibly malformed) raw body so the
    // DLQ row carries it for triage even when JSON.parse fails.
    const teamIdFromRaw = (() => {
      const m = rawBody.match(/"team_id"\s*:\s*"([^"]+)"/);
      return m ? m[1] : null;
    })();
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      const db = openHippoDb(opts.hippoRoot);
      try {
        writeToDlq(db, {
          tenantId: process.env.HIPPO_TENANT ?? 'default',
          teamId: teamIdFromRaw,
          rawPayload: rawBody,
          error: 'invalid JSON',
          bucket: 'parse_error',
          signature: sigStr,
          slackTimestamp: tsStr,
        });
      } finally {
        closeHippoDb(db);
      }
      sendJson(res, 200, { ok: true, status: 'dlq' });
      return;
    }
    if (
      body &&
      typeof body === 'object' &&
      (body as Record<string, unknown>).type === 'url_verification'
    ) {
      sendJson(res, 200, {
        challenge: String((body as Record<string, unknown>).challenge ?? ''),
      });
      return;
    }
    // Resolve tenant. v0.39 fail-closed: when slack_workspaces is non-empty
    // and the team_id is unknown, resolveTenantForTeam returns null and we
    // park the envelope in slack_dlq with bucket='unroutable'. Mandatory ACK
    // 200 so Slack stops retrying; do NOT call ingest.
    let resolvedTenant: string | null = null;
    if (isSlackEventEnvelope(body)) {
      const db = openHippoDb(opts.hippoRoot);
      try {
        resolvedTenant = resolveTenantForTeam(db, body.team_id);
      } finally {
        closeHippoDb(db);
      }
      if (resolvedTenant === null) {
        const db2 = openHippoDb(opts.hippoRoot);
        try {
          writeToDlq(db2, {
            tenantId: null, // unroutable — stored as '__unroutable__'
            teamId: body.team_id,
            rawPayload: rawBody,
            error: `unroutable team_id: ${body.team_id}`,
            bucket: 'unroutable',
            signature: sigStr,
            slackTimestamp: tsStr,
          });
        } finally {
          closeHippoDb(db2);
        }
        sendJson(res, 200, { ok: true, status: 'dlq' });
        return;
      }
    } else {
      // Non-envelope payload: use env tenant for the DLQ row's bookkeeping.
      resolvedTenant = process.env.HIPPO_TENANT ?? 'default';
    }
    const ctx: Context = {
      hippoRoot: opts.hippoRoot,
      tenantId: resolvedTenant,
      actor: 'connector:slack',
    };
    if (!isSlackEventEnvelope(body)) {
      const db = openHippoDb(ctx.hippoRoot);
      try {
        writeToDlq(db, {
          tenantId: ctx.tenantId,
          teamId: teamIdFromRaw,
          rawPayload: rawBody,
          error: 'not an event_callback envelope',
          bucket: 'parse_error',
          signature: sigStr,
          slackTimestamp: tsStr,
        });
      } finally {
        closeHippoDb(db);
      }
      sendJson(res, 200, { ok: true, status: 'dlq' });
      return;
    }
    const inner = body.event;
    if (isSlackMessageEvent(inner)) {
      if (inner.subtype === 'message_deleted' && inner.deleted_ts) {
        const r = handleMessageDeleted(ctx, {
          teamId: body.team_id,
          channelId: inner.channel,
          deletedTs: inner.deleted_ts,
          eventId: body.event_id,
        });
        sendJson(res, 200, { ok: true, status: r.status });
        return;
      }
      const r = ingestMessage(ctx, {
        teamId: body.team_id,
        // channel privacy isn't on the inner event; use channel_type as a
        // proxy. 'group'|'im'|'mpim' → private. 'channel' → public. Unknown
        // → private (fail closed).
        channel: {
          id: inner.channel,
          is_private: inner.channel_type !== 'channel',
          is_im: inner.channel_type === 'im',
          is_mpim: inner.channel_type === 'mpim',
        },
        message: inner,
        eventId: body.event_id,
      });
      sendJson(res, 200, { ok: true, status: r.status, memoryId: r.memoryId });
      return;
    }
    const db = openHippoDb(ctx.hippoRoot);
    try {
      writeToDlq(db, {
        tenantId: ctx.tenantId,
        teamId: body.team_id,
        rawPayload: rawBody,
        error: `unhandled event type: ${(inner as { type?: string })?.type ?? 'unknown'}`,
        bucket: 'parse_error',
        signature: sigStr,
        slackTimestamp: tsStr,
      });
    } finally {
      closeHippoDb(db);
    }
    sendJson(res, 200, { ok: true, status: 'dlq' });
    return;
  }

  // ── POST /v1/connectors/github/events ──
  //
  // GitHub webhook receiver. Mirrors the Slack route shape but with
  // GitHub-specific idioms:
  //   1. HMAC SHA-256 over the raw body (X-Hub-Signature-256), no timestamp.
  //   2. Event type discriminated by the X-GitHub-Event header (not body.type).
  //   3. X-GitHub-Delivery is required audit metadata (NOT the dedupe seam — see
  //      computeIdempotencyKey, which folds the signed body into the key so a
  //      replayed body with a fresh delivery UUID still dedupes).
  //   4. Tenant resolved by installation.id → github_installations, then by
  //      repository.full_name → github_repositories (PAT-mode multi-tenant).
  //   5. ALWAYS ACK 200 on signed envelopes (DLQ included). 401 only on bad
  //      signature; 404 only when GITHUB_WEBHOOK_SECRET is unset (don't expose
  //      the route's existence on builds where it's gated off).
  if (method === 'POST' && path === '/v1/connectors/github/events') {
    if (!isPublicRoute(method, path)) {
      throw new HttpError(401, 'auth required');
    }
    const rawBody = await readBody(req);
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      res.writeHead(404, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const previousSecret = process.env.GITHUB_WEBHOOK_SECRET_PREVIOUS;
    const sigHdr = req.headers['x-hub-signature-256'];
    const eventHdr = req.headers['x-github-event'];
    const deliveryHdr = req.headers['x-github-delivery'];
    const sigStr = typeof sigHdr === 'string' ? sigHdr : null;
    const eventName = typeof eventHdr === 'string' ? eventHdr : null;
    const deliveryId = typeof deliveryHdr === 'string' ? deliveryHdr : null;

    if (
      sigStr === null ||
      !verifyGitHubSignature({
        rawBody,
        signature: sigStr,
        webhookSecret: secret,
        previousSecret,
      })
    ) {
      throw new HttpError(401, 'invalid GitHub signature');
    }

    // Signature OK from here on. Everything else is ACK-200; bad envelopes go
    // to the DLQ and a human can replay later.

    // Cheap regex extraction of installation_id / repo for DLQ rows that fail
    // to JSON.parse — gives operators something to triage.
    const installationFromRaw = (() => {
      const m = rawBody.match(/"installation"\s*:\s*\{[^}]*"id"\s*:\s*(\d+)/);
      return m ? m[1] : null;
    })();
    const repoFromRaw = (() => {
      const m = rawBody.match(/"full_name"\s*:\s*"([^"]+)"/);
      return m ? m[1] : null;
    })();

    if (deliveryId === null) {
      // Body was signed but caller omitted the audit header. Park.
      const db = openHippoDb(opts.hippoRoot);
      try {
        writeToGitHubDlq(db, {
          tenantId: process.env.HIPPO_TENANT ?? 'default',
          rawPayload: rawBody,
          error: 'missing X-GitHub-Delivery header',
          bucket: 'parse_error',
          eventName,
          deliveryId: null,
          signature: sigStr,
          installationId: installationFromRaw,
          repoFullName: repoFromRaw,
        });
      } finally {
        closeHippoDb(db);
      }
      sendJson(res, 200, { ok: true, status: 'dlq' });
      return;
    }

    // Ping fires once at hook creation. Don't ingest, don't DLQ — just pong.
    if (eventName === 'ping') {
      sendJson(res, 200, { pong: true });
      return;
    }

    const ALLOWED_EVENTS: ReadonlySet<string> = new Set([
      'issues',
      'issue_comment',
      'pull_request',
      'pull_request_review_comment',
    ]);
    if (eventName === null || !ALLOWED_EVENTS.has(eventName)) {
      const db = openHippoDb(opts.hippoRoot);
      try {
        writeToGitHubDlq(db, {
          tenantId: process.env.HIPPO_TENANT ?? 'default',
          rawPayload: rawBody,
          error: `unhandled event: ${eventName ?? '(missing X-GitHub-Event)'}`,
          bucket: 'unhandled',
          eventName,
          deliveryId,
          signature: sigStr,
          installationId: installationFromRaw,
          repoFullName: repoFromRaw,
        });
      } finally {
        closeHippoDb(db);
      }
      sendJson(res, 200, { ok: true, status: 'dlq' });
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      const db = openHippoDb(opts.hippoRoot);
      try {
        writeToGitHubDlq(db, {
          tenantId: process.env.HIPPO_TENANT ?? 'default',
          rawPayload: rawBody,
          error: 'invalid JSON',
          bucket: 'parse_error',
          eventName,
          deliveryId,
          signature: sigStr,
          installationId: installationFromRaw,
          repoFullName: repoFromRaw,
        });
      } finally {
        closeHippoDb(db);
      }
      sendJson(res, 200, { ok: true, status: 'dlq' });
      return;
    }

    if (!isGitHubWebhookEnvelope(body)) {
      const db = openHippoDb(opts.hippoRoot);
      try {
        writeToGitHubDlq(db, {
          tenantId: process.env.HIPPO_TENANT ?? 'default',
          rawPayload: rawBody,
          error: 'not a GitHub webhook envelope',
          bucket: 'parse_error',
          eventName,
          deliveryId,
          signature: sigStr,
          installationId: installationFromRaw,
          repoFullName: repoFromRaw,
        });
      } finally {
        closeHippoDb(db);
      }
      sendJson(res, 200, { ok: true, status: 'dlq' });
      return;
    }

    const installationId = body.installation?.id != null ? String(body.installation.id) : null;
    const repoFullName = body.repository?.full_name ?? null;

    // Tenant resolution. Fail closed on multi-tenant installs with unknown
    // routing — same policy as Slack.
    let resolvedTenant: string | null;
    {
      const db = openHippoDb(opts.hippoRoot);
      try {
        resolvedTenant = resolveTenantForGitHub(db, {
          installationId,
          repoFullName,
        });
      } finally {
        closeHippoDb(db);
      }
    }
    if (resolvedTenant === null) {
      const db = openHippoDb(opts.hippoRoot);
      try {
        writeToGitHubDlq(db, {
          tenantId: null,
          rawPayload: rawBody,
          error: `unroutable: installation_id=${installationId ?? '(none)'} repo=${repoFullName ?? '(none)'}`,
          bucket: 'unroutable',
          eventName,
          deliveryId,
          signature: sigStr,
          installationId,
          repoFullName,
        });
      } finally {
        closeHippoDb(db);
      }
      sendJson(res, 200, { ok: true, status: 'dlq' });
      return;
    }

    const ctx: Context = {
      hippoRoot: opts.hippoRoot,
      tenantId: resolvedTenant,
      actor: 'connector:github',
    };

    // Dispatch by event header. Type guards cross-check the body shape against
    // the header so a payload of one event type cannot satisfy another's guard.
    if (eventName === 'issues' && isGitHubIssueEvent(body, 'issues')) {
      if (body.action === 'deleted') {
        // GitHub does fire issues.deleted (admin-initiated). Don't archive — V1
        // policy is to log and let an operator decide. Archive could lose the
        // memory if the issue is being moved between accounts.
        const db = openHippoDb(opts.hippoRoot);
        try {
          writeToGitHubDlq(db, {
            tenantId: resolvedTenant,
            rawPayload: rawBody,
            error: 'issues.deleted requires manual review',
            bucket: 'unhandled',
            eventName,
            deliveryId,
            signature: sigStr,
            installationId,
            repoFullName,
          });
        } finally {
          closeHippoDb(db);
        }
        sendJson(res, 200, { ok: true, status: 'dlq' });
        return;
      }
      const ingestInput: GitHubIngestEvent = { eventName: 'issues', payload: body };
      const r = ingestGitHubEvent(ctx, { event: ingestInput, rawBody, deliveryId });
      sendJson(res, 200, { ok: true, status: r.status, memoryId: r.memoryId });
      return;
    }

    if (eventName === 'issue_comment' && isGitHubIssueCommentEvent(body, 'issue_comment')) {
      if (body.action === 'deleted') {
        const repo = body.repository?.full_name ?? '';
        const artifactRef = `github://${repo}/issue/${body.issue.number}/comment/${body.comment.id}`;
        // v1.3.2: deletion key uses a 'deleted:' namespace so it doesn't collide
        // with the ingest path's key for the same artifact. Without the prefix,
        // a previously-ingested comment's log row would make hasSeenKey return
        // true on the first deletion, short-circuiting archive. Codex round 3
        // P0 fix evolved through two iterations to land here.
        const idempotencyKey = computeGitHubDeletionKey(artifactRef, body.comment.updated_at ?? null);
        const r = handleGitHubCommentDeleted(ctx, {
          artifactRef,
          idempotencyKey,
          deliveryId,
          eventName,
        });
        sendJson(res, 200, { ok: true, status: r.status, archivedCount: r.archivedCount });
        return;
      }
      const ingestInput: GitHubIngestEvent = { eventName: 'issue_comment', payload: body };
      const r = ingestGitHubEvent(ctx, { event: ingestInput, rawBody, deliveryId });
      sendJson(res, 200, { ok: true, status: r.status, memoryId: r.memoryId });
      return;
    }

    if (eventName === 'pull_request' && isGitHubPullRequestEvent(body, 'pull_request')) {
      const ingestInput: GitHubIngestEvent = { eventName: 'pull_request', payload: body };
      const r = ingestGitHubEvent(ctx, { event: ingestInput, rawBody, deliveryId });
      sendJson(res, 200, { ok: true, status: r.status, memoryId: r.memoryId });
      return;
    }

    if (
      eventName === 'pull_request_review_comment' &&
      isGitHubPullRequestReviewCommentEvent(body, 'pull_request_review_comment')
    ) {
      if (body.action === 'deleted') {
        const repo = body.repository?.full_name ?? '';
        const artifactRef = `github://${repo}/pull/${body.pull_request.number}/review_comment/${body.comment.id}`;
        // v1.3.2: see issue_comment branch comment above for the namespace rationale.
        const idempotencyKey = computeGitHubDeletionKey(artifactRef, body.comment.updated_at ?? null);
        const r = handleGitHubCommentDeleted(ctx, {
          artifactRef,
          idempotencyKey,
          deliveryId,
          eventName,
        });
        sendJson(res, 200, { ok: true, status: r.status, archivedCount: r.archivedCount });
        return;
      }
      const ingestInput: GitHubIngestEvent = {
        eventName: 'pull_request_review_comment',
        payload: body,
      };
      const r = ingestGitHubEvent(ctx, { event: ingestInput, rawBody, deliveryId });
      sendJson(res, 200, { ok: true, status: r.status, memoryId: r.memoryId });
      return;
    }

    // Header allow-listed but body shape didn't satisfy the matching guard.
    {
      const db = openHippoDb(opts.hippoRoot);
      try {
        writeToGitHubDlq(db, {
          tenantId: resolvedTenant,
          rawPayload: rawBody,
          error: `body shape did not match X-GitHub-Event=${eventName}`,
          bucket: 'parse_error',
          eventName,
          deliveryId,
          signature: sigStr,
          installationId,
          repoFullName,
        });
      } finally {
        closeHippoDb(db);
      }
      sendJson(res, 200, { ok: true, status: 'dlq' });
      return;
    }
  }

  // ── MCP-over-HTTP/SSE transport (Task 11) ──
  //
  // Two routes implement an MCP HTTP transport alongside the stdio one. Both
  // dispatch to the same `handleMcpRequest` as the stdio loop in src/mcp/server.ts.
  //
  // POST /mcp        — Send a JSON-RPC request, get a JSON-RPC response synchronously
  //                    in the body. Content-type: application/json both ways.
  // GET  /mcp/stream — Open an SSE stream for server-initiated messages.
  //                    v1 simplification: this stream is keepalive-only. Clients
  //                    that need server-pushed notifications/progress will see
  //                    only `: ping` comments every 30s. All real responses come
  //                    back synchronously on POST /mcp. This matches the
  //                    "synchronous JSON in body" leg of the MCP HTTP spec and
  //                    is enough for `tools/list` / `tools/call` round-trips.
  //                    Server-initiated SSE messages will be wired in a later task.
  //
  // Auth: same as /v1/* — Bearer token validated via `requireAuth`, with the
  // loopback no-auth fallback. SSE check runs once at stream-open.

  if (method === 'POST' && path === '/mcp') {
    // Build the same Context the /v1/* routes use so MCP tool calls inherit
    // the server's bound hippoRoot and the auth-resolved tenantId / actor.
    // Without this, executeTool would walk from cwd via findHippoRoot() and
    // pull tenant from HIPPO_TENANT, dropping a valid Bearer for tenant B
    // back to whatever the env says.
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const raw = await readBody(req);
    let mcpReq: McpRequest;
    try {
      mcpReq = JSON.parse(raw) as McpRequest;
    } catch {
      throw new HttpError(400, 'invalid JSON-RPC body');
    }
    if (!mcpReq || typeof mcpReq !== 'object' || typeof mcpReq.method !== 'string') {
      throw new HttpError(400, 'JSON-RPC body must include a method string');
    }
    let mcpRes;
    try {
      mcpRes = await handleMcpRequest(mcpReq, {
        hippoRoot: ctx.hippoRoot,
        tenantId: ctx.tenantId,
        actor: ctx.actor,
        clientKey: buildMcpClientKey(req),
      });
    } catch (err) {
      mcpRes = {
        jsonrpc: '2.0' as const,
        id: mcpReq.id,
        error: { code: -32603, message: err instanceof Error ? err.message : 'internal error' },
      };
    }
    if (mcpRes === null) {
      // Notification — no body, 202 Accepted.
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, mcpRes);
    return;
  }

  if (method === 'GET' && path === '/mcp/stream') {
    requireAuth(req, opts.hippoRoot);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // Initial ping so smoke tests can confirm the stream is live without
    // waiting for the first keepalive interval.
    res.write(': ping\n\n');

    // v0.39 SSE hardening:
    //   - Heartbeat re-validates the bearer (default 60s). If the key was
    //     revoked or rotated, close the stream with reason='auth_revoked'.
    //   - MCP_SSE_MAX_AGE_SEC (default 3600) caps stream lifetime; close
    //     with reason='max_age_exceeded' when reached.
    //   - MCP_SSE_HEARTBEAT_MS (default 60000) lets tests run with a short
    //     interval without waiting a full minute.
    const heartbeatMs =
      parseInt(process.env.MCP_SSE_HEARTBEAT_MS ?? '60000', 10) || 60000;
    const maxAgeMs =
      (parseInt(process.env.MCP_SSE_MAX_AGE_SEC ?? '3600', 10) || 3600) * 1000;
    const startedAt = Date.now();
    let closed = false;
    const closeWith = (reason: string): void => {
      if (closed) return;
      closed = true;
      try {
        res.write(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`);
      } catch { /* socket already gone */ }
      try { res.end(); } catch { /* socket already gone */ }
    };
    const ping = setInterval(() => {
      if (closed) {
        clearInterval(ping);
        return;
      }
      if (Date.now() - startedAt >= maxAgeMs) {
        closeWith('max_age_exceeded');
        clearInterval(ping);
        return;
      }
      try {
        requireAuth(req, opts.hippoRoot);
      } catch {
        closeWith('auth_revoked');
        clearInterval(ping);
        return;
      }
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(ping);
      }
    }, heartbeatMs);
    // Don't keep the event loop alive just for this timer — the server's
    // listener already does that, and tests want the process to exit cleanly.
    if (typeof ping.unref === 'function') ping.unref();
    req.on('close', () => clearInterval(ping));
    return;
  }

  res.writeHead(404, JSON_HEADERS);
  res.end(JSON.stringify({ error: 'not found' }));
}

/**
 * Boot the HTTP daemon on host:port and write the pidfile under hippoRoot.
 *
 * Refuses non-loopback hosts at boot (Footgun #3 from the A1 plan): without
 * the A5 v2 auth middleware we have no way to gate remote requests, so we
 * fail fast rather than expose the DB to the network. Task 9 will lift this
 * restriction once Bearer-token validation lands.
 *
 * Use port: 0 in tests to bind to an ephemeral port and read the actual
 * port back via server.address() after listen.
 */
export async function serve(opts: ServeOpts): Promise<ServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const requestedPort = opts.port ?? Number(process.env.HIPPO_PORT ?? 6789);

  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Refusing to bind hippo serve to non-loopback host '${host}' without auth. ` +
      `Remote-host serving requires the A5 v2 auth middleware (Task 9 of the A1 plan). ` +
      `Bind to 127.0.0.1 / ::1 / localhost, or wait for auth support.`,
    );
  }

  const startedAt = new Date().toISOString();

  const server: Server = createServer((req, res) => {
    handleRequest(req, res, opts, startedAt).catch((err: unknown) => {
      if (res.headersSent) {
        try { res.end(); } catch { /* socket already gone */ }
        return;
      }
      if (err instanceof BodyTooLargeError) {
        sendError(res, 413, err.message);
        return;
      }
      if (err instanceof HttpError) {
        sendError(res, err.status, err.message);
        return;
      }
      const mapped = mapApiError(err);
      sendError(res, mapped.status, mapped.message);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, host);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('server.address() returned unexpected shape');
  }
  const actualPort = address.port;
  const url = `http://${host}:${actualPort}`;

  writePidfile(opts.hippoRoot, { port: actualPort, url });

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    removePidfile(opts.hippoRoot);
    // Force-close any long-lived idle connections (e.g. SSE keepalive streams
    // on /mcp/stream) so server.close() can resolve. Without this, SIGTERM
    // would hang the process until the SSE client cancels. Available on
    // Node 18.2+; gate via optional chaining to avoid crashing on older runtimes.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  // Skip signal handlers under vitest so each test run does not register a
  // stray SIGTERM/SIGINT listener that survives until the runner exits.
  if (!process.env.VITEST) {
    let shuttingDown = false;
    const gracefulShutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.error(`Received ${signal}, shutting down...`);
      try {
        await stop();
      } catch (err) {
        console.error('Error during stop:', err);
      } finally {
        process.exit(0);
      }
    };
    process.once('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
    process.once('SIGINT', () => { void gracefulShutdown('SIGINT'); });
  }

  return { port: actualPort, url, stop };
}
