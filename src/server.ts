import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { resolveProjectIdentity } from './project-identity.js';
import { assembleCost, contextCost, drillCost } from './context-render.js';
import { detectServer, writePidfile, removePidfileIfOwned } from './server-detect.js';
import { resolveTenantId } from './tenant.js';
import { openHippoDb, closeHippoDb } from './db.js';
import { updateStats } from './store.js';
import {
  buildSessionKey,
  getOrCreateRing,
  appendRecall,
  snapshotRing,
  hashQueryText,
  biasHintEnabled,
  RingBuffer,
} from './recall-history.js';
import { appendAuditEvent, auditQueryFields, AUDIT_OPS } from './audit.js';

// v0.33 / J1 — Module-level per-(tenant, session) recall-history ring map
// for the HTTP pipeline. Separate from CLI/MCP rings per plan v3 (per-
// pipeline rings; no IPC). HTTP is the only caller that threads its
// snapshot through opts.recallHistory to api.recall — api.recall's
// anchoringHint on the returned RecallResult IS the user-visible hint
// here (no separate compute needed).
const sessionRecallHistoryHttp = new Map<string, RingBuffer>();

/** Test-only: reset the module-level recall-history Map. Call from beforeEach. */
export function __resetSessionRecallHistoryHttp(): void {
  sessionRecallHistoryHttp.clear();
}
import { PACKAGE_VERSION } from './version.js';
import { API_KEY_PREFIX, validateApiKey } from './auth.js';
import { createRateLimiter, type RateLimiter } from './rate-limit.js';
import {
  remember,
  retrieve,
  RecallContractError,
  ForbiddenError,
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
  outcome,
  outcomeForLastRecall,
  getContext,
  sleep,
  recordTokens,
  quarantineList,
  quarantineApprove,
  quarantineReject,
  type Actor,
  type Context,
  type RecallOpts,
  type AssembleOpts,
  type DrillDownOpts,
} from './api.js';
import type { MemoryKind } from './memory.js';
import type { AuditOp } from './audit.js';
import { buildGraphModel } from './graph-view.js';
import { MAX_ENTITY_NAME_LEN } from './graph.js';
import {
  savePrediction,
  closePrediction,
  loadPredictionById,
  loadPredictionsByClass,
  loadOpenPredictions,
  computePredictionBaserate,
  VALID_CLOSURE_STATES,
} from './predictions.js';
import {
  saveDecision,
  closeDecision,
  loadDecisionById,
  loadDecisions,
  VALID_DECISION_STATES,
} from './decisions.js';
import {
  saveIncident,
  resolveIncident,
  closeIncident,
  loadIncidentById,
  loadIncidents,
  VALID_INCIDENT_STATES,
} from './incidents.js';
import {
  saveProcess,
  closeProcess,
  loadProcessById,
  loadProcesses,
  VALID_PROCESS_STATES,
} from './processes.js';
import {
  savePolicy,
  closePolicy,
  loadPolicyById,
  loadPolicies,
  loadPoliciesAsOf,
  VALID_POLICY_STATES,
} from './policies.js';
import {
  saveSkill,
  closeSkill,
  loadSkillById,
  loadSkills,
  exportSkills,
  VALID_SKILL_STATES,
} from './skills.js';
import {
  saveProjectBrief,
  closeProjectBrief,
  loadProjectBriefById,
  loadProjectBriefs,
  assembleBriefFromReceipts,
  refreshBrief,
  VALID_BRIEF_STATES,
  type BriefStatus,
} from './project-briefs.js';
import {
  saveCustomerNote,
  closeCustomerNote,
  loadCustomerNoteById,
  loadCustomerNotes,
  VALID_NOTE_STATES,
  type NoteStatus,
} from './customer-notes.js';
import { handleMcpRequest, type McpRequest } from './mcp/server.js';
import { handleSlackEventsWebhook } from './connectors/slack/webhook.js';
import { handleGitHubEventsWebhook } from './connectors/github/webhook.js';
import {
  HttpError,
  JSON_HEADERS,
  BodyTooLargeError,
  isHeaderString,
  isJsonObjectRecord,
  readBody,
  sendJson,
  type JsonValue,
} from './http-util.js';

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

const VALID_AUDIT_OPS: ReadonlySet<AuditOp> = new Set<AuditOp>(AUDIT_OPS);

// Cap on GET /v1/audit?limit=. Matches docs/api.md (when written) and is large
// enough to dump a small deployment's full audit log without paginating, but
// small enough that a malicious client can't ask for the world.
const MAX_AUDIT_LIMIT = 10000;

function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === 'string';
}

function isJsonNumber(value: JsonValue | undefined): value is number {
  return typeof value === 'number';
}

function isJsonBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === 'boolean';
}

// server.address() returns AddressInfo once a TCP socket is bound; null before
// listening, a string only for pipe/unix-socket listeners (never used here).
function isAddressInfo(
  a: string | import('node:net').AddressInfo | null,
): a is import('node:net').AddressInfo {
  return a !== null && typeof a !== 'string';
}

// Runtime membership check for a `ReadonlySet<T>` of string-literal union
// members, used at every `body` field validated against a VALID_* set below.
// Set<T>.has(value: T) itself gives no narrowing (its parameter type is T,
// not a type predicate) so callers previously needed a separate `as T` cast
// at both the check and the later usage; this helper is the one place that
// assertion lives, so downstream call sites narrow via the `value is T`
// return instead of re-asserting.
function isSetMember<T extends string>(set: ReadonlySet<T>, value: string): value is T {
  // SAFETY: `value as T` is discarded unless `set.has` (the real runtime
  // check) confirms membership; the `value is T` return type is what
  // performs the actual narrowing for callers.
  return set.has(value as T);
}

// HTTP-boundary validation for a process `steps` body (untrusted). Returns the
// step strings (saveProcess re-validates + trims, this is the fail-fast 400
// gate). Caps mirror src/processes.ts MAX_PROCESS_STEPS / MAX_PROCESS_STEP_LEN.
function validateProcessStepsBody(raw: JsonValue | undefined): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new HttpError(400, 'steps must be an array of strings');
  }
  if (raw.length > 200) {
    throw new HttpError(400, 'steps exceeds 200-step cap');
  }
  for (const item of raw) {
    if (!isJsonString(item)) {
      throw new HttpError(400, 'each step must be a string');
    }
    if (item.trim().length === 0) {
      throw new HttpError(400, 'a step is empty');
    }
    if (item.length > 2000) {
      throw new HttpError(400, 'a step exceeds the 2000-character cap');
    }
  }
  // SAFETY: every item in raw was confirmed to be a string in the loop above.
  return raw as string[];
}

// HTTP-boundary check for an optional policy date field (validFrom/validTo).
// Type + length only; savePolicy/loadPoliciesAsOf normalize + format-validate the
// value (an unparseable date throws there -> mapped to 400). 64-char cap bounds a
// junk string before it reaches the Date parser.
function optionalDateField(raw: JsonValue | undefined, label: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isJsonString(raw)) {
    throw new HttpError(400, `${label} must be a string`);
  }
  if (raw.length > 64) {
    throw new HttpError(400, `${label} exceeds 64-character cap`);
  }
  return raw;
}

// Parse a `?limit=` query param for the E2 list routes. Defaults to 100; requires
// a positive INTEGER <= 1000. Number.isInteger rejects fractional values like
// "1.5" that Number.isFinite would pass but SQLite `LIMIT ?` rejects with a
// datatype mismatch (a 500). Shared across the decision/incident/process/policy
// list routes so the guard cannot drift (codex review 2026-05-30 P2: fractional
// limit reached SQLite on the policy route; the same latent hole existed in the
// sibling routes this was copied from).
function parseListLimit(limitRaw: string | null): number {
  if (limitRaw === null) return 100;
  const limit = Number(limitRaw);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
    throw new HttpError(400, 'limit must be a positive integer <= 1000');
  }
  return limit;
}

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

export interface ServerHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
  /** Introspection-only (v1.26.2): the underlying node:http Server, exposed so
   *  tests can assert keep-alive/headers timeout hardening without reaching
   *  into serve()'s closure. Additive field — do not depend on it for control
   *  flow outside tests. */
  server?: import('node:http').Server;
}

/** Identity an {@link AuthResolver} vouches for. The core sanitises it before use. */
export interface ResolvedBearer {
  tenantId: string;
  subject: string;
  /** Not 'admin' means 'member'. Admin is tenant-only, yet can mint member API keys (POST /v1/auth/keys) that outlive IdP deprovisioning. */
  role: 'admin' | 'member';
  scopes?: readonly string[];
}

/** Sole judge of non-`hk_` bearer tokens: null is a 401; a throw or missed deadline is a 503, so throw only when upstream is down. */
export type AuthResolver = (token: string) => ResolvedBearer | null | Promise<ResolvedBearer | null>;

export interface ServeOpts {
  hippoRoot: string;
  /** Runs on every request and SSE heartbeat, so keep it cache-backed; API keys never reach it. */
  authResolver?: AuthResolver;
  /** Deadline for one authResolver call; defaults to 5000 ms. */
  authResolverTimeoutMs?: number;
  port?: number;
  host?: string;
  /** Stop and exit on SIGINT/SIGTERM. Only `hippo serve` owns the process, so only it sets this. */
  handleSignals?: boolean;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, JsonValue>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed: JsonValue = JSON.parse(raw);
    if (!isJsonObjectRecord(parsed)) {
      throw new HttpError(400, 'request body must be a JSON object');
    }
    return parsed;
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
 * ForbiddenError maps to 403; everything else to 400 (bad input).
 */
function mapApiError<E>(err: E) {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ForbiddenError) {
    return { status: 403, message };
  }
  const lower = message.toLowerCase();
  if (/not found/.test(lower) || /^unknown /.test(lower)) {
    return { status: 404, message };
  }
  if (/already superseded/.test(lower)) {
    return { status: 409, message };
  }
  if (/requires admin role/.test(lower)) {
    return { status: 403, message };
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

// Any other Host on a loopback socket is DNS rebinding: a hostile page resolved to 127.0.0.1.
export const LOOPBACK_HOST_HEADER = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** A browser request sent by another site. Non-browser clients send neither header and pass. */
export function isCrossSite(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  return origin !== undefined && origin !== `http://${req.headers.host}`;
}

// A browser on this machine is loopback too, so the no-key fallback also needs a local Host and a same-site caller.
function assertLocalCaller(req: IncomingMessage): void {
  if (!isLoopback(req.socket.remoteAddress)) throw new HttpError(401, 'auth required');
  const host = req.headers.host;
  if ((host !== undefined && !LOOPBACK_HOST_HEADER.test(host)) || isCrossSite(req)) {
    throw new HttpError(403, 'cross-site or non-local request refused; send an API key');
  }
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
  if (!isHeaderString(value) || value.length === 0) {
    return { kind: 'malformed' };
  }
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
 * Rate-limit key for a request. Defaults to the socket's remote address.
 *
 * Behind a TLS-terminating proxy (Fly, most PaaS ingress) every socket
 * carries the proxy's address, so per-IP buckets collapse into one global
 * bucket that unauthenticated traffic can drain before auth runs. Set
 * HIPPO_CLIENT_IP_HEADER to the header the proxy stamps with the real
 * client address (fly-client-ip on Fly, which the edge always overwrites)
 * to key buckets per client instead.
 *
 * Only set this when a trusted proxy fronts EVERY request: a directly
 * reachable server honoring the header would let clients mint a fresh
 * bucket per request and bypass the limiter entirely.
 */
export function clientIpForRateLimit(req: IncomingMessage): string {
  const header = process.env.HIPPO_CLIENT_IP_HEADER?.toLowerCase();
  if (header) {
    const raw = req.headers[header];
    const first = Array.isArray(raw) ? raw[0] : raw;
    // Take the first entry of a comma-joined list (proxy chains append).
    const ip = first?.split(',')[0]?.trim();
    if (ip) return ip;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

type AuthOpts = Pick<ServeOpts, 'hippoRoot' | 'authResolver' | 'authResolverTimeoutMs'>;

// Built-in actors are the bare names below or `<name>:<detail>`; a plain prefix would also reject `clinton@corp`.
const RESERVED_ACTOR_NAMES = [
  'api_key', 'localhost', 'cli', 'system', 'mcp', 'connector', 'sleep', 'post-compact', 'recall', 'agent-memories',
] as const;

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Core owns the checks so a resolver cannot mint an actor that collides with a built-in one. */
function sanitiseResolved(r: ResolvedBearer): ResolvedBearer | null {
  // Each field is read once: a getter on plugin code could answer differently the second time.
  const { tenantId, subject, role, scopes } = r;
  // A resolver is plugin code, so the runtime checks hold even though the static types say string.
  if (!isJsonString(tenantId) || tenantId.trim().length === 0) return null;
  // Core reserves `__`-prefixed tenants (`__host__`, `__unroutable__`).
  const tenant = tenantId.trim();
  if (tenant.startsWith('__') || tenant.length > 256 || hasControlChar(tenant)) return null;
  if (!isJsonString(subject) || subject.length < 1 || subject.length > 256) return null;
  // Padding would let "system " pass the reserved-name check yet read as `system` in an audit log.
  if (hasControlChar(subject) || subject !== subject.trim()) return null;
  const lower = subject.toLowerCase();
  if (RESERVED_ACTOR_NAMES.some((n) => lower === n || lower.startsWith(`${n}:`))) return null;
  const clean: ResolvedBearer = { tenantId: tenant, subject, role: role === 'admin' ? 'admin' : 'member' };
  if (Array.isArray(scopes)) clean.scopes = scopes.filter((s) => isJsonString(s));
  return clean;
}

function logResolverFailure(what: string, raw: string, token: string): void {
  // The plugin's message is logged, but never the token, even if the plugin echoed it.
  const msg = raw.split(token).join('[token]').replace(/[\r\n]/g, ' ');
  process.stderr.write(`[hippo] auth resolver ${what}: ${msg}\n`);
}

/** 503 when upstream throws or misses the deadline, so a stream heartbeat can tell an outage from a revocation. */
async function askResolver(resolver: AuthResolver, token: string, deadlineMs: number): Promise<ResolvedBearer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${deadlineMs} ms`)), deadlineMs);
  });
  let resolved: ResolvedBearer | null;
  try {
    resolved = await Promise.race([(async () => resolver(token))(), deadline]);
  } catch (err) {
    logResolverFailure('threw', err instanceof Error ? err.message : 'unknown error', token);
    throw new HttpError(503, 'auth provider unavailable');
  } finally {
    clearTimeout(timer);
  }
  let clean: ResolvedBearer | null = null;
  try {
    clean = resolved ? sanitiseResolved(resolved) : null;
  } catch (err) {
    // A throwing getter is a resolver bug, not an outage, so it is a 401 like any malformed answer.
    logResolverFailure('threw', err instanceof Error ? err.message : 'unknown error', token);
  }
  if (!clean) throw new HttpError(401, 'invalid api key');
  return clean;
}

/** Set by the core only: sanitiseResolved builds a fresh object, so a resolver cannot claim the tag. */
interface BearerIdentity extends ResolvedBearer {
  viaAuthResolver?: true;
}

const DEFAULT_RESOLVER_DEADLINE_MS = 5000;

/** Shared by buildContextWithAuth and requireAuth so the two cannot drift. */
async function resolveBearer(token: string, opts: AuthOpts): Promise<BearerIdentity> {
  // Routing by shape keeps key plaintext out of plugin code and stops a resolver overriding a key's identity.
  if (opts.authResolver && !token.startsWith(API_KEY_PREFIX)) {
    const t = opts.authResolverTimeoutMs;
    const deadlineMs = t !== undefined && Number.isFinite(t) && t > 0 ? t : DEFAULT_RESOLVER_DEADLINE_MS;
    return { ...(await askResolver(opts.authResolver, token, deadlineMs)), viaAuthResolver: true };
  }
  const db = openHippoDb(opts.hippoRoot);
  try {
    const result = validateApiKey(db, token);
    if (!result.valid || !result.tenantId || !result.keyId || !result.role) {
      throw new HttpError(401, 'invalid api key');
    }
    return {
      tenantId: result.tenantId,
      subject: `api_key:${result.keyId}`,
      role: result.role,
      scopes: result.scopes,
    };
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Build a per-request Context from the Authorization header and remote
 * address. Throws HttpError(401) for invalid / missing credentials. Opens
 * the DB only for an API-key-shaped Bearer token (or any Bearer token when no
 * auth resolver is registered), so loopback no-auth requests stay cheap.
 */
async function buildContextWithAuth(req: IncomingMessage, opts: AuthOpts): Promise<Context> {
  const auth = readAuthHeader(req);

  if (auth.kind === 'malformed') {
    throw new HttpError(401, 'invalid api key');
  }

  if (auth.kind === 'bearer') {
    const id = await resolveBearer(auth.token, opts);
    const actor: Actor = { subject: id.subject, role: id.role, scopes: id.scopes };
    if (id.viaAuthResolver) actor.viaAuthResolver = true;
    return { hippoRoot: opts.hippoRoot, tenantId: id.tenantId, actor };
  }

  // No Authorization header. Loopback-only fallback, unless explicitly
  // disabled via HIPPO_REQUIRE_AUTH=1 (used by the bearer-lockdown test
  // and by deployments that want to forbid the local-CLI escape hatch).
  if (process.env.HIPPO_REQUIRE_AUTH === '1') {
    throw new HttpError(401, 'auth required');
  }
  assertLocalCaller(req);

  // v1.12.0: loopback fallback is process-local, treat as admin.
  return {
    hippoRoot: opts.hippoRoot,
    tenantId: resolveTenantId({}),
    actor: { subject: 'localhost:cli', role: 'admin' },
  };
}

/**
 * Auth check for routes that do not need a tenant Context (e.g. MCP transport,
 * which builds its own root resolution via findHippoRoot). Throws HttpError
 * 401 the same way buildContextWithAuth does, but skips building the Context
 * envelope. Loopback no-auth still passes.
 */
async function requireAuth(req: IncomingMessage, opts: AuthOpts): Promise<void> {
  const auth = readAuthHeader(req);
  if (auth.kind === 'malformed') {
    throw new HttpError(401, 'invalid api key');
  }
  if (auth.kind === 'bearer') {
    await resolveBearer(auth.token, opts);
    return;
  }
  if (process.env.HIPPO_REQUIRE_AUTH === '1') {
    throw new HttpError(401, 'auth required');
  }
  assertLocalCaller(req);
}

/** Never rejects: an outage (5xx) skips one heartbeat tick, only a definite 4xx denial closes the stream. */
async function heartbeatVerdict(req: IncomingMessage, opts: AuthOpts): Promise<'ok' | 'revoked' | 'unavailable'> {
  try {
    await requireAuth(req, opts);
    return 'ok';
  } catch (err) {
    return err instanceof HttpError && err.status < 500 ? 'revoked' : 'unavailable';
  }
}

/** Gate for any action beyond the caller's own tenant: a resolver admin is a customer's tenant admin, never a host admin. */
function assertCrossTenantAdmin(ctx: Context, what: string): void {
  if (ctx.actor.role !== 'admin') throw new HttpError(403, `${what} requires admin role`);
  if (ctx.actor.viaAuthResolver) throw new HttpError(403, `${what} requires an API-key admin`);
}

function getString(obj: Record<string, JsonValue>, key: string): string | undefined {
  const v = obj[key];
  return isJsonString(v) ? v : undefined;
}

function getStringArray(obj: Record<string, JsonValue>, key: string): string[] | undefined {
  const v = obj[key];
  if (!Array.isArray(v)) return undefined;
  if (!v.every(isJsonString)) return undefined;
  return v;
}

/**
 * Reject URL-encoded slashes in path segments BEFORE the URL parser decodes
 * them — otherwise `%2F` becomes `/`, path-split runs, and the route either
 * silently 404s or matches the wrong template.
 *
 * codex round 3 P2: only scan the PATHNAME portion of the raw URL, not the
 * query string. Pre-fix, `?q=https%3A%2F%2Fexample.com` would 400 because
 * the regex matched `%2F` anywhere in `req.url`. Recall queries containing
 * URLs would have been rejected as bypass attempts. Splitting on the first
 * `?` confines the check to the path.
 */
function rejectEncodedSlash(rawUrl: string): void {
  const queryIdx = rawUrl.indexOf('?');
  const pathname = queryIdx === -1 ? rawUrl : rawUrl.slice(0, queryIdx);
  if (/%2[Ff]/.test(pathname)) {
    throw new HttpError(400, 'URL-encoded slash (%2F) not allowed in path segments');
  }
}

/**
 * v1.6.4: charset + length validation for `:id` route captures. Routes call
 * this immediately after `matchPath` to reject empty / overlong / illegal
 * ids with a useful 400 instead of silently falling through to "not found".
 *
 * Allowed charset matches all production id shapes Hippo emits: `mem_<hex>`,
 * `sum_<hex>`, `sess-<id>`, Slack bot ids like `B01ABCD`, etc. The `:` and
 * `.` are allowed for forward-compat. The `/` is intentionally absent —
 * Hippo never emits ids with slashes, and `rejectEncodedSlash` already
 * stops `%2F`-smuggled ones at the front door.
 */
const ID_SEGMENT_RE = /^[A-Za-z0-9_:.\-]+$/;
function validateIdSegment(id: string, fieldName: string): void {
  if (id.length === 0) throw new HttpError(400, `${fieldName} is required`);
  if (id.length > 256) throw new HttpError(400, `${fieldName} exceeds 256-character cap`);
  if (!ID_SEGMENT_RE.test(id)) {
    throw new HttpError(400, `${fieldName} contains invalid characters; allowed: A-Z a-z 0-9 _ : . -`);
  }
}

/** Per-request values the /v1 route handlers read. */
interface RouteRequest {
  req: IncomingMessage;
  res: ServerResponse;
  opts: ServeOpts;
  query: URLSearchParams;
}

/** One /v1 route: an exact path, a matchPath pattern, or a regex, each paired with the handler for one method. */
type Route =
  | { method: string; path: string; handler: (r: RouteRequest) => Promise<void> }
  | { method: string; pattern: string; handler: (r: RouteRequest, params: Record<string, string>) => Promise<void> }
  | { method: string; regex: RegExp; handler: (r: RouteRequest, match: RegExpMatchArray) => Promise<void> };

// POST /v1/memories
async function handleCreateMemory({ req, res, opts }: RouteRequest): Promise<void> {
  const body = await parseJsonBody(req);
  const content = getString(body, 'content');
  if (!content) {
    throw new HttpError(400, 'content is required');
  }
  const kindRaw = getString(body, 'kind');
  if (kindRaw !== undefined && !isSetMember(VALID_KINDS, kindRaw)) {
    throw new HttpError(400, `invalid kind: ${kindRaw}`);
  }
  const ctx = await buildContextWithAuth(req, opts);
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
async function handleGetGraph({ req, res, opts, query }: RouteRequest): Promise<void> {
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

// GET /v1/memories?q=...&limit=...&mode=...&scope=...&include_continuity=1
async function handleRecallMemories({ req, res, opts, query }: RouteRequest): Promise<void> {
  const q = query.get('q');
  if (!q) {
    throw new HttpError(400, 'q is required');
  }
  const limitRaw = query.get('limit');
  const limit = limitRaw === null ? undefined : parseListLimit(limitRaw);
  const mode = query.get('mode');
  if (mode !== null && mode !== 'bm25' && mode !== 'hybrid' && mode !== 'physics') {
    throw new HttpError(400, "mode must be 'bm25', 'hybrid', or 'physics'");
  }
  const scope = query.get('scope');
  const includeContinuityRaw = query.get('include_continuity');
  const includeContinuity = includeContinuityRaw === '1'
    || includeContinuityRaw === 'true';
  // v1.6.2: surface the v1.5.0/v1.5.2 RecallOpts additions to HTTP
  // callers. Pre-v1.6.2 the route silently ignored these so the
  // session-scoped fresh-tail and summary substitution were JS-only.
  const freshTailCountRaw = query.get('fresh_tail_count');
  const freshTailCount = freshTailCountRaw === null ? undefined : Number(freshTailCountRaw);
  if (freshTailCount !== undefined && (!Number.isFinite(freshTailCount) || freshTailCount < 0)) {
    throw new HttpError(400, 'fresh_tail_count must be a non-negative number');
  }
  // v1.6.3 senior-review P1-3: cap session_id length consistent with the
  // rest of the API. Untrimmed strings round-trip through the SQL layer
  // and through any downstream metric/log; 256 is generous for a session
  // id and matches the rest of this file's id-shaped param parsers.
  const freshTailSessionIdRaw = query.get('fresh_tail_session_id');
  if (freshTailSessionIdRaw !== null && freshTailSessionIdRaw.length > 256) {
    throw new HttpError(400, 'fresh_tail_session_id exceeds 256-character cap');
  }
  const freshTailSessionId = freshTailSessionIdRaw && freshTailSessionIdRaw.length > 0
    ? freshTailSessionIdRaw
    : undefined;
  // v1.6.3 senior-review P1-4: tighten parser to match the includeContinuity
  // convention. Pre-v1.6.3 accepted any non-'0'/'false' value as `true`,
  // so `?summarize_overflow=banana` and `?summarize_overflow=` both
  // turned it on. Surface convention drift fixed.
  const summarizeOverflowRaw = query.get('summarize_overflow');
  const summarizeOverflow = summarizeOverflowRaw === null
    ? undefined
    : (summarizeOverflowRaw === '1' || summarizeOverflowRaw === 'true');
  // recall() owns the shape rule (NaN, 0 and negatives throw invalid_scorer_window); the transport caps remote cost.
  const scorerWindowRaw = query.get('scorer_window');
  const scorerWindow = scorerWindowRaw === null ? undefined : Number(scorerWindowRaw);
  if (scorerWindow !== undefined && scorerWindow > 1000) {
    throw new HttpError(400, 'scorer_window must be <= 1000');
  }
  // v1.7.4: session_id for the dlPFC goal-stack boost. 256-char cap mirrors
  // fresh_tail_session_id (above). Trim then drop if empty so api.recall
  // sees undefined when the param is omitted or whitespace-only.
  const sessionIdRaw = query.get('session_id');
  if (sessionIdRaw !== null && sessionIdRaw.length > 256) {
    throw new HttpError(400, 'session_id exceeds 256-character cap');
  }
  const sessionId = sessionIdRaw && sessionIdRaw.trim().length > 0
    ? sessionIdRaw.trim()
    : undefined;
  // A7 recall-trace: opt-in explain flag. When set, api.recall attaches the
  // lifecycle re-ranking trace (goal-boost step on the api pipeline) +
  // rerankPipeline:'api' to each result item; the field then rides on the
  // serialized RecallResult. Mirrors the include_continuity convention.
  const explainRaw = query.get('explain');
  const explain = explainRaw === '1' || explainRaw === 'true';
  const ctx = await buildContextWithAuth(req, opts);

  // v0.33 / J1 — HTTP per-pipeline anchoring detector. HTTP threads its
  // ring snapshot via opts.recallHistory so api.recall's own
  // anchoringHint compute path activates. Unlike CLI (which computes
  // its own hint separately because cmdRecall runs its own physics/
  // hybrid pipeline outside api.recall), HTTP's /v1/memories response
  // body IS api.recall's result directly. So the api.recall-computed
  // hint flows through. HIPPO_ANCHORING=off short-circuits.
  let httpRecallHistory: ReturnType<typeof snapshotRing> | undefined;
  let httpRingKey: string | undefined;
  if (biasHintEnabled('anchoring')) {
    if (sessionId) {
      // Codex round-5 P2 catch: do NOT mutate sessionRecallHistoryHttp
      // before recall() preflight runs. A request with an invalid
      // scorer_window / fresh_tail_count would create-or-touch the
      // session ring (LRU-evicting valid sessions) even though recall
      // throws 400. Snapshot the EXISTING ring if present; only
      // create-or-touch after the recall returns successfully.
      httpRingKey = buildSessionKey(ctx.tenantId, sessionId);
      const existingRing = sessionRecallHistoryHttp.get(httpRingKey);
      httpRecallHistory = existingRing ? snapshotRing(existingRing) : [];
    } else {
      // Telemetry: caller had no session_id so ring tracking skipped.
      // Per the normal recall-audit convention (api.ts:854 stores
      // SHA-256/16 hash of the query, NOT raw text), avoid retaining
      // prompts in audit_log here too — query content can contain
      // secrets, PII, or RTBF-restricted material. Codex round-2 P2
      // catch: hashQueryText is a 32-bit FNV-1a designed for recall
      // matching, NOT a privacy hash; brute-force trivial for low-
      // entropy queries. Use the same SHA-256/16 truncation as the
      // canonical recall audit.
      const dbForAudit = openHippoDb(opts.hippoRoot);
      try {
        appendAuditEvent(dbForAudit, {
          tenantId: ctx.tenantId,
          actor: ctx.actor.subject,
          op: 'recall_anchor_skipped_no_session',
          targetId: undefined,
          metadata: auditQueryFields(q),
        });
      } finally {
        closeHippoDb(dbForAudit);
      }
    }
  }

  const recallExtra: Pick<
    RecallOpts,
    'freshTailCount' | 'freshTailSessionId' | 'summarizeOverflow' | 'scorerWindow' | 'sessionId' | 'recallHistory' | 'explain'
  > = {};
  if (freshTailCount !== undefined) recallExtra.freshTailCount = freshTailCount;
  if (freshTailSessionId !== undefined) recallExtra.freshTailSessionId = freshTailSessionId;
  if (summarizeOverflow !== undefined) recallExtra.summarizeOverflow = summarizeOverflow;
  if (scorerWindow !== undefined) recallExtra.scorerWindow = scorerWindow;
  if (sessionId !== undefined) recallExtra.sessionId = sessionId;
  if (httpRecallHistory !== undefined) recallExtra.recallHistory = httpRecallHistory;
  if (explain) recallExtra.explain = explain;

  const result = await retrieve(ctx, {
    query: q,
    limit,
    mode: mode ?? undefined,
    scope: scope ?? undefined,
    includeContinuity,
    ...recallExtra,
  });

  // v0.33 / J1 — append AFTER recall completes (snapshot was taken before
  // recall() ran). anchoredOn carries the memoryId of any hint that fired
  // (api.recall computed it from the same snapshot we passed in), feeding
  // the cooldown logic for the NEXT recall on this session.
  // Codex round-5 P2 fix: create-or-touch the ring ONLY HERE, after recall
  // returns successfully. Invalid requests that throw 400 in recall()
  // never reach this point, so they cannot LRU-evict valid sessions.
  if (httpRingKey) {
    const httpRing = getOrCreateRing(sessionRecallHistoryHttp, httpRingKey);
    const topId = result.results[0]?.id ?? null;
    appendRecall(httpRing, hashQueryText(q), topId, result.anchoringHint?.memoryId);
  }

  // Each recall surface counts its own hits; api.recall is no chokepoint,
  // since the CLI never calls it and MCP shows the user a different band.
  updateStats(opts.hippoRoot, { recalled: result.results.length });

  // Continuity payloads should never be cached. The caller is asking for
  // session-state-aware data; intermediaries must not reuse it across users.
  if (includeContinuity) {
    res.setHeader('Cache-Control', 'no-store');
  }
  recordTokens(ctx, 'http_recall', { items: result.results.length, tokens: result.tokens + (result.continuityTokens ?? 0), sessionId: sessionId ?? null });
  sendJson(res, 200, result);
  return;
}

// GET /v1/sessions/:id/assemble?budget=N&freshTail=N&summarizeOlder=0|1
// Phase 2 context-engine API. Returns ordered AssembledContextItem[]
// with fresh-tail raws + summary substitutions + bio-aware budget fit.
// Tenant scope from Bearer; default-deny on private rows.
async function handleAssembleSession({ req, res, opts, query }: RouteRequest, assembleMatch: Record<string, string>): Promise<void> {
  validateIdSegment(assembleMatch.id!, 'session id');
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
  // v1.6.3 senior review P1: same strict-parse convention as the v1.6.3
  // summarize_overflow tighten on /v1/memories. Pre-v1.6.3 accepted any
  // non-'0'/'false' as true; ?summarizeOlder=banana now correctly returns
  // false (matches includeContinuity convention).
  const sumOlderRaw = query.get('summarizeOlder');
  const summarizeOlder = sumOlderRaw === null
    ? undefined
    : (sumOlderRaw === '1' || sumOlderRaw === 'true');
  const scopeQ = query.get('scope');
  const scope = scopeQ !== null && scopeQ.length > 0 ? scopeQ : undefined;
  const ctx = await buildContextWithAuth(req, opts);
  const assembleExtra: Pick<AssembleOpts, 'budget' | 'freshTailCount' | 'summarizeOlder' | 'scope'> = {};
  if (budget !== undefined) assembleExtra.budget = budget;
  if (freshTailCount !== undefined) assembleExtra.freshTailCount = freshTailCount;
  if (summarizeOlder !== undefined) assembleExtra.summarizeOlder = summarizeOlder;
  if (scope !== undefined) assembleExtra.scope = scope;
  const result = assemble(ctx, assembleMatch.id!, { ...assembleExtra, cost: assembleCost(assembleMatch.id!) });
  recordTokens(ctx, 'http_assemble', { items: result.items.length, tokens: result.tokens, sessionId: assembleMatch.id! });
  sendJson(res, 200, result);
  return;
}

// GET /v1/recall/drill/:id?limit=N&budget=N
// Companion to /v1/memories. When recall surfaces a level-2 summary in
// place of overflowed children (RecallResultItem.isSummary === true), the
// caller drills into the summary id to recover the originals. Tenant
// scoped via Bearer; default-deny on private scopes for both summary
// and children.
async function handleDrillRecall({ req, res, opts, query }: RouteRequest, drillMatch: Record<string, string>): Promise<void> {
  validateIdSegment(drillMatch.id!, 'summary id');
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
  // v0.30 / E5: depth query param walks N levels (default 1, hard cap 10).
  const depthRaw = query.get('depth');
  let depth: number | undefined;
  if (depthRaw !== null) {
    const parsed = Number(depthRaw);
    // L4 fold: reject out-of-range explicitly (no silent clamp).
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
      throw new HttpError(400, 'depth must be a positive integer between 1 and 10');
    }
    depth = parsed;
  }
  const ctx = await buildContextWithAuth(req, opts);
  const drillExtra: Pick<DrillDownOpts, 'limit' | 'budget' | 'depth'> = {};
  if (limit !== undefined) drillExtra.limit = limit;
  if (budget !== undefined) drillExtra.budget = budget;
  if (depth !== undefined) drillExtra.depth = depth;
  const result = drillDown(ctx, drillMatch.id!, { ...drillExtra, cost: drillCost });
  if ('failure' in result) {
    // v1.6.4: leaf id maps to 422 (caller-actionable). Other cases stay
    // as 404 to avoid leaking cross-tenant existence or scope grants.
    if (result.failure === 'not_drillable') {
      throw new HttpError(422, 'Id is a leaf row, not a level-2+ summary; nothing to drill into');
    }
    throw new HttpError(404, 'No drillable summary at this id');
  }
  sendJson(res, 200, result);
  return;
}

// /v1/memories/:id/* and DELETE /v1/memories/:id
async function handleArchiveMemory({ req, res, opts }: RouteRequest, archiveMatch: Record<string, string>): Promise<void> {
  validateIdSegment(archiveMatch.id!, 'memory id');
  const body = await parseJsonBody(req);
  const reason = getString(body, 'reason');
  if (!reason) {
    throw new HttpError(400, 'reason is required');
  }
  const ctx = await buildContextWithAuth(req, opts);
  const result = archiveRaw(ctx, archiveMatch.id!, reason);
  sendJson(res, 200, result);
  return;
}

async function handleSupersedeMemory({ req, res, opts }: RouteRequest, supersedeMatch: Record<string, string>): Promise<void> {
  validateIdSegment(supersedeMatch.id!, 'memory id');
  const body = await parseJsonBody(req);
  const content = getString(body, 'content');
  if (!content) {
    throw new HttpError(400, 'content is required');
  }
  const ctx = await buildContextWithAuth(req, opts);
  const result = supersede(ctx, supersedeMatch.id!, content);
  sendJson(res, 200, result);
  return;
}

async function handlePromoteMemory({ req, res, opts }: RouteRequest, promoteMatch: Record<string, string>): Promise<void> {
  validateIdSegment(promoteMatch.id!, 'memory id');
  const ctx = await buildContextWithAuth(req, opts);
  const result = promote(ctx, promoteMatch.id!);
  sendJson(res, 200, result);
  return;
}

async function handleForgetMemory({ req, res, opts }: RouteRequest, idMatch: Record<string, string>): Promise<void> {
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
async function handleApplyOutcome({ req, res, opts }: RouteRequest): Promise<void> {
  const body = await parseJsonBody(req);
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
  const ctx = await buildContextWithAuth(req, opts);
  if (ids !== undefined) {
    const { applied } = outcome(ctx, ids, good);
    sendJson(res, 200, { applied });
  } else {
    const result = outcomeForLastRecall(ctx, good);
    sendJson(res, 200, result);
  }
  return;
}

// GET /v1/context — assemble a budget-bounded context bundle. Returns
// ContextResult JSON (entries + tokens + activeSnapshot + sessionHandoff
// + recentEvents). No server-side rendering; clients render. Tenant-scoped
// via the Bearer. Pinned-only + '*' fallback skip the recall audit emit
// (matches cmdContext); real-query hybrid search emits one 'recall' row.
async function handleGetContext({ req, res, opts, query }: RouteRequest): Promise<void> {
  const q = query.get('q') ?? undefined;
  // v1.11.5: DoS cap on q-param length. 1024 covers real multi-clause queries
  // (pasted error messages, multi-stem searches) while bounding BM25
  // tokenisation cost (~150 tokens worst case at 1024 chars).
  if (q !== undefined && q.length > 1024) {
    throw new HttpError(400, 'q exceeds 1024-character cap');
  }
  const budgetRaw = query.get('budget');
  let budget: number | undefined;
  if (budgetRaw !== null) {
    budget = Number(budgetRaw);
    if (!Number.isFinite(budget) || budget < 0) {
      throw new HttpError(400, 'budget must be a non-negative number');
    }
  }
  const limitRaw = query.get('limit');
  let limit: number | undefined;
  if (limitRaw !== null) {
    limit = Number(limitRaw);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new HttpError(400, 'limit must be a positive number');
    }
  }
  const pinnedOnlyRaw = query.get('pinned_only');
  const pinnedOnly = pinnedOnlyRaw === '1' || pinnedOnlyRaw === 'true';
  const scopeRaw = query.get('scope');
  if (scopeRaw !== null && scopeRaw.length > 256) {
    throw new HttpError(400, 'scope exceeds 256-character cap');
  }
  const scope = scopeRaw === null ? undefined : scopeRaw;
  const includeRecentRaw = query.get('include_recent');
  let includeRecent: number | undefined;
  if (includeRecentRaw !== null) {
    includeRecent = Number(includeRecentRaw);
    if (!Number.isFinite(includeRecent) || includeRecent < 0) {
      throw new HttpError(400, 'include_recent must be a non-negative number');
    }
  }
  // v39 memory scope isolation: cross_project=1|true re-includes
  // other-project rows (tagged category 'cross-project' in the response).
  // The partition identity comes from the SERVED STORE's location, not the
  // daemon's process cwd - a daemon started from anywhere still isolates
  // the project it serves.
  const crossProjectRaw = query.get('cross_project');
  const crossProject = crossProjectRaw === '1' || crossProjectRaw === 'true';
  const ctx = await buildContextWithAuth(req, opts);
  const result = await getContext(ctx, {
    q,
    budget,
    limit,
    pinnedOnly,
    scope,
    includeRecent,
    crossProject,
    currentProject: resolveProjectIdentity(dirname(resolve(opts.hippoRoot))).name,
    cost: contextCost('markdown', 'observe'), // clients render; the budget prices the block `hippo context` would print
  });
  recordTokens(ctx, 'http_context', { items: result.entries.length, tokens: result.tokens });
  sendJson(res, 200, result);
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
async function handleSleep({ req, res, opts }: RouteRequest): Promise<void> {
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
  const body = await parseJsonBody(req);
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

// POST /v1/auth/keys — mint a new API key. Plaintext lands in the response
// body (Task 8): the HTTP layer hands it to the client; the user-facing
// "store this somewhere safe" warning belongs in the CLI client, not here.
async function handleCreateAuthKey({ req, res, opts }: RouteRequest): Promise<void> {
  const body = await parseJsonBody(req);
  const labelRaw = body['label'];
  if (labelRaw !== undefined && !isJsonString(labelRaw)) {
    throw new HttpError(400, 'label must be a string');
  }
  // v1.12.3: optional body.role mirrors the --role CLI flag. Validated
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
  const ctx = await buildContextWithAuth(req, opts);
  const result = authCreate(ctx, {
    label: labelRaw,
    role,
  });
  sendJson(res, 200, result);
  return;
}

// GET /v1/auth/keys?active=true — list keys visible to ctx.tenantId.
// `active` defaults to true so the common case (show me usable keys) is
// a single GET; ?active=false includes revoked rows.
async function handleListAuthKeys({ req, res, opts, query }: RouteRequest): Promise<void> {
  const activeRaw = query.get('active');
  let active = true;
  if (activeRaw !== null) {
    if (activeRaw === 'true') active = true;
    else if (activeRaw === 'false') active = false;
    else throw new HttpError(400, "active must be 'true' or 'false'");
  }
  const ctx = await buildContextWithAuth(req, opts);
  const result = authList(ctx, { active });
  sendJson(res, 200, result);
  return;
}

// DELETE /v1/auth/keys/:keyId — revoke. Missing or cross-tenant keys are 404
// (no info leak); a member key targeting any key but its own is 403.
// 200 with the body rather than 204 so the caller sees revokedAt.
async function handleRevokeAuthKey({ req, res, opts }: RouteRequest, keyMatch: Record<string, string>): Promise<void> {
  validateIdSegment(keyMatch.keyId!, 'key id');
  const ctx = await buildContextWithAuth(req, opts);
  const result = authRevoke(ctx, keyMatch.keyId!);
  sendJson(res, 200, result);
  return;
}

// GET /v1/quarantine?status=: CD5 review queue. quarantineList carries no role gate itself, so it's checked here.
async function handleListQuarantine({ req, res, opts, query }: RouteRequest): Promise<void> {
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
  sendJson(res, 200, { quarantine: quarantineList(ctx, { status }) });
  return;
}

// POST /v1/quarantine/:id/approve: admin only; ForbiddenError falls through to mapApiError's 403.
async function handleApproveQuarantine({ req, res, opts }: RouteRequest, quarantineApproveMatch: Record<string, string>): Promise<void> {
  validateIdSegment(quarantineApproveMatch.id!, 'memory id');
  const ctx = await buildContextWithAuth(req, opts);
  try {
    quarantineApprove(ctx, quarantineApproveMatch.id!);
    sendJson(res, 200, { approved: quarantineApproveMatch.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not quarantined')) throw new HttpError(404, msg);
    if (msg.includes('is already') || msg.includes('scope changed')) throw new HttpError(409, msg);
    throw e;
  }
  return;
}

// POST /v1/quarantine/:id/reject: admin only; ForbiddenError falls through to mapApiError's 403.
async function handleRejectQuarantine({ req, res, opts }: RouteRequest, quarantineRejectMatch: Record<string, string>): Promise<void> {
  validateIdSegment(quarantineRejectMatch.id!, 'memory id');
  const ctx = await buildContextWithAuth(req, opts);
  try {
    quarantineReject(ctx, quarantineRejectMatch.id!);
    sendJson(res, 200, { rejected: quarantineRejectMatch.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not quarantined')) throw new HttpError(404, msg);
    if (msg.includes('is already')) throw new HttpError(409, msg);
    throw e;
  }
  return;
}

// GET /v1/audit?op=&since=&limit= — read audit events. All three filters
// validated at the route boundary so an invalid value lands a 400 before
// we hit the DB.
async function handleListAudit({ req, res, opts, query }: RouteRequest): Promise<void> {
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
  let limit: number | undefined;
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > MAX_AUDIT_LIMIT) {
      throw new HttpError(400, `limit must be an integer between 1 and ${MAX_AUDIT_LIMIT}`);
    }
    limit = parsed;
  }
  const ctx = await buildContextWithAuth(req, opts);
  // ?tenant=<t> reads another tenant (e.g. '__host__' for consolidate rows); admin only.
  const tenantOverride = query.get('tenant');
  const crossTenant = tenantOverride !== null && tenantOverride !== '' && tenantOverride !== ctx.tenantId;
  if (crossTenant) assertCrossTenantAdmin(ctx, '/v1/audit?tenant= for another tenant');
  const effectiveCtx = crossTenant ? { ...ctx, tenantId: tenantOverride } : ctx;
  const result = auditList(effectiveCtx, { op, since, limit });
  sendJson(res, 200, result);
  return;
}

// ── E2 prediction first-class object (v0.31) ──
// docs/plans/2026-05-26-e2-prediction-object.md
//
// 4 routes: POST /v1/predictions (create), GET /v1/predictions (list),
// GET /v1/predictions/:id (show), POST /v1/predictions/:id/close (close).
// All Bearer-authed + tenant-scoped via buildContextWithAuth. closure_state
// validated against VALID_CLOSURE_STATES (3 states). DoS caps on claim
// (4096 chars) + closureNote (2048 chars) per v1.11.4 pattern.
async function handleCreatePrediction({ req, res, opts }: RouteRequest): Promise<void> {
  const body = await parseJsonBody(req);
  const claim = body['claim'];
  if (!isJsonString(claim) || claim.length === 0) {
    throw new HttpError(400, 'claim is required (non-empty string)');
  }
  if (claim.length > 4096) {
    throw new HttpError(400, 'claim exceeds 4096-character cap');
  }
  const classTag = body['classTag'];
  if (!isJsonString(classTag) || classTag.length === 0) {
    throw new HttpError(400, 'classTag is required (non-empty string)');
  }
  const estimate = body['estimate'];
  let estimateValue: number | undefined;
  if (estimate !== undefined && estimate !== null) {
    if (!isJsonNumber(estimate) || !Number.isFinite(estimate)) {
      throw new HttpError(400, 'estimate must be a finite number');
    }
    estimateValue = estimate;
  }
  const unit = body['unit'];
  let estimateUnit: string | undefined;
  if (unit !== undefined && unit !== null) {
    if (!isJsonString(unit)) {
      throw new HttpError(400, 'unit must be a string');
    }
    estimateUnit = unit;
  }
  const targetDate = body['targetDate'];
  let targetDateValue: string | undefined;
  if (targetDate !== undefined && targetDate !== null) {
    if (!isJsonString(targetDate)) {
      throw new HttpError(400, 'targetDate must be an ISO date string');
    }
    targetDateValue = targetDate;
  }
  const ctx = await buildContextWithAuth(req, opts);
  const prediction = savePrediction(opts.hippoRoot, ctx.tenantId, {
    classTag,
    claimText: claim,
    estimateValue,
    estimateUnit,
    targetDate: targetDateValue,
  }, ctx.actor.subject);
  sendJson(res, 201, { prediction });
  return;
}

async function handleListPredictions({ req, res, opts, query }: RouteRequest): Promise<void> {
  const classTag = query.get('class') ?? undefined;
  const status = query.get('status') ?? 'all';
  const limit = parseListLimit(query.get('limit'));
  const ctx = await buildContextWithAuth(req, opts);
  let predictions;
  if (status === 'all') {
    if (classTag) {
      predictions = loadPredictionsByClass(opts.hippoRoot, ctx.tenantId, classTag, { limit });
    } else {
      predictions = loadOpenPredictions(opts.hippoRoot, ctx.tenantId, { limit });
    }
  } else if (status === 'open') {
    predictions = loadOpenPredictions(opts.hippoRoot, ctx.tenantId, {
      classTag: classTag || undefined,
      limit,
    });
  } else {
    if (!isSetMember(VALID_CLOSURE_STATES, status)) {
      throw new HttpError(400, `status must be one of: open | closed | closed-unknown | all (got "${status}")`);
    }
    if (!classTag) {
      throw new HttpError(400, 'status filter (non-open) requires class param');
    }
    predictions = loadPredictionsByClass(opts.hippoRoot, ctx.tenantId, classTag, {
      closureState: status,
      limit,
    });
  }
  sendJson(res, 200, { predictions });
  return;
}

// J3 reference-class / planning-fallacy detector (v0.31).
// Order matters: this must match BEFORE /v1/predictions/:id since 'stats'
// is not a number — the :id regex requires \d+ so they don't conflict,
// but routing this first avoids the dispatch order risk.
async function handlePredictionStats({ req, res, opts, query }: RouteRequest): Promise<void> {
  const classTag = query.get('class');
  if (!classTag || classTag.length === 0) {
    throw new HttpError(400, 'class param is required');
  }
  if (classTag.length > 256) {
    throw new HttpError(400, 'class exceeds 256-character cap');
  }
  const ctx = await buildContextWithAuth(req, opts);
  const baserate = computePredictionBaserate(opts.hippoRoot, ctx.tenantId, classTag, ctx.actor.subject);
  sendJson(res, 200, { baserate });
  return;
}

async function handleGetPrediction({ req, res, opts }: RouteRequest, predictionByIdMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(predictionByIdMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const prediction = loadPredictionById(opts.hippoRoot, ctx.tenantId, id);
  if (!prediction) {
    throw new HttpError(404, `prediction ${id} not found`);
  }
  sendJson(res, 200, { prediction });
  return;
}

async function handleClosePrediction({ req, res, opts }: RouteRequest, predictionCloseMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(predictionCloseMatch[1], 10);
  const body = await parseJsonBody(req);
  const state = body['state'];
  if (!isJsonString(state) || !isSetMember(VALID_CLOSURE_STATES, state) || state === 'open') {
    throw new HttpError(400, 'state is required and must be one of: closed | closed-unknown');
  }
  const actual = body['actual'];
  let actualValue: number | undefined;
  if (actual !== undefined && actual !== null) {
    if (!isJsonNumber(actual) || !Number.isFinite(actual)) {
      throw new HttpError(400, 'actual must be a finite number');
    }
    actualValue = actual;
  }
  const note = body['note'];
  let closureNote: string | undefined;
  if (note !== undefined && note !== null) {
    if (!isJsonString(note)) {
      throw new HttpError(400, 'note must be a string');
    }
    if (note.length > 2048) {
      throw new HttpError(400, 'note exceeds 2048-character cap');
    }
    closureNote = note;
  }
  const ctx = await buildContextWithAuth(req, opts);
  try {
    const prediction = closePrediction(opts.hippoRoot, ctx.tenantId, id, {
      closureState: state,
      actualValue,
      closureNote,
    }, ctx.actor.subject);
    sendJson(res, 200, { prediction });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      throw new HttpError(404, msg);
    }
    throw e;
  }
  return;
}

// ── decisions (E2 first-class object) ──
//
// 5 routes: POST /v1/decisions (create, optional supersedesDecisionId),
// GET /v1/decisions (list, status filter), GET /v1/decisions/:id (show),
// POST /v1/decisions/:id/supersede (create a successor + supersede :id),
// POST /v1/decisions/:id/close (retire). Bearer-authed + tenant-scoped via
// buildContextWithAuth. status validated against VALID_DECISION_STATES.
// DoS caps: text 4096, context 4096 (v1.11.4 pattern). The HTTP surface is
// new (no legacy --supersedes <memory-id> constraint), so it supersedes by
// table id and never weakens a memory mirror.
async function handleCreateDecision({ req, res, opts }: RouteRequest): Promise<void> {
  const body = await parseJsonBody(req);
  const text = body['text'];
  if (!isJsonString(text) || text.length === 0) {
    throw new HttpError(400, 'text is required (non-empty string)');
  }
  if (text.length > 4096) {
    throw new HttpError(400, 'text exceeds 4096-character cap');
  }
  const contextRaw = body['context'];
  let context: string | undefined;
  if (contextRaw !== undefined && contextRaw !== null) {
    if (!isJsonString(contextRaw)) {
      throw new HttpError(400, 'context must be a string');
    }
    if (contextRaw.length > 4096) {
      throw new HttpError(400, 'context exceeds 4096-character cap');
    }
    context = contextRaw;
  }
  const supRaw = body['supersedesDecisionId'];
  let supersedesDecisionId: number | undefined;
  if (supRaw !== undefined && supRaw !== null) {
    if (!isJsonNumber(supRaw) || !Number.isInteger(supRaw) || supRaw <= 0) {
      throw new HttpError(400, 'supersedesDecisionId must be a positive integer');
    }
    supersedesDecisionId = supRaw;
  }
  const ctx = await buildContextWithAuth(req, opts);
  try {
    const decision = saveDecision(opts.hippoRoot, ctx.tenantId, {
      decisionText: text,
      context,
      supersedesDecisionId,
    }, ctx.actor.subject);
    sendJson(res, 201, { decision });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found') || msg.includes('not active')) {
      throw new HttpError(409, msg);
    }
    throw e;
  }
  return;
}

async function handleListDecisions({ req, res, opts, query }: RouteRequest): Promise<void> {
  const status = query.get('status') ?? 'all';
  const limit = parseListLimit(query.get('limit'));
  const ctx = await buildContextWithAuth(req, opts);
  let decisions;
  if (status === 'all') {
    decisions = loadDecisions(opts.hippoRoot, ctx.tenantId, { limit });
  } else {
    if (!isSetMember(VALID_DECISION_STATES, status)) {
      throw new HttpError(400, `status must be one of: active | superseded | closed | all (got "${status}")`);
    }
    decisions = loadDecisions(opts.hippoRoot, ctx.tenantId, {
      status,
      limit,
    });
  }
  sendJson(res, 200, { decisions });
  return;
}

async function handleSupersedeDecision({ req, res, opts }: RouteRequest, decisionSupersedeMatch: RegExpMatchArray): Promise<void> {
  const oldId = parseInt(decisionSupersedeMatch[1], 10);
  const body = await parseJsonBody(req);
  const text = body['text'];
  if (!isJsonString(text) || text.length === 0) {
    throw new HttpError(400, 'text is required (non-empty string)');
  }
  if (text.length > 4096) {
    throw new HttpError(400, 'text exceeds 4096-character cap');
  }
  const contextRaw = body['context'];
  let context: string | undefined;
  if (contextRaw !== undefined && contextRaw !== null) {
    if (!isJsonString(contextRaw)) {
      throw new HttpError(400, 'context must be a string');
    }
    if (contextRaw.length > 4096) {
      throw new HttpError(400, 'context exceeds 4096-character cap');
    }
    context = contextRaw;
  }
  const ctx = await buildContextWithAuth(req, opts);
  try {
    const decision = saveDecision(opts.hippoRoot, ctx.tenantId, {
      decisionText: text,
      context,
      supersedesDecisionId: oldId,
    }, ctx.actor.subject);
    sendJson(res, 201, { decision });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      throw new HttpError(404, msg);
    }
    if (msg.includes('not active')) {
      throw new HttpError(409, msg);
    }
    throw e;
  }
  return;
}

async function handleCloseDecision({ req, res, opts }: RouteRequest, decisionCloseMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(decisionCloseMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  try {
    const decision = closeDecision(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
    sendJson(res, 200, { decision });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      throw new HttpError(404, msg);
    }
    if (msg.includes('not active')) {
      throw new HttpError(409, msg);
    }
    throw e;
  }
  return;
}

async function handleGetDecision({ req, res, opts }: RouteRequest, decisionByIdMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(decisionByIdMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const decision = loadDecisionById(opts.hippoRoot, ctx.tenantId, id);
  if (!decision) {
    throw new HttpError(404, `decision ${id} not found`);
  }
  sendJson(res, 200, { decision });
  return;
}

// ── incidents (E2 first-class object) ──
//
// 5 routes: POST /v1/incidents (open; body text + context + linkedMemoryIds[]),
// GET /v1/incidents (list, status filter), GET /v1/incidents/:id (show),
// POST /v1/incidents/:id/resolve (open -> resolved; body resolutionText),
// POST /v1/incidents/:id/close (open|resolved -> closed). Bearer-authed +
// tenant-scoped via buildContextWithAuth. status validated against
// VALID_INCIDENT_STATES. DoS caps: text 4096, context 4096, resolutionText
// 4096 (v1.11.4 pattern). Mirrors /v1/decisions; lifecycle is
// open->resolved->closed (no supersede), so linkedMemoryIds replaces
// supersedesDecisionId on create.
async function handleCreateIncident({ req, res, opts }: RouteRequest): Promise<void> {
  const body = await parseJsonBody(req);
  const text = body['text'];
  if (!isJsonString(text) || text.length === 0) {
    throw new HttpError(400, 'text is required (non-empty string)');
  }
  if (text.length > 4096) {
    throw new HttpError(400, 'text exceeds 4096-character cap');
  }
  const contextRaw = body['context'];
  let context: string | undefined;
  if (contextRaw !== undefined && contextRaw !== null) {
    if (!isJsonString(contextRaw)) {
      throw new HttpError(400, 'context must be a string');
    }
    if (contextRaw.length > 4096) {
      throw new HttpError(400, 'context exceeds 4096-character cap');
    }
    context = contextRaw;
  }
  const linkedRaw = body['linkedMemoryIds'];
  let linkedMemoryIds: string[] | undefined;
  if (linkedRaw !== undefined && linkedRaw !== null) {
    if (!Array.isArray(linkedRaw)) {
      throw new HttpError(400, 'linkedMemoryIds must be an array of memory ids');
    }
    if (linkedRaw.length > 256) {
      throw new HttpError(400, 'linkedMemoryIds exceeds 256-item cap');
    }
    const isValidMemoryId = (item: JsonValue): item is string =>
      isJsonString(item) && item.length > 0 && item.length <= 4096;
    if (!linkedRaw.every(isValidMemoryId)) {
      throw new HttpError(400, 'each linkedMemoryIds entry must be a non-empty string <= 4096 chars');
    }
    linkedMemoryIds = linkedRaw;
  }
  const ctx = await buildContextWithAuth(req, opts);
  try {
    const incident = saveIncident(opts.hippoRoot, ctx.tenantId, {
      incidentText: text,
      context,
      linkedMemoryIds,
    }, ctx.actor.subject);
    sendJson(res, 201, { incident });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      throw new HttpError(409, msg);
    }
    throw e;
  }
  return;
}

async function handleListIncidents({ req, res, opts, query }: RouteRequest): Promise<void> {
  const status = query.get('status') ?? 'all';
  const limit = parseListLimit(query.get('limit'));
  const ctx = await buildContextWithAuth(req, opts);
  let incidents;
  if (status === 'all') {
    incidents = loadIncidents(opts.hippoRoot, ctx.tenantId, { limit });
  } else {
    if (!isSetMember(VALID_INCIDENT_STATES, status)) {
      throw new HttpError(400, `status must be one of: open | resolved | closed | all (got "${status}")`);
    }
    incidents = loadIncidents(opts.hippoRoot, ctx.tenantId, {
      status,
      limit,
    });
  }
  sendJson(res, 200, { incidents });
  return;
}

async function handleResolveIncident({ req, res, opts }: RouteRequest, incidentResolveMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(incidentResolveMatch[1], 10);
  const body = await parseJsonBody(req);
  const resolutionText = body['resolutionText'];
  if (!isJsonString(resolutionText) || resolutionText.trim().length === 0) {
    throw new HttpError(400, 'resolutionText is required (non-empty string)');
  }
  if (resolutionText.length > 4096) {
    throw new HttpError(400, 'resolutionText exceeds 4096-character cap');
  }
  const ctx = await buildContextWithAuth(req, opts);
  try {
    const incident = resolveIncident(opts.hippoRoot, ctx.tenantId, id, resolutionText, ctx.actor.subject);
    sendJson(res, 200, { incident });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      throw new HttpError(404, msg);
    }
    if (msg.includes('not open')) {
      throw new HttpError(409, msg);
    }
    throw e;
  }
  return;
}

async function handleCloseIncident({ req, res, opts }: RouteRequest, incidentCloseMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(incidentCloseMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  try {
    const incident = closeIncident(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
    sendJson(res, 200, { incident });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      throw new HttpError(404, msg);
    }
    if (msg.includes('already closed')) {
      throw new HttpError(409, msg);
    }
    throw e;
  }
  return;
}

async function handleGetIncident({ req, res, opts }: RouteRequest, incidentByIdMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(incidentByIdMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const incident = loadIncidentById(opts.hippoRoot, ctx.tenantId, id);
  if (!incident) {
    throw new HttpError(404, `incident ${id} not found`);
  }
  sendJson(res, 200, { incident });
  return;
}

// ── processes (E2 first-class object) ──
//
// 5 routes: POST /v1/processes (new; body processName + steps[] + description),
// GET /v1/processes (list, status filter), GET /v1/processes/:id (show),
// POST /v1/processes/:id/supersede (active -> superseded by a new version; body
// steps[] + changeSummary + description; reuses the predecessor's name),
// POST /v1/processes/:id/close (active -> closed). Bearer-authed + tenant-scoped
// via buildContextWithAuth. status validated against VALID_PROCESS_STATES. DoS
// caps: processName/description/changeSummary 4096, steps 200x2000
// (validateProcessStepsBody). Mirrors /v1/decisions; the delta lifecycle is the
// decision supersede path.
async function handleCreateProcess({ req, res, opts }: RouteRequest): Promise<void> {
  const body = await parseJsonBody(req);
  const processName = body['processName'];
  if (!isJsonString(processName) || processName.trim().length === 0) {
    throw new HttpError(400, 'processName is required (non-empty string)');
  }
  if (processName.length > 4096) {
    throw new HttpError(400, 'processName exceeds 4096-character cap');
  }
  const steps = validateProcessStepsBody(body['steps']);
  const descriptionRaw = body['description'];
  let description: string | undefined;
  if (descriptionRaw !== undefined && descriptionRaw !== null) {
    if (!isJsonString(descriptionRaw)) {
      throw new HttpError(400, 'description must be a string');
    }
    if (descriptionRaw.length > 4096) {
      throw new HttpError(400, 'description exceeds 4096-character cap');
    }
    description = descriptionRaw;
  }
  const ctx = await buildContextWithAuth(req, opts);
  const process = saveProcess(opts.hippoRoot, ctx.tenantId, {
    processName,
    steps,
    description,
  }, ctx.actor.subject);
  sendJson(res, 201, { process });
  return;
}

async function handleListProcesses({ req, res, opts, query }: RouteRequest): Promise<void> {
  const status = query.get('status') ?? 'all';
  const limit = parseListLimit(query.get('limit'));
  const ctx = await buildContextWithAuth(req, opts);
  let processes;
  if (status === 'all') {
    processes = loadProcesses(opts.hippoRoot, ctx.tenantId, { limit });
  } else {
    if (!isSetMember(VALID_PROCESS_STATES, status)) {
      throw new HttpError(400, `status must be one of: active | superseded | closed | all (got "${status}")`);
    }
    processes = loadProcesses(opts.hippoRoot, ctx.tenantId, {
      status,
      limit,
    });
  }
  sendJson(res, 200, { processes });
  return;
}

async function handleSupersedeProcess({ req, res, opts }: RouteRequest, processSupersedeMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(processSupersedeMatch[1], 10);
  const body = await parseJsonBody(req);
  const steps = validateProcessStepsBody(body['steps']);
  if (steps.length === 0) {
    throw new HttpError(400, 'steps is required (at least one step) for a supersession');
  }
  const changeRaw = body['changeSummary'];
  let changeSummary: string | undefined;
  if (changeRaw !== undefined && changeRaw !== null) {
    if (!isJsonString(changeRaw)) {
      throw new HttpError(400, 'changeSummary must be a string');
    }
    if (changeRaw.length > 4096) {
      throw new HttpError(400, 'changeSummary exceeds 4096-character cap');
    }
    changeSummary = changeRaw;
  }
  const descRaw = body['description'];
  let description: string | undefined;
  if (descRaw !== undefined && descRaw !== null) {
    if (!isJsonString(descRaw)) {
      throw new HttpError(400, 'description must be a string');
    }
    if (descRaw.length > 4096) {
      throw new HttpError(400, 'description exceeds 4096-character cap');
    }
    description = descRaw;
  }
  const ctx = await buildContextWithAuth(req, opts);
  // A supersession is a new version of the SAME process: reuse the
  // predecessor's name. 404 if the target does not exist; saveProcess's
  // in-SAVEPOINT preflight is the authoritative active-state check (409).
  const existing = loadProcessById(opts.hippoRoot, ctx.tenantId, id);
  if (!existing) {
    throw new HttpError(404, `process ${id} not found`);
  }
  try {
    const process = saveProcess(opts.hippoRoot, ctx.tenantId, {
      processName: existing.processName,
      steps,
      description,
      changeSummary,
      supersedesProcessId: id,
    }, ctx.actor.subject);
    sendJson(res, 200, { process });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      throw new HttpError(404, msg);
    }
    if (msg.includes('not active') || msg.includes('could not be superseded')) {
      throw new HttpError(409, msg);
    }
    throw e;
  }
  return;
}

async function handleCloseProcess({ req, res, opts }: RouteRequest, processCloseMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(processCloseMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  try {
    const process = closeProcess(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
    sendJson(res, 200, { process });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      throw new HttpError(404, msg);
    }
    if (msg.includes('not active')) {
      throw new HttpError(409, msg);
    }
    throw e;
  }
  return;
}

async function handleGetProcess({ req, res, opts }: RouteRequest, processByIdMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(processByIdMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const process = loadProcessById(opts.hippoRoot, ctx.tenantId, id);
  if (!process) {
    throw new HttpError(404, `process ${id} not found`);
  }
  sendJson(res, 200, { process });
  return;
}

// ── policies (E2 first-class object, bi-temporal-first) ──
//
// 6 routes: POST /v1/policies (new; processName-style body policyName +
// policyText + validFrom? + validTo?), GET /v1/policies (list, status filter),
// GET /v1/policies/asof (date + optional name; the bi-temporal as-of query;
// placed BEFORE the /:id GET so the literal 'asof' is matched first), GET
// /v1/policies/:id, POST /v1/policies/:id/supersede, POST /v1/policies/:id/close.
// Date inputs are normalized + range-validated in the store; an invalid/inverted
// date throws -> 400. DoS caps: policyName/policyText/changeSummary 4096.
async function handleCreatePolicy({ req, res, opts }: RouteRequest): Promise<void> {
  const body = await parseJsonBody(req);
  const policyName = body['policyName'];
  if (!isJsonString(policyName) || policyName.trim().length === 0) {
    throw new HttpError(400, 'policyName is required (non-empty string)');
  }
  if (policyName.length > 4096) {
    throw new HttpError(400, 'policyName exceeds 4096-character cap');
  }
  const policyText = body['policyText'];
  if (!isJsonString(policyText) || policyText.trim().length === 0) {
    throw new HttpError(400, 'policyText is required (non-empty string)');
  }
  if (policyText.length > 4096) {
    throw new HttpError(400, 'policyText exceeds 4096-character cap');
  }
  const validFrom = optionalDateField(body['validFrom'], 'validFrom');
  const validTo = optionalDateField(body['validTo'], 'validTo');
  const ctx = await buildContextWithAuth(req, opts);
  try {
    const policy = savePolicy(opts.hippoRoot, ctx.tenantId, {
      policyName,
      policyText,
      validFrom,
      validTo,
    }, ctx.actor.subject);
    sendJson(res, 201, { policy });
  } catch (e) {
    // savePolicy throws on invalid/inverted dates (validation) -> 400.
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  return;
}

async function handleListPolicies({ req, res, opts, query }: RouteRequest): Promise<void> {
  const status = query.get('status') ?? 'all';
  const limit = parseListLimit(query.get('limit'));
  const ctx = await buildContextWithAuth(req, opts);
  let policies;
  if (status === 'all') {
    policies = loadPolicies(opts.hippoRoot, ctx.tenantId, { limit });
  } else {
    if (!isSetMember(VALID_POLICY_STATES, status)) {
      throw new HttpError(400, `status must be one of: active | superseded | closed | all (got "${status}")`);
    }
    policies = loadPolicies(opts.hippoRoot, ctx.tenantId, {
      status,
      limit,
    });
  }
  sendJson(res, 200, { policies });
  return;
}

// The as-of query: must precede the /:id GET (literal 'asof' is non-numeric so
// the /(\d+)/ route would not match it, but order it first for clarity).
async function handlePoliciesAsOf({ req, res, opts, query }: RouteRequest): Promise<void> {
  const date = query.get('date');
  if (date === null || date.length === 0) {
    throw new HttpError(400, 'date is required (ISO-8601 valid-time)');
  }
  const name = query.get('name') ?? undefined;
  const ctx = await buildContextWithAuth(req, opts);
  try {
    const policies = loadPoliciesAsOf(opts.hippoRoot, ctx.tenantId, date, { name });
    sendJson(res, 200, { policies });
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  return;
}

async function handleSupersedePolicy({ req, res, opts }: RouteRequest, policySupersedeMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(policySupersedeMatch[1], 10);
  const body = await parseJsonBody(req);
  const policyText = body['policyText'];
  if (!isJsonString(policyText) || policyText.trim().length === 0) {
    throw new HttpError(400, 'policyText is required (non-empty string)');
  }
  if (policyText.length > 4096) {
    throw new HttpError(400, 'policyText exceeds 4096-character cap');
  }
  const validFrom = optionalDateField(body['validFrom'], 'validFrom');
  const validTo = optionalDateField(body['validTo'], 'validTo');
  const changeRaw = body['changeSummary'];
  let changeSummary: string | undefined;
  if (changeRaw !== undefined && changeRaw !== null) {
    if (!isJsonString(changeRaw)) {
      throw new HttpError(400, 'changeSummary must be a string');
    }
    if (changeRaw.length > 4096) {
      throw new HttpError(400, 'changeSummary exceeds 4096-character cap');
    }
    changeSummary = changeRaw;
  }
  const ctx = await buildContextWithAuth(req, opts);
  const existing = loadPolicyById(opts.hippoRoot, ctx.tenantId, id);
  if (!existing) {
    throw new HttpError(404, `policy ${id} not found`);
  }
  try {
    const policy = savePolicy(opts.hippoRoot, ctx.tenantId, {
      policyName: existing.policyName,
      policyText,
      validFrom,
      validTo,
      changeSummary,
      supersedesPolicyId: id,
    }, ctx.actor.subject);
    sendJson(res, 200, { policy });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      throw new HttpError(404, msg);
    }
    if (msg.includes('not active') || msg.includes('could not be superseded')) {
      throw new HttpError(409, msg);
    }
    // invalid/inverted date or missing field -> validation.
    throw new HttpError(400, msg);
  }
  return;
}

async function handleClosePolicy({ req, res, opts }: RouteRequest, policyCloseMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(policyCloseMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  try {
    const policy = closePolicy(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
    sendJson(res, 200, { policy });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      throw new HttpError(404, msg);
    }
    if (msg.includes('not active')) {
      throw new HttpError(409, msg);
    }
    throw e;
  }
  return;
}

async function handleGetPolicy({ req, res, opts }: RouteRequest, policyByIdMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(policyByIdMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const policy = loadPolicyById(opts.hippoRoot, ctx.tenantId, id);
  if (!policy) {
    throw new HttpError(404, `policy ${id} not found`);
  }
  sendJson(res, 200, { policy });
  return;
}

// ── skills (E2 first-class object, executable/exportable) ──
//
// 6 routes: POST /v1/skills (new; body skillName + instructions + trigger?),
// GET /v1/skills (list, status filter; shared parseListLimit), GET
// /v1/skills/export (renders ACTIVE skills as an AGENTS.md/CLAUDE.md markdown
// block -> {markdown}; literal 'export' is non-numeric so the /:id (\d+) route
// cannot capture it, but it is ordered first regardless), GET /v1/skills/:id,
// POST /v1/skills/:id/supersede, POST /v1/skills/:id/close. DoS caps:
// skillName 256, instructions 8192, trigger 1024, changeSummary 4096. The store
// validates + throws; the boundary maps validation -> 400, not-found -> 404,
// not-active -> 409. Mirrors /v1/processes; "executable" = exportable
// instruction (no code exec).
async function handleCreateSkill({ req, res, opts }: RouteRequest): Promise<void> {
  const body = await parseJsonBody(req);
  const skillName = body['skillName'];
  if (!isJsonString(skillName) || skillName.trim().length === 0) {
    throw new HttpError(400, 'skillName is required (non-empty string)');
  }
  if (skillName.length > 256) {
    throw new HttpError(400, 'skillName exceeds 256-character cap');
  }
  const instructions = body['instructions'];
  if (!isJsonString(instructions) || instructions.trim().length === 0) {
    throw new HttpError(400, 'instructions are required (non-empty string)');
  }
  if (instructions.length > 8192) {
    throw new HttpError(400, 'instructions exceed 8192-character cap');
  }
  const triggerRaw = body['trigger'];
  let trigger: string | undefined;
  if (triggerRaw !== undefined && triggerRaw !== null) {
    if (!isJsonString(triggerRaw)) {
      throw new HttpError(400, 'trigger must be a string');
    }
    if (triggerRaw.length > 1024) {
      throw new HttpError(400, 'trigger exceeds 1024-character cap');
    }
    trigger = triggerRaw;
  }
  const ctx = await buildContextWithAuth(req, opts);
  try {
    const skill = saveSkill(opts.hippoRoot, ctx.tenantId, {
      skillName,
      instructions,
      trigger,
    }, ctx.actor.subject);
    sendJson(res, 201, { skill });
  } catch (e) {
    // saveSkill throws on validation (single-line name etc.) -> 400.
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  return;
}

async function handleListSkills({ req, res, opts, query }: RouteRequest): Promise<void> {
  const status = query.get('status') ?? 'all';
  const limit = parseListLimit(query.get('limit'));
  const ctx = await buildContextWithAuth(req, opts);
  let skills;
  if (status === 'all') {
    skills = loadSkills(opts.hippoRoot, ctx.tenantId, { limit });
  } else {
    if (!isSetMember(VALID_SKILL_STATES, status)) {
      throw new HttpError(400, `status must be one of: active | superseded | closed | all (got "${status}")`);
    }
    skills = loadSkills(opts.hippoRoot, ctx.tenantId, {
      status,
      limit,
    });
  }
  sendJson(res, 200, { skills });
  return;
}

// The export renderer: must precede the /:id GET (literal 'export' is
// non-numeric so the /(\d+)/ route would not match it, but order it first).
async function handleExportSkills({ req, res, opts }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
  const markdown = exportSkills(opts.hippoRoot, ctx.tenantId);
  sendJson(res, 200, { markdown });
  return;
}

async function handleSupersedeSkill({ req, res, opts }: RouteRequest, skillSupersedeMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(skillSupersedeMatch[1], 10);
  const body = await parseJsonBody(req);
  const instructions = body['instructions'];
  if (!isJsonString(instructions) || instructions.trim().length === 0) {
    throw new HttpError(400, 'instructions are required (non-empty string)');
  }
  if (instructions.length > 8192) {
    throw new HttpError(400, 'instructions exceed 8192-character cap');
  }
  const triggerRaw = body['trigger'];
  let trigger: string | undefined;
  if (triggerRaw !== undefined && triggerRaw !== null) {
    if (!isJsonString(triggerRaw)) {
      throw new HttpError(400, 'trigger must be a string');
    }
    if (triggerRaw.length > 1024) {
      throw new HttpError(400, 'trigger exceeds 1024-character cap');
    }
    trigger = triggerRaw;
  }
  const changeRaw = body['changeSummary'];
  let changeSummary: string | undefined;
  if (changeRaw !== undefined && changeRaw !== null) {
    if (!isJsonString(changeRaw)) {
      throw new HttpError(400, 'changeSummary must be a string');
    }
    if (changeRaw.length > 4096) {
      throw new HttpError(400, 'changeSummary exceeds 4096-character cap');
    }
    changeSummary = changeRaw;
  }
  const ctx = await buildContextWithAuth(req, opts);
  const existing = loadSkillById(opts.hippoRoot, ctx.tenantId, id);
  if (!existing) {
    throw new HttpError(404, `skill ${id} not found`);
  }
  try {
    const skill = saveSkill(opts.hippoRoot, ctx.tenantId, {
      skillName: existing.skillName,
      instructions,
      trigger,
      changeSummary,
      supersedesSkillId: id,
    }, ctx.actor.subject);
    sendJson(res, 200, { skill });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      throw new HttpError(404, msg);
    }
    if (msg.includes('not active') || msg.includes('could not be superseded')) {
      throw new HttpError(409, msg);
    }
    throw new HttpError(400, msg);
  }
  return;
}

async function handleCloseSkill({ req, res, opts }: RouteRequest, skillCloseMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(skillCloseMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  try {
    const skill = closeSkill(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
    sendJson(res, 200, { skill });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      throw new HttpError(404, msg);
    }
    if (msg.includes('not active')) {
      throw new HttpError(409, msg);
    }
    throw e;
  }
  return;
}

async function handleGetSkill({ req, res, opts }: RouteRequest, skillByIdMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(skillByIdMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const skill = loadSkillById(opts.hippoRoot, ctx.tenantId, id);
  if (!skill) {
    throw new HttpError(404, `skill ${id} not found`);
  }
  sendJson(res, 200, { skill });
  return;
}

// Named list-opts shape for GET /v1/project-briefs (see no-known-value-widening:
// a named interface is not flagged the way an inline anonymous object type is).
interface ProjectBriefListOpts {
  status?: BriefStatus;
  repo?: string;
  limit: number;
}

// ── E2 project_brief routes ──
//
// 6 routes: POST /v1/project-briefs (new; body repo + summary), GET
// /v1/project-briefs (list; status + repo filter; shared parseListLimit), POST
// /v1/project-briefs/refresh (body {repo, dryRun?} -> auto-assemble the brief
// from the repo's receipts; dryRun returns {markdown} without writing; ordered
// before /:id), GET /v1/project-briefs/:id, POST /v1/project-briefs/:id/supersede,
// POST /v1/project-briefs/:id/close. DoS caps: repo 256, summary 8192,
// changeSummary 4096. The store validates + throws; the boundary maps validation
// -> 400, not-found -> 404, not-active -> 409. Mirrors /v1/skills.
async function handleCreateProjectBrief({ req, res, opts }: RouteRequest): Promise<void> {
  const body = await parseJsonBody(req);
  const repo = body['repo'];
  if (!isJsonString(repo) || repo.trim().length === 0) {
    throw new HttpError(400, 'repo is required (non-empty string)');
  }
  if (repo.length > 256) {
    throw new HttpError(400, 'repo exceeds 256-character cap');
  }
  const summary = body['summary'];
  if (!isJsonString(summary) || summary.trim().length === 0) {
    throw new HttpError(400, 'summary is required (non-empty string)');
  }
  if (summary.length > 8192) {
    throw new HttpError(400, 'summary exceeds 8192-character cap');
  }
  const ctx = await buildContextWithAuth(req, opts);
  try {
    const brief = saveProjectBrief(opts.hippoRoot, ctx.tenantId, {
      repo,
      summary,
    }, ctx.actor.subject);
    sendJson(res, 201, { brief });
  } catch (e) {
    // saveProjectBrief throws on validation (single-line repo etc.) -> 400.
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  return;
}

async function handleListProjectBriefs({ req, res, opts, query }: RouteRequest): Promise<void> {
  const status = query.get('status') ?? 'all';
  const repoFilter = query.get('repo');
  const limit = parseListLimit(query.get('limit'));
  const ctx = await buildContextWithAuth(req, opts);
  const listOpts: ProjectBriefListOpts = { limit };
  if (repoFilter !== null && repoFilter.trim().length > 0) {
    listOpts.repo = repoFilter.trim();
  }
  if (status !== 'all') {
    if (!isSetMember(VALID_BRIEF_STATES, status)) {
      throw new HttpError(400, `status must be one of: active | superseded | closed | all (got "${status}")`);
    }
    listOpts.status = status;
  }
  const briefs = loadProjectBriefs(opts.hippoRoot, ctx.tenantId, listOpts);
  sendJson(res, 200, { briefs });
  return;
}

// The refresh op: must precede the /:id routes (literal 'refresh' is non-numeric
// so the /(\d+)/ routes would not match it, but order it first).
async function handleRefreshProjectBrief({ req, res, opts }: RouteRequest): Promise<void> {
  const body = await parseJsonBody(req);
  const repo = body['repo'];
  if (!isJsonString(repo) || repo.trim().length === 0) {
    throw new HttpError(400, 'repo is required (non-empty string)');
  }
  if (repo.length > 256) {
    throw new HttpError(400, 'repo exceeds 256-character cap');
  }
  const dryRun = body['dryRun'] === true;
  const ctx = await buildContextWithAuth(req, opts);
  try {
    if (dryRun) {
      const { markdown, receiptCount } = assembleBriefFromReceipts(opts.hippoRoot, ctx.tenantId, repo);
      sendJson(res, 200, { markdown, receiptCount });
      return;
    }
    const brief = refreshBrief(opts.hippoRoot, ctx.tenantId, repo, ctx.actor.subject);
    sendJson(res, 200, { brief });
  } catch (e) {
    // A refresh race (the active brief is closed/superseded between
    // loadActiveBriefForRepo and the supersede CAS) is a state conflict, not a
    // validation error — map it to 409 like the explicit supersede route
    // (codex-review 2026-05-30, P3).
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      throw new HttpError(404, msg);
    }
    if (msg.includes('not active') || msg.includes('could not be superseded')) {
      throw new HttpError(409, msg);
    }
    throw new HttpError(400, msg);
  }
  return;
}

async function handleSupersedeProjectBrief({ req, res, opts }: RouteRequest, briefSupersedeMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(briefSupersedeMatch[1], 10);
  const body = await parseJsonBody(req);
  const summary = body['summary'];
  if (!isJsonString(summary) || summary.trim().length === 0) {
    throw new HttpError(400, 'summary is required (non-empty string)');
  }
  if (summary.length > 8192) {
    throw new HttpError(400, 'summary exceeds 8192-character cap');
  }
  const changeRaw = body['changeSummary'];
  let changeSummary: string | undefined;
  if (changeRaw !== undefined && changeRaw !== null) {
    if (!isJsonString(changeRaw)) {
      throw new HttpError(400, 'changeSummary must be a string');
    }
    if (changeRaw.length > 4096) {
      throw new HttpError(400, 'changeSummary exceeds 4096-character cap');
    }
    changeSummary = changeRaw;
  }
  const ctx = await buildContextWithAuth(req, opts);
  const existing = loadProjectBriefById(opts.hippoRoot, ctx.tenantId, id);
  if (!existing) {
    throw new HttpError(404, `project brief ${id} not found`);
  }
  try {
    const brief = saveProjectBrief(opts.hippoRoot, ctx.tenantId, {
      repo: existing.repo,
      summary,
      changeSummary,
      supersedesBriefId: id,
    }, ctx.actor.subject);
    sendJson(res, 200, { brief });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      throw new HttpError(404, msg);
    }
    if (msg.includes('not active') || msg.includes('could not be superseded')) {
      throw new HttpError(409, msg);
    }
    throw new HttpError(400, msg);
  }
  return;
}

async function handleCloseProjectBrief({ req, res, opts }: RouteRequest, briefCloseMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(briefCloseMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  try {
    const brief = closeProjectBrief(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
    sendJson(res, 200, { brief });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      throw new HttpError(404, msg);
    }
    if (msg.includes('not active')) {
      throw new HttpError(409, msg);
    }
    throw e;
  }
  return;
}

async function handleGetProjectBrief({ req, res, opts }: RouteRequest, briefByIdMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(briefByIdMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const brief = loadProjectBriefById(opts.hippoRoot, ctx.tenantId, id);
  if (!brief) {
    throw new HttpError(404, `project brief ${id} not found`);
  }
  sendJson(res, 200, { brief });
  return;
}

// ── E2 customer_note routes ──
//
// 5 routes (no assembler/refresh): POST /v1/customer-notes (new; body customer +
// note), GET /v1/customer-notes (list; status + customer filter; shared
// parseListLimit), GET /v1/customer-notes/:id, POST /v1/customer-notes/:id/supersede,
// POST /v1/customer-notes/:id/close. DoS caps: customer 256, note 8192,
// changeSummary 4096. The store validates + throws; the boundary maps validation ->
// 400, not-found -> 404, not-active -> 409. Mirrors /v1/project-briefs.
async function handleCreateCustomerNote({ req, res, opts }: RouteRequest): Promise<void> {
  const body = await parseJsonBody(req);
  const customer = body['customer'];
  if (!isJsonString(customer) || customer.trim().length === 0) {
    throw new HttpError(400, 'customer is required (non-empty string)');
  }
  if (customer.length > 256) {
    throw new HttpError(400, 'customer exceeds 256-character cap');
  }
  const note = body['note'];
  if (!isJsonString(note) || note.trim().length === 0) {
    throw new HttpError(400, 'note is required (non-empty string)');
  }
  if (note.length > 8192) {
    throw new HttpError(400, 'note exceeds 8192-character cap');
  }
  const ctx = await buildContextWithAuth(req, opts);
  try {
    const customerNote = saveCustomerNote(opts.hippoRoot, ctx.tenantId, {
      customer,
      note,
    }, ctx.actor.subject);
    sendJson(res, 201, { note: customerNote });
  } catch (e) {
    // saveCustomerNote throws on validation (single-line customer etc.) -> 400.
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  return;
}

// Named list-opts shape for GET /v1/customer-notes (see the matching
// ProjectBriefListOpts comment above: named interfaces are exempt from
// no-known-value-widening, inline anonymous object types are not).
interface CustomerNoteListOpts {
  status?: NoteStatus;
  customer?: string;
  limit: number;
}

async function handleListCustomerNotes({ req, res, opts, query }: RouteRequest): Promise<void> {
  const status = query.get('status') ?? 'all';
  const customerFilter = query.get('customer');
  const limit = parseListLimit(query.get('limit'));
  const ctx = await buildContextWithAuth(req, opts);
  const listOpts: CustomerNoteListOpts = { limit };
  if (customerFilter !== null && customerFilter.trim().length > 0) {
    listOpts.customer = customerFilter.trim();
  }
  if (status !== 'all') {
    if (!isSetMember(VALID_NOTE_STATES, status)) {
      throw new HttpError(400, `status must be one of: active | superseded | closed | all (got "${status}")`);
    }
    listOpts.status = status;
  }
  const notes = loadCustomerNotes(opts.hippoRoot, ctx.tenantId, listOpts);
  sendJson(res, 200, { notes });
  return;
}

async function handleSupersedeCustomerNote({ req, res, opts }: RouteRequest, noteSupersedeMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(noteSupersedeMatch[1], 10);
  const body = await parseJsonBody(req);
  const note = body['note'];
  if (!isJsonString(note) || note.trim().length === 0) {
    throw new HttpError(400, 'note is required (non-empty string)');
  }
  if (note.length > 8192) {
    throw new HttpError(400, 'note exceeds 8192-character cap');
  }
  const changeRaw = body['changeSummary'];
  let changeSummary: string | undefined;
  if (changeRaw !== undefined && changeRaw !== null) {
    if (!isJsonString(changeRaw)) {
      throw new HttpError(400, 'changeSummary must be a string');
    }
    if (changeRaw.length > 4096) {
      throw new HttpError(400, 'changeSummary exceeds 4096-character cap');
    }
    changeSummary = changeRaw;
  }
  const ctx = await buildContextWithAuth(req, opts);
  const existing = loadCustomerNoteById(opts.hippoRoot, ctx.tenantId, id);
  if (!existing) {
    throw new HttpError(404, `customer note ${id} not found`);
  }
  try {
    const customerNote = saveCustomerNote(opts.hippoRoot, ctx.tenantId, {
      customer: existing.customer,
      note,
      changeSummary,
      supersedesNoteId: id,
    }, ctx.actor.subject);
    sendJson(res, 200, { note: customerNote });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      throw new HttpError(404, msg);
    }
    if (msg.includes('not active') || msg.includes('could not be superseded')) {
      throw new HttpError(409, msg);
    }
    throw new HttpError(400, msg);
  }
  return;
}

async function handleCloseCustomerNote({ req, res, opts }: RouteRequest, noteCloseMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(noteCloseMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  try {
    const customerNote = closeCustomerNote(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
    sendJson(res, 200, { note: customerNote });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found')) {
      throw new HttpError(404, msg);
    }
    if (msg.includes('not active')) {
      throw new HttpError(409, msg);
    }
    throw e;
  }
  return;
}

async function handleGetCustomerNote({ req, res, opts }: RouteRequest, noteByIdMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(noteByIdMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const customerNote = loadCustomerNoteById(opts.hippoRoot, ctx.tenantId, id);
  if (!customerNote) {
    throw new HttpError(404, `customer note ${id} not found`);
  }
  sendJson(res, 200, { note: customerNote });
  return;
}

/** The /v1 routes in dispatch order; the first entry whose method and path match handles the request. */
const V1_ROUTES: readonly Route[] = [
  { method: 'POST', path: '/v1/memories', handler: handleCreateMemory },
  { method: 'GET', path: '/v1/graph', handler: handleGetGraph },
  { method: 'GET', path: '/v1/memories', handler: handleRecallMemories },
  { method: 'GET', pattern: '/v1/sessions/:id/assemble', handler: handleAssembleSession },
  { method: 'GET', pattern: '/v1/recall/drill/:id', handler: handleDrillRecall },
  { method: 'POST', pattern: '/v1/memories/:id/archive', handler: handleArchiveMemory },
  { method: 'POST', pattern: '/v1/memories/:id/supersede', handler: handleSupersedeMemory },
  { method: 'POST', pattern: '/v1/memories/:id/promote', handler: handlePromoteMemory },
  { method: 'DELETE', pattern: '/v1/memories/:id', handler: handleForgetMemory },
  { method: 'POST', path: '/v1/outcome', handler: handleApplyOutcome },
  { method: 'GET', path: '/v1/context', handler: handleGetContext },
  { method: 'POST', path: '/v1/sleep', handler: handleSleep },
  { method: 'POST', path: '/v1/auth/keys', handler: handleCreateAuthKey },
  { method: 'GET', path: '/v1/auth/keys', handler: handleListAuthKeys },
  { method: 'DELETE', pattern: '/v1/auth/keys/:keyId', handler: handleRevokeAuthKey },
  { method: 'GET', path: '/v1/quarantine', handler: handleListQuarantine },
  { method: 'POST', pattern: '/v1/quarantine/:id/approve', handler: handleApproveQuarantine },
  { method: 'POST', pattern: '/v1/quarantine/:id/reject', handler: handleRejectQuarantine },
  { method: 'GET', path: '/v1/audit', handler: handleListAudit },
  { method: 'POST', path: '/v1/predictions', handler: handleCreatePrediction },
  { method: 'GET', path: '/v1/predictions', handler: handleListPredictions },
  { method: 'GET', path: '/v1/predictions/stats', handler: handlePredictionStats },
  { method: 'GET', regex: /^\/v1\/predictions\/(\d+)$/, handler: handleGetPrediction },
  { method: 'POST', regex: /^\/v1\/predictions\/(\d+)\/close$/, handler: handleClosePrediction },
  { method: 'POST', path: '/v1/decisions', handler: handleCreateDecision },
  { method: 'GET', path: '/v1/decisions', handler: handleListDecisions },
  { method: 'POST', regex: /^\/v1\/decisions\/(\d+)\/supersede$/, handler: handleSupersedeDecision },
  { method: 'POST', regex: /^\/v1\/decisions\/(\d+)\/close$/, handler: handleCloseDecision },
  { method: 'GET', regex: /^\/v1\/decisions\/(\d+)$/, handler: handleGetDecision },
  { method: 'POST', path: '/v1/incidents', handler: handleCreateIncident },
  { method: 'GET', path: '/v1/incidents', handler: handleListIncidents },
  { method: 'POST', regex: /^\/v1\/incidents\/(\d+)\/resolve$/, handler: handleResolveIncident },
  { method: 'POST', regex: /^\/v1\/incidents\/(\d+)\/close$/, handler: handleCloseIncident },
  { method: 'GET', regex: /^\/v1\/incidents\/(\d+)$/, handler: handleGetIncident },
  { method: 'POST', path: '/v1/processes', handler: handleCreateProcess },
  { method: 'GET', path: '/v1/processes', handler: handleListProcesses },
  { method: 'POST', regex: /^\/v1\/processes\/(\d+)\/supersede$/, handler: handleSupersedeProcess },
  { method: 'POST', regex: /^\/v1\/processes\/(\d+)\/close$/, handler: handleCloseProcess },
  { method: 'GET', regex: /^\/v1\/processes\/(\d+)$/, handler: handleGetProcess },
  { method: 'POST', path: '/v1/policies', handler: handleCreatePolicy },
  { method: 'GET', path: '/v1/policies', handler: handleListPolicies },
  { method: 'GET', path: '/v1/policies/asof', handler: handlePoliciesAsOf },
  { method: 'POST', regex: /^\/v1\/policies\/(\d+)\/supersede$/, handler: handleSupersedePolicy },
  { method: 'POST', regex: /^\/v1\/policies\/(\d+)\/close$/, handler: handleClosePolicy },
  { method: 'GET', regex: /^\/v1\/policies\/(\d+)$/, handler: handleGetPolicy },
  { method: 'POST', path: '/v1/skills', handler: handleCreateSkill },
  { method: 'GET', path: '/v1/skills', handler: handleListSkills },
  { method: 'GET', path: '/v1/skills/export', handler: handleExportSkills },
  { method: 'POST', regex: /^\/v1\/skills\/(\d+)\/supersede$/, handler: handleSupersedeSkill },
  { method: 'POST', regex: /^\/v1\/skills\/(\d+)\/close$/, handler: handleCloseSkill },
  { method: 'GET', regex: /^\/v1\/skills\/(\d+)$/, handler: handleGetSkill },
  { method: 'POST', path: '/v1/project-briefs', handler: handleCreateProjectBrief },
  { method: 'GET', path: '/v1/project-briefs', handler: handleListProjectBriefs },
  { method: 'POST', path: '/v1/project-briefs/refresh', handler: handleRefreshProjectBrief },
  { method: 'POST', regex: /^\/v1\/project-briefs\/(\d+)\/supersede$/, handler: handleSupersedeProjectBrief },
  { method: 'POST', regex: /^\/v1\/project-briefs\/(\d+)\/close$/, handler: handleCloseProjectBrief },
  { method: 'GET', regex: /^\/v1\/project-briefs\/(\d+)$/, handler: handleGetProjectBrief },
  { method: 'POST', path: '/v1/customer-notes', handler: handleCreateCustomerNote },
  { method: 'GET', path: '/v1/customer-notes', handler: handleListCustomerNotes },
  { method: 'POST', regex: /^\/v1\/customer-notes\/(\d+)\/supersede$/, handler: handleSupersedeCustomerNote },
  { method: 'POST', regex: /^\/v1\/customer-notes\/(\d+)\/close$/, handler: handleCloseCustomerNote },
  { method: 'GET', regex: /^\/v1\/customer-notes\/(\d+)$/, handler: handleGetCustomerNote },
];

/**
 * Run the first /v1 route whose method and path match. Each matcher runs before its method check, as the
 * inline route blocks did, so a malformed `%` escape still throws from matchPath on any method.
 */
async function dispatchV1Route(r: RouteRequest, method: string, path: string): Promise<boolean> {
  for (const route of V1_ROUTES) {
    if ('path' in route) {
      if (method === route.method && path === route.path) {
        await route.handler(r);
        return true;
      }
    } else if ('pattern' in route) {
      const params = matchPath(route.pattern, path);
      if (method === route.method && params) {
        await route.handler(r, params);
        return true;
      }
    } else {
      const match = path.match(route.regex);
      if (method === route.method && match) {
        await route.handler(r, match);
        return true;
      }
    }
  }
  return false;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServeOpts,
  startedAt: string,
  limiter?: RateLimiter,
): Promise<void> {
  // v1.6.4: pre-decode raw-URL slash check. Catches `%2F` / `%2f` before
  // Node's URL parser collapses them and they slip past the route table.
  rejectEncodedSlash(req.url ?? '/');

  const { method, path, query } = parseRequest(req);

  if (method === 'GET' && path === '/health') {
    // Loopback callers (detectServer's stale-pidfile probe reads version and
    // pid) get the full body. Non-loopback callers get liveness only: the
    // version string would fingerprint the build for the public internet and
    // the pid is noise. Platform health checks only need the 200.
    if (isLoopback(req.socket.remoteAddress)) {
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        started_at: startedAt,
        pid: process.pid,
      });
    } else {
      sendJson(res, 200, { ok: true });
    }
    return;
  }

  // E3: per-IP rate limit on /v1/* and /mcp* to bound api-key-id enumeration. /health
  // (a liveness probe) and other paths are never throttled. A 429 thrown
  // here lands in the createServer catch like any other HttpError.
  //
  // Keyed on the socket's remote address by default. Behind a TLS-terminating
  // proxy every socket carries the proxy's address, collapsing the per-IP
  // buckets into one global bucket that pre-auth traffic can drain; set
  // HIPPO_CLIENT_IP_HEADER there so each real client gets its own bucket
  // (see clientIpForRateLimit).
  if (limiter && (path.startsWith('/v1/') || path === '/mcp' || path === '/mcp/stream')) {
    const ip = clientIpForRateLimit(req);
    if (!limiter.check(ip)) {
      throw new HttpError(429, 'rate limit exceeded');
    }
  }

  if (await dispatchV1Route({ req, res, opts, query }, method, path)) return;

  if (method === 'POST' && path === '/v1/connectors/slack/events') {
    // Bearer auth deliberately skipped: this route is in PUBLIC_ROUTES and authenticates via the Slack HMAC signature.
    if (!isPublicRoute(method, path)) {
      // Defensive: PUBLIC_ROUTES drift would land here. Fail closed.
      throw new HttpError(401, 'auth required');
    }
    await handleSlackEventsWebhook({ req, res, opts });
    return;
  }

  if (method === 'POST' && path === '/v1/connectors/github/events') {
    if (!isPublicRoute(method, path)) {
      throw new HttpError(401, 'auth required');
    }
    await handleGitHubEventsWebhook({ req, res, opts });
    return;
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
    const ctx = await buildContextWithAuth(req, opts);
    const raw = await readBody(req);
    let mcpReq: JsonValue;
    try {
      mcpReq = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'invalid JSON-RPC body');
    }
    if (!isJsonObjectRecord(mcpReq) || !isJsonString(mcpReq.method)) {
      throw new HttpError(400, 'JSON-RPC body must include a method string');
    }
    // SAFETY: validated above as a plain JSON object carrying a string method;
    // the remaining McpRequest wire fields (jsonrpc, id, params) are checked or
    // safely defaulted inside handleMcpRequest's JSON-RPC dispatch.
    const rpcReq = mcpReq as McpRequest & Record<string, JsonValue>;
    let mcpRes;
    try {
      mcpRes = await handleMcpRequest(rpcReq, {
        hippoRoot: ctx.hippoRoot,
        tenantId: ctx.tenantId,
        // v1.12.0: McpContext.actor stays string; extract subject at the boundary.
        actor: ctx.actor.subject,
        // The caller's real role: MCP tools must not run a member key as admin.
        role: ctx.actor.role,
        scopes: ctx.actor.scopes,
        viaAuthResolver: ctx.actor.viaAuthResolver,
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
    await requireAuth(req, opts);
    // An async resolver can outlive the client; 'close' has already fired, so no timer may start.
    if (req.destroyed || res.destroyed || req.socket.destroyed) return;
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
    let checking = false;
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
      if (checking) return;
      checking = true;
      void heartbeatVerdict(req, opts).then((verdict) => {
        checking = false;
        if (closed || verdict === 'unavailable') return;
        if (verdict === 'revoked') {
          closeWith('auth_revoked');
          clearInterval(ping);
          return;
        }
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(ping);
        }
      });
    }, heartbeatMs);
    // Don't keep the event loop alive just for this timer — the server's
    // listener already does that, and tests want the process to exit cleanly.
    if (ping.unref instanceof Function) ping.unref();
    // res 'close' covers an early socket drop that req 'close' can miss.
    res.on('close', () => {
      closed = true;
      clearInterval(ping);
    });
    return;
  }

  res.writeHead(404, JSON_HEADERS);
  res.end(JSON.stringify({ error: 'not found' }));
}

/**
 * Boot the HTTP daemon on host:port and write the pidfile under hippoRoot.
 *
 * Refuses non-loopback hosts at boot (Footgun #3 from the A1 plan) unless
 * HIPPO_REQUIRE_AUTH=1 is set. The A5 v2 auth middleware (buildContextWithAuth /
 * requireAuth) has shipped and every route checks it except GET /health
 * (public by design for platform health checks) and the two connector
 * webhooks in PUBLIC_ROUTES, which are HMAC-gated by their own signing
 * secrets and 404 when those secrets are unset. But the loopback
 * no-auth fallback inside buildContextWithAuth still admits unauthenticated
 * requests from a loopback remote address, so binding to a non-loopback host
 * is only safe once that fallback is disabled with HIPPO_REQUIRE_AUTH=1,
 * which forces every request (loopback or not) through Bearer-token
 * validation. Without that env var set, a non-loopback bind would expose the
 * DB to the network with no auth, so we fail fast instead.
 *
 * Use port: 0 in tests to bind to an ephemeral port and read the actual
 * port back via server.address() after listen.
 */
export async function serve(opts: ServeOpts): Promise<ServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const requestedPort = opts.port ?? Number(process.env.HIPPO_PORT ?? 6789);

  if (!LOOPBACK_HOSTS.has(host) && process.env.HIPPO_REQUIRE_AUTH !== '1') {
    throw new Error(
      `Refusing to bind hippo serve to non-loopback host '${host}' without auth. ` +
      `Set HIPPO_REQUIRE_AUTH=1 to bind non-loopback; every request then requires ` +
      `a valid API key. Bind to 127.0.0.1 / ::1 / localhost otherwise.`,
    );
  }

  // H3: refuse to start if a live hippo server already serves this hippoRoot.
  // detectServer probes the recorded /health — a stale pidfile is unlinked and
  // ignored, but a live peer means a concurrent `hippo serve` would race for
  // the port and clobber the pidfile.
  const existing = await detectServer(opts.hippoRoot);
  if (existing) {
    throw new Error(
      `hippo serve: already running on port ${existing.port} (pid ${existing.pid}). ` +
      `Stop that server before starting another on the same hippoRoot.`,
    );
  }

  // The server's start time. Single source of truth: it is returned by every
  // GET /health response and (below) written into the pidfile, so detectServer
  // can match the two and prove a pid-reusing impostor is not the real server.
  const startedAt = new Date().toISOString();

  // E3: per-IP rate limiter for /v1/* and /mcp*. Built here (not at module scope) so
  // HIPPO_V1_RPS is read at boot, matching HIPPO_PORT above and letting a test
  // set the rate before serve(). A non-positive or non-finite value disables
  // limiting (the opt-out knob).
  const v1Rps = Number(process.env.HIPPO_V1_RPS ?? 20);
  const limiter: RateLimiter | undefined =
    Number.isFinite(v1Rps) && v1Rps > 0
      ? createRateLimiter({ ratePerSec: v1Rps, burst: v1Rps * 2, idleEvictMs: 60000, maxKeys: 10000 })
      : undefined;

  const server: Server = createServer((req, res) => {
    handleRequest(req, res, opts, startedAt, limiter).catch(<E>(err: E) => {
      if (res.headersSent) {
        try { res.end(); } catch { /* socket already gone */ }
        return;
      }
      if (err instanceof BodyTooLargeError) {
        sendError(res, 413, err.message);
        // M3: readBody hit the 1 MB cap mid-stream, so the request body is
        // only partially consumed. Destroy the socket rather than let the
        // client's remaining (unbounded) bytes drain into an exchange we have
        // already answered.
        req.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendError(res, err.status, err.message);
        return;
      }
      // F5 (v1.6.5) + v1.7.0 api-contract review: RecallContractError lands
      // at 400 with {error: <message>, code: <code>}. The `error` field
      // matches `sendError`'s shape (human message, used by HttpError /
      // BodyTooLargeError / mapApiError). The `code` field is the typed
      // discriminator — clients can branch on `body.code` without parsing
      // prose. Earlier draft used {error: code, message: text} but that
      // diverged from the rest of v1/* and forced clients to special-case
      // the error path.
      if (err instanceof RecallContractError) {
        sendJson(res, 400, { error: err.message, code: err.code });
        return;
      }
      const mapped = mapApiError(err);
      sendError(res, mapped.status, mapped.message);
    });
  });

  // T3b capture (v1.26.2): tests/server-concurrency.test.ts's ECONNRESET flake
  // traced to a chunk-boundary reuse race — a kept-alive socket idled through
  // a prior response chunk gets closed by the server's default 5s
  // keepAliveTimeout just as a client reuses it for the next request. Raising
  // both timeouts shrinks that idle-close/reuse window ~13x. Keep
  // headersTimeout ABOVE the EFFECTIVE keep-alive expiry, which is
  // keepAliveTimeout + keepAliveTimeoutBuffer (the buffer defaults to
  // 1,000ms on Node 22.19+/24.6+ — verified 1,000 on node 24.13, so the
  // effective expiry here is 66s; codex review caught that a 66s
  // headersTimeout would sit exactly ON that boundary and recreate the
  // race). The headers timer also runs while a kept-alive socket waits for
  // its next request, so a value at or below the effective expiry would
  // itself close idle reused sockets, and Node would not flag it (no error
  // or warning at listen time — verified empirically).
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

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
  if (!isAddressInfo(address)) {
    throw new Error('server.address() returned unexpected shape');
  }
  const addressInfo = address;
  const actualPort = addressInfo.port;
  const url = `http://${host}:${actualPort}`;

  writePidfile(opts.hippoRoot, { port: actualPort, url, startedAt });

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    // Remove the pidfile only if it still names this server. A newer server
    // may have started on this hippoRoot and rewritten the pidfile; an
    // unconditional unlink here would orphan it. (v0.37.0 server-hardening.)
    removePidfileIfOwned(opts.hippoRoot, { pid: process.pid, startedAt });
    // Force-close any long-lived idle connections (e.g. SSE keepalive streams
    // on /mcp/stream) so server.close() can resolve. Without this, SIGTERM
    // would hang the process until the SSE client cancels. Available on
    // Node 18.2+; gate via optional chaining to avoid crashing on older runtimes.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  if (opts.handleSignals) {
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

  return { port: actualPort, url, stop, server };
}
