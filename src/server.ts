import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { detectServer, writePidfile, removePidfileIfOwned } from './server-detect.js';
import { resolveTenantId } from './tenant.js';
import { openHippoDb, closeHippoDb } from './db.js';
import {
  buildSessionKey,
  getOrCreateRing,
  appendRecall,
  snapshotRing,
  hashQueryText,
  RingBuffer,
} from './recall-history.js';
import { appendAuditEvent } from './audit.js';

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
import { validateApiKey } from './auth.js';
import { createRateLimiter, type RateLimiter } from './rate-limit.js';
import {
  remember,
  recall,
  RecallContractError,
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
  adminActor,
  type Context,
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
  type ClosureState,
} from './predictions.js';
import {
  saveDecision,
  closeDecision,
  loadDecisionById,
  loadDecisions,
  VALID_DECISION_STATES,
  type DecisionStatus,
} from './decisions.js';
import {
  saveIncident,
  resolveIncident,
  closeIncident,
  loadIncidentById,
  loadIncidents,
  VALID_INCIDENT_STATES,
  type IncidentStatus,
} from './incidents.js';
import {
  saveProcess,
  closeProcess,
  loadProcessById,
  loadProcesses,
  VALID_PROCESS_STATES,
  type ProcessStatus,
} from './processes.js';
import {
  savePolicy,
  closePolicy,
  loadPolicyById,
  loadPolicies,
  loadPoliciesAsOf,
  VALID_POLICY_STATES,
  type PolicyStatus,
} from './policies.js';
import {
  saveSkill,
  closeSkill,
  loadSkillById,
  loadSkills,
  exportSkills,
  VALID_SKILL_STATES,
  type SkillStatus,
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

const VALID_AUDIT_OPS: ReadonlySet<AuditOp> = new Set<AuditOp>([
  'remember',
  'recall',
  'promote',
  'supersede',
  'forget',
  'archive_raw',
  'auth_revoke',
  'auth_create', // v1.12.4: emitted by api.authCreate
  'outcome',     // v1.11.5: pre-existing drift — emitted today but rejected by old Set
  'consolidate', // v1.11.5: emitted by api.sleep / POST /v1/sleep
  'audit_prune', // v1.12.9: emitted by pruneAuditLog
  'summary_marked_dirty', // v0.30 / E1 — lockstep with AuditOp union + cli.ts VALID_AUDIT_OPS (v1.11.5 CRIT A institutional rule)
  'summary_marked_clean', // v0.30 / E3 — buildDag post-link clean op; lockstep
  'summary_rebuilt',      // v0.30 / E3 — sleep-cycle rebuild op; lockstep
  'predict_create',       // v0.31 / E2 prediction first-class object — emitted by savePrediction
  'predict_close',        // v0.31 / E2 — emitted by closePrediction
  'predict_baserate',     // v0.31 / J3 — emitted by computePredictionBaserate
  'recall_autodebias_hint',                   // v0.32 / J3.2 — emitted by computePlanningFallacyHint on success
  'recall_autodebias_hint_no_class_match',    // v0.32 / J3.2 — telemetry: forward-claim, no class scored
  'recall_autodebias_hint_tiebreak',          // v0.32 / J3.2 — telemetry: forward-claim, >=2 classes tied
  'recall_anchor_detected_query_repeat',      // v0.33 / J1 — emitted by detector on R1 fire
  'recall_anchor_detected_memory_dominance',  // v0.33 / J1 — emitted by detector on R2 fire
  'recall_anchor_skipped_no_session',         // v0.33 / J1 — telemetry: no sessionId, ring skipped
  'recall_availability_detected',             // v1.13.x / J2 - emitted when availability/recency-bias hint fires
  'decision_create',       // E2 decision first-class object — emitted by saveDecision
  'decision_supersede',    // E2 — emitted by saveDecision when --supersedes resolves to an active decision row
  'decision_close',        // E2 — emitted by closeDecision
  'incident_open',         // E2 incident first-class object — emitted by saveIncident
  'incident_resolve',      // E2 — emitted by resolveIncident (open -> resolved)
  'incident_close',        // E2 — emitted by closeIncident (open|resolved -> closed)
  'process_create',        // E2 process first-class object — emitted by saveProcess
  'process_supersede',     // E2 — emitted by saveProcess on a supersession
  'process_close',         // E2 — emitted by closeProcess
  'policy_create',         // E2 policy first-class object — emitted by savePolicy
  'policy_supersede',      // E2 — emitted by savePolicy on a supersession
  'policy_close',          // E2 — emitted by closePolicy
  'skill_create',          // E2 skill first-class object — emitted by saveSkill
  'skill_supersede',       // E2 — emitted by saveSkill on a supersession
  'skill_close',           // E2 — emitted by closeSkill
  'project_brief_create',  // E2 project_brief first-class object — emitted by saveProjectBrief
  'project_brief_supersede', // E2 — emitted by saveProjectBrief on a supersession (incl. refresh)
  'project_brief_close',   // E2 — emitted by closeProjectBrief
  'customer_note_create',  // E2 customer_note first-class object — emitted by saveCustomerNote
  'customer_note_supersede', // E2 — emitted by saveCustomerNote on a supersession
  'customer_note_close',   // E2 — emitted by closeCustomerNote
]);

// Cap on GET /v1/audit?limit=. Matches docs/api.md (when written) and is large
// enough to dump a small deployment's full audit log without paginating, but
// small enough that a malicious client can't ask for the world.
const MAX_AUDIT_LIMIT = 10000;

// HTTP-boundary validation for a process `steps` body (untrusted). Returns the
// step strings (saveProcess re-validates + trims, this is the fail-fast 400
// gate). Caps mirror src/processes.ts MAX_PROCESS_STEPS / MAX_PROCESS_STEP_LEN.
function validateProcessStepsBody(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new HttpError(400, 'steps must be an array of strings');
  }
  if (raw.length > 200) {
    throw new HttpError(400, 'steps exceeds 200-step cap');
  }
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new HttpError(400, 'each step must be a string');
    }
    if (item.trim().length === 0) {
      throw new HttpError(400, 'a step is empty');
    }
    if (item.length > 2000) {
      throw new HttpError(400, 'a step exceeds the 2000-character cap');
    }
  }
  return raw as string[];
}

// HTTP-boundary check for an optional policy date field (validFrom/validTo).
// Type + length only; savePolicy/loadPoliciesAsOf normalize + format-validate the
// value (an unparseable date throws there -> mapped to 400). 64-char cap bounds a
// junk string before it reaches the Date parser.
function optionalDateField(raw: unknown, label: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
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
      if (!result.valid || !result.tenantId || !result.keyId || !result.role) {
        throw new HttpError(401, 'invalid api key');
      }
      return {
        hippoRoot,
        tenantId: result.tenantId,
        actor: {
          subject: `api_key:${result.keyId}`,
          role: result.role,
        },
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

  // v1.12.0: loopback fallback is process-local, treat as admin.
  return {
    hippoRoot,
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
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      started_at: startedAt,
      pid: process.pid,
    });
    return;
  }

  // E3: per-IP rate limit on /v1/* to bound api-key-id enumeration. /health
  // (a liveness probe) and non-/v1 paths are never throttled. A 429 thrown
  // here lands in the createServer catch like any other HttpError.
  //
  // Keyed on the socket's remote address. serve() binds loopback-only today,
  // so in the default deployment this is effectively one global /v1 bucket,
  // which still bounds enumeration. True per-client keying (and trusting an
  // X-Forwarded-For only from a known proxy) belongs with the non-loopback
  // serving that A5 v2 unlocks.
  if (limiter && path.startsWith('/v1/')) {
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!limiter.check(ip)) {
      throw new HttpError(429, 'rate limit exceeded');
    }
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

  // GET /v1/graph?entity=NAME&limit=N — read-only entity/relation graph (tenant-scoped)
  if (method === 'GET' && path === '/v1/graph') {
    const entityRaw = query.get('entity');
    // Cap at the graph entity-name cap (512), not the id-shaped 256, so a valid
    // long decision/policy name remains focusable over HTTP (codex P2).
    if (entityRaw !== null && entityRaw.length > MAX_ENTITY_NAME_LEN) {
      throw new HttpError(400, `entity exceeds the ${MAX_ENTITY_NAME_LEN}-character cap`);
    }
    const limit = parseListLimit(query.get('limit'));
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const model = buildGraphModel(ctx.hippoRoot, ctx.tenantId, {
      entity: entityRaw ?? undefined,
      limit,
    });
    sendJson(res, 200, model);
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
    // v1.7.2 T4: forward as Number(...) — NaN, 0, negative all reach
    // recall() which throws RecallContractError with code='invalid_scorer_window'.
    // No transport-side validation; recall() owns the contract.
    const scorerWindowRaw = query.get('scorer_window');
    const scorerWindow = scorerWindowRaw === null ? undefined : Number(scorerWindowRaw);
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
    const ctx = buildContextWithAuth(req, opts.hippoRoot);

    // v0.33 / J1 — HTTP per-pipeline anchoring detector. HTTP threads its
    // ring snapshot via opts.recallHistory so api.recall's own
    // anchoringHint compute path activates. Unlike CLI (which computes
    // its own hint separately because cmdRecall runs its own physics/
    // hybrid pipeline outside api.recall), HTTP's /v1/memories response
    // body IS api.recall's result directly. So the api.recall-computed
    // hint flows through. HIPPO_ANCHORING=off short-circuits.
    let httpRecallHistory: ReturnType<typeof snapshotRing> | undefined;
    let httpRingKey: string | undefined;
    if (process.env.HIPPO_ANCHORING !== 'off') {
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
            metadata: {
              query_hash: createHash('sha256').update(q).digest('hex').slice(0, 16),
              query_length: q.length,
            },
          });
        } finally {
          closeHippoDb(dbForAudit);
        }
      }
    }

    const result = recall(ctx, {
      query: q,
      limit,
      mode: (mode ?? undefined) as 'bm25' | 'hybrid' | 'physics' | undefined,
      scope: scope ?? undefined,
      includeContinuity,
      ...(freshTailCount !== undefined ? { freshTailCount } : {}),
      ...(freshTailSessionId !== undefined ? { freshTailSessionId } : {}),
      ...(summarizeOverflow !== undefined ? { summarizeOverflow } : {}),
      ...(scorerWindow !== undefined ? { scorerWindow } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(httpRecallHistory !== undefined ? { recallHistory: httpRecallHistory } : {}),
      ...(explain ? { explain } : {}),
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
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = assemble(ctx, assembleMatch.id!, {
      ...(budget !== undefined ? { budget } : {}),
      ...(freshTailCount !== undefined ? { freshTailCount } : {}),
      ...(summarizeOlder !== undefined ? { summarizeOlder } : {}),
      ...(scope !== undefined ? { scope } : {}),
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
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10) {
        throw new HttpError(400, 'depth must be a positive integer between 1 and 10');
      }
      depth = parsed;
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = drillDown(ctx, drillMatch.id!, {
      ...(limit !== undefined ? { limit } : {}),
      ...(budget !== undefined ? { budget } : {}),
      ...(depth !== undefined ? { depth } : {}),
    });
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
  const archiveMatch = matchPath('/v1/memories/:id/archive', path);
  if (method === 'POST' && archiveMatch) {
    validateIdSegment(archiveMatch.id!, 'memory id');
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
    validateIdSegment(supersedeMatch.id!, 'memory id');
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
    validateIdSegment(promoteMatch.id!, 'memory id');
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = promote(ctx, promoteMatch.id!);
    sendJson(res, 200, result);
    return;
  }

  const idMatch = matchPath('/v1/memories/:id', path);
  if (method === 'DELETE' && idMatch) {
    validateIdSegment(idMatch.id!, 'memory id');
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
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
  if (method === 'POST' && path === '/v1/outcome') {
    const body = await parseJsonBody(req);
    const good = body['good'];
    if (typeof good !== 'boolean') {
      throw new HttpError(400, 'good is required (boolean)');
    }
    const idsRaw = body['ids'];
    let ids: string[] | undefined;
    if (idsRaw !== undefined) {
      if (!Array.isArray(idsRaw)) {
        throw new HttpError(400, 'ids must be an array of non-empty strings');
      }
      for (const id of idsRaw) {
        if (typeof id !== 'string' || id.length === 0) {
          throw new HttpError(400, 'ids must be an array of non-empty strings');
        }
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
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
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
  if (method === 'GET' && path === '/v1/context') {
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
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const result = await getContext(ctx, {
      q,
      budget,
      limit,
      pinnedOnly,
      scope,
      includeRecent,
    });
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
  // serving needs an admin-role gate before exposing this route.
  if (method === 'POST' && path === '/v1/sleep') {
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
    const sleepCtx = buildContextWithAuth(req, opts.hippoRoot);
    if (sleepCtx.actor.role !== 'admin') {
      throw new HttpError(403, '/v1/sleep requires admin role');
    }
    const body = await parseJsonBody(req);
    const dryRunRaw = body['dry_run'];
    if (dryRunRaw !== undefined && typeof dryRunRaw !== 'boolean') {
      throw new HttpError(400, 'dry_run must be a boolean');
    }
    const noShareRaw = body['no_share'];
    if (noShareRaw !== undefined && typeof noShareRaw !== 'boolean') {
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
  if (method === 'POST' && path === '/v1/auth/keys') {
    const body = await parseJsonBody(req);
    const labelRaw = body['label'];
    if (labelRaw !== undefined && typeof labelRaw !== 'string') {
      throw new HttpError(400, 'label must be a string');
    }
    // v1.12.3: optional body.role mirrors the --role CLI flag. Validated
    // strictly — anything other than 'admin'|'member' is a 400 (no silent
    // fallback to admin). Required note: admin Bearer can mint a member
    // key for the same tenant; member Bearer minting an admin key is NOT
    // blocked here today (auth_create is currently unaudited per the A5 v2
    // note in authCreate doc). The HTTP layer trusts the buildContextWithAuth
    // role check at admin-gated routes; mint surface remains permissive.
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
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
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
    validateIdSegment(keyMatch.keyId!, 'key id');
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
    // D2 v1.12.10: optional ?tenant=<t> param. Defaults to ctx.tenantId
    // (caller's own tenant). Lets admins query the '__host__' synthetic
    // tenant where host-wide ops like 'consolidate' are recorded. Today
    // the audit route inherits the auth gate on /v1/audit (Bearer auth);
    // a future per-tenant authz check should ensure non-admin Bearers
    // can only pass their own tenant_id here.
    const tenantOverride = query.get('tenant');
    const effectiveCtx = tenantOverride !== null && tenantOverride !== ''
      ? { ...ctx, tenantId: tenantOverride }
      : ctx;
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

  if (method === 'POST' && path === '/v1/predictions') {
    const body = await parseJsonBody(req);
    const claim = body['claim'];
    if (typeof claim !== 'string' || claim.length === 0) {
      throw new HttpError(400, 'claim is required (non-empty string)');
    }
    if (claim.length > 4096) {
      throw new HttpError(400, 'claim exceeds 4096-character cap');
    }
    const classTag = body['classTag'];
    if (typeof classTag !== 'string' || classTag.length === 0) {
      throw new HttpError(400, 'classTag is required (non-empty string)');
    }
    const estimate = body['estimate'];
    let estimateValue: number | undefined;
    if (estimate !== undefined && estimate !== null) {
      if (typeof estimate !== 'number' || !Number.isFinite(estimate)) {
        throw new HttpError(400, 'estimate must be a finite number');
      }
      estimateValue = estimate;
    }
    const unit = body['unit'];
    let estimateUnit: string | undefined;
    if (unit !== undefined && unit !== null) {
      if (typeof unit !== 'string') {
        throw new HttpError(400, 'unit must be a string');
      }
      estimateUnit = unit;
    }
    const targetDate = body['targetDate'];
    let targetDateValue: string | undefined;
    if (targetDate !== undefined && targetDate !== null) {
      if (typeof targetDate !== 'string') {
        throw new HttpError(400, 'targetDate must be an ISO date string');
      }
      targetDateValue = targetDate;
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
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

  if (method === 'GET' && path === '/v1/predictions') {
    const classTag = query.get('class') ?? undefined;
    const status = query.get('status') ?? 'all';
    const limit = parseListLimit(query.get('limit'));
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
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
      if (!VALID_CLOSURE_STATES.has(status as ClosureState)) {
        throw new HttpError(400, `status must be one of: open | closed | closed-unknown | all (got "${status}")`);
      }
      if (!classTag) {
        throw new HttpError(400, 'status filter (non-open) requires class param');
      }
      predictions = loadPredictionsByClass(opts.hippoRoot, ctx.tenantId, classTag, {
        closureState: status as ClosureState,
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
  if (method === 'GET' && path === '/v1/predictions/stats') {
    const classTag = query.get('class');
    if (!classTag || classTag.length === 0) {
      throw new HttpError(400, 'class param is required');
    }
    if (classTag.length > 256) {
      throw new HttpError(400, 'class exceeds 256-character cap');
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const baserate = computePredictionBaserate(opts.hippoRoot, ctx.tenantId, classTag, ctx.actor.subject);
    sendJson(res, 200, { baserate });
    return;
  }

  const predictionByIdMatch = path.match(/^\/v1\/predictions\/(\d+)$/);
  if (method === 'GET' && predictionByIdMatch) {
    const id = parseInt(predictionByIdMatch[1], 10);
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const prediction = loadPredictionById(opts.hippoRoot, ctx.tenantId, id);
    if (!prediction) {
      throw new HttpError(404, `prediction ${id} not found`);
    }
    sendJson(res, 200, { prediction });
    return;
  }

  const predictionCloseMatch = path.match(/^\/v1\/predictions\/(\d+)\/close$/);
  if (method === 'POST' && predictionCloseMatch) {
    const id = parseInt(predictionCloseMatch[1], 10);
    const body = await parseJsonBody(req);
    const state = body['state'];
    if (typeof state !== 'string' || !VALID_CLOSURE_STATES.has(state as ClosureState) || state === 'open') {
      throw new HttpError(400, 'state is required and must be one of: closed | closed-unknown');
    }
    const actual = body['actual'];
    let actualValue: number | undefined;
    if (actual !== undefined && actual !== null) {
      if (typeof actual !== 'number' || !Number.isFinite(actual)) {
        throw new HttpError(400, 'actual must be a finite number');
      }
      actualValue = actual;
    }
    const note = body['note'];
    let closureNote: string | undefined;
    if (note !== undefined && note !== null) {
      if (typeof note !== 'string') {
        throw new HttpError(400, 'note must be a string');
      }
      if (note.length > 2048) {
        throw new HttpError(400, 'note exceeds 2048-character cap');
      }
      closureNote = note;
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    try {
      const prediction = closePrediction(opts.hippoRoot, ctx.tenantId, id, {
        closureState: state as ClosureState,
        actualValue,
        closureNote,
      }, ctx.actor.subject);
      sendJson(res, 200, { prediction });
    } catch (e) {
      const msg = (e as Error).message;
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
  if (method === 'POST' && path === '/v1/decisions') {
    const body = await parseJsonBody(req);
    const text = body['text'];
    if (typeof text !== 'string' || text.length === 0) {
      throw new HttpError(400, 'text is required (non-empty string)');
    }
    if (text.length > 4096) {
      throw new HttpError(400, 'text exceeds 4096-character cap');
    }
    const contextRaw = body['context'];
    let context: string | undefined;
    if (contextRaw !== undefined && contextRaw !== null) {
      if (typeof contextRaw !== 'string') {
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
      if (typeof supRaw !== 'number' || !Number.isInteger(supRaw) || supRaw <= 0) {
        throw new HttpError(400, 'supersedesDecisionId must be a positive integer');
      }
      supersedesDecisionId = supRaw;
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    try {
      const decision = saveDecision(opts.hippoRoot, ctx.tenantId, {
        decisionText: text,
        context,
        supersedesDecisionId,
      }, ctx.actor.subject);
      sendJson(res, 201, { decision });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('not found') || msg.includes('not active')) {
        throw new HttpError(409, msg);
      }
      throw e;
    }
    return;
  }

  if (method === 'GET' && path === '/v1/decisions') {
    const status = query.get('status') ?? 'all';
    const limit = parseListLimit(query.get('limit'));
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    let decisions;
    if (status === 'all') {
      decisions = loadDecisions(opts.hippoRoot, ctx.tenantId, { limit });
    } else {
      if (!VALID_DECISION_STATES.has(status as DecisionStatus)) {
        throw new HttpError(400, `status must be one of: active | superseded | closed | all (got "${status}")`);
      }
      decisions = loadDecisions(opts.hippoRoot, ctx.tenantId, {
        status: status as DecisionStatus,
        limit,
      });
    }
    sendJson(res, 200, { decisions });
    return;
  }

  const decisionSupersedeMatch = path.match(/^\/v1\/decisions\/(\d+)\/supersede$/);
  if (method === 'POST' && decisionSupersedeMatch) {
    const oldId = parseInt(decisionSupersedeMatch[1], 10);
    const body = await parseJsonBody(req);
    const text = body['text'];
    if (typeof text !== 'string' || text.length === 0) {
      throw new HttpError(400, 'text is required (non-empty string)');
    }
    if (text.length > 4096) {
      throw new HttpError(400, 'text exceeds 4096-character cap');
    }
    const contextRaw = body['context'];
    let context: string | undefined;
    if (contextRaw !== undefined && contextRaw !== null) {
      if (typeof contextRaw !== 'string') {
        throw new HttpError(400, 'context must be a string');
      }
      if (contextRaw.length > 4096) {
        throw new HttpError(400, 'context exceeds 4096-character cap');
      }
      context = contextRaw;
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    try {
      const decision = saveDecision(opts.hippoRoot, ctx.tenantId, {
        decisionText: text,
        context,
        supersedesDecisionId: oldId,
      }, ctx.actor.subject);
      sendJson(res, 201, { decision });
    } catch (e) {
      const msg = (e as Error).message;
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

  const decisionCloseMatch = path.match(/^\/v1\/decisions\/(\d+)\/close$/);
  if (method === 'POST' && decisionCloseMatch) {
    const id = parseInt(decisionCloseMatch[1], 10);
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    try {
      const decision = closeDecision(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
      sendJson(res, 200, { decision });
    } catch (e) {
      const msg = (e as Error).message;
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

  const decisionByIdMatch = path.match(/^\/v1\/decisions\/(\d+)$/);
  if (method === 'GET' && decisionByIdMatch) {
    const id = parseInt(decisionByIdMatch[1], 10);
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
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
  if (method === 'POST' && path === '/v1/incidents') {
    const body = await parseJsonBody(req);
    const text = body['text'];
    if (typeof text !== 'string' || text.length === 0) {
      throw new HttpError(400, 'text is required (non-empty string)');
    }
    if (text.length > 4096) {
      throw new HttpError(400, 'text exceeds 4096-character cap');
    }
    const contextRaw = body['context'];
    let context: string | undefined;
    if (contextRaw !== undefined && contextRaw !== null) {
      if (typeof contextRaw !== 'string') {
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
      for (const item of linkedRaw) {
        if (typeof item !== 'string' || item.length === 0 || item.length > 4096) {
          throw new HttpError(400, 'each linkedMemoryIds entry must be a non-empty string <= 4096 chars');
        }
      }
      linkedMemoryIds = linkedRaw as string[];
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    try {
      const incident = saveIncident(opts.hippoRoot, ctx.tenantId, {
        incidentText: text,
        context,
        linkedMemoryIds,
      }, ctx.actor.subject);
      sendJson(res, 201, { incident });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('not found')) {
        throw new HttpError(409, msg);
      }
      throw e;
    }
    return;
  }

  if (method === 'GET' && path === '/v1/incidents') {
    const status = query.get('status') ?? 'all';
    const limit = parseListLimit(query.get('limit'));
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    let incidents;
    if (status === 'all') {
      incidents = loadIncidents(opts.hippoRoot, ctx.tenantId, { limit });
    } else {
      if (!VALID_INCIDENT_STATES.has(status as IncidentStatus)) {
        throw new HttpError(400, `status must be one of: open | resolved | closed | all (got "${status}")`);
      }
      incidents = loadIncidents(opts.hippoRoot, ctx.tenantId, {
        status: status as IncidentStatus,
        limit,
      });
    }
    sendJson(res, 200, { incidents });
    return;
  }

  const incidentResolveMatch = path.match(/^\/v1\/incidents\/(\d+)\/resolve$/);
  if (method === 'POST' && incidentResolveMatch) {
    const id = parseInt(incidentResolveMatch[1], 10);
    const body = await parseJsonBody(req);
    const resolutionText = body['resolutionText'];
    if (typeof resolutionText !== 'string' || resolutionText.trim().length === 0) {
      throw new HttpError(400, 'resolutionText is required (non-empty string)');
    }
    if (resolutionText.length > 4096) {
      throw new HttpError(400, 'resolutionText exceeds 4096-character cap');
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    try {
      const incident = resolveIncident(opts.hippoRoot, ctx.tenantId, id, resolutionText, ctx.actor.subject);
      sendJson(res, 200, { incident });
    } catch (e) {
      const msg = (e as Error).message;
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

  const incidentCloseMatch = path.match(/^\/v1\/incidents\/(\d+)\/close$/);
  if (method === 'POST' && incidentCloseMatch) {
    const id = parseInt(incidentCloseMatch[1], 10);
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    try {
      const incident = closeIncident(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
      sendJson(res, 200, { incident });
    } catch (e) {
      const msg = (e as Error).message;
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

  const incidentByIdMatch = path.match(/^\/v1\/incidents\/(\d+)$/);
  if (method === 'GET' && incidentByIdMatch) {
    const id = parseInt(incidentByIdMatch[1], 10);
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
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
  if (method === 'POST' && path === '/v1/processes') {
    const body = await parseJsonBody(req);
    const processName = body['processName'];
    if (typeof processName !== 'string' || processName.trim().length === 0) {
      throw new HttpError(400, 'processName is required (non-empty string)');
    }
    if (processName.length > 4096) {
      throw new HttpError(400, 'processName exceeds 4096-character cap');
    }
    const steps = validateProcessStepsBody(body['steps']);
    const descriptionRaw = body['description'];
    let description: string | undefined;
    if (descriptionRaw !== undefined && descriptionRaw !== null) {
      if (typeof descriptionRaw !== 'string') {
        throw new HttpError(400, 'description must be a string');
      }
      if (descriptionRaw.length > 4096) {
        throw new HttpError(400, 'description exceeds 4096-character cap');
      }
      description = descriptionRaw;
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const process = saveProcess(opts.hippoRoot, ctx.tenantId, {
      processName,
      steps,
      description,
    }, ctx.actor.subject);
    sendJson(res, 201, { process });
    return;
  }

  if (method === 'GET' && path === '/v1/processes') {
    const status = query.get('status') ?? 'all';
    const limit = parseListLimit(query.get('limit'));
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    let processes;
    if (status === 'all') {
      processes = loadProcesses(opts.hippoRoot, ctx.tenantId, { limit });
    } else {
      if (!VALID_PROCESS_STATES.has(status as ProcessStatus)) {
        throw new HttpError(400, `status must be one of: active | superseded | closed | all (got "${status}")`);
      }
      processes = loadProcesses(opts.hippoRoot, ctx.tenantId, {
        status: status as ProcessStatus,
        limit,
      });
    }
    sendJson(res, 200, { processes });
    return;
  }

  const processSupersedeMatch = path.match(/^\/v1\/processes\/(\d+)\/supersede$/);
  if (method === 'POST' && processSupersedeMatch) {
    const id = parseInt(processSupersedeMatch[1], 10);
    const body = await parseJsonBody(req);
    const steps = validateProcessStepsBody(body['steps']);
    if (steps.length === 0) {
      throw new HttpError(400, 'steps is required (at least one step) for a supersession');
    }
    const changeRaw = body['changeSummary'];
    let changeSummary: string | undefined;
    if (changeRaw !== undefined && changeRaw !== null) {
      if (typeof changeRaw !== 'string') {
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
      if (typeof descRaw !== 'string') {
        throw new HttpError(400, 'description must be a string');
      }
      if (descRaw.length > 4096) {
        throw new HttpError(400, 'description exceeds 4096-character cap');
      }
      description = descRaw;
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
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
      const msg = (e as Error).message;
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

  const processCloseMatch = path.match(/^\/v1\/processes\/(\d+)\/close$/);
  if (method === 'POST' && processCloseMatch) {
    const id = parseInt(processCloseMatch[1], 10);
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    try {
      const process = closeProcess(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
      sendJson(res, 200, { process });
    } catch (e) {
      const msg = (e as Error).message;
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

  const processByIdMatch = path.match(/^\/v1\/processes\/(\d+)$/);
  if (method === 'GET' && processByIdMatch) {
    const id = parseInt(processByIdMatch[1], 10);
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
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
  if (method === 'POST' && path === '/v1/policies') {
    const body = await parseJsonBody(req);
    const policyName = body['policyName'];
    if (typeof policyName !== 'string' || policyName.trim().length === 0) {
      throw new HttpError(400, 'policyName is required (non-empty string)');
    }
    if (policyName.length > 4096) {
      throw new HttpError(400, 'policyName exceeds 4096-character cap');
    }
    const policyText = body['policyText'];
    if (typeof policyText !== 'string' || policyText.trim().length === 0) {
      throw new HttpError(400, 'policyText is required (non-empty string)');
    }
    if (policyText.length > 4096) {
      throw new HttpError(400, 'policyText exceeds 4096-character cap');
    }
    const validFrom = optionalDateField(body['validFrom'], 'validFrom');
    const validTo = optionalDateField(body['validTo'], 'validTo');
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
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
      throw new HttpError(400, (e as Error).message);
    }
    return;
  }

  if (method === 'GET' && path === '/v1/policies') {
    const status = query.get('status') ?? 'all';
    const limit = parseListLimit(query.get('limit'));
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    let policies;
    if (status === 'all') {
      policies = loadPolicies(opts.hippoRoot, ctx.tenantId, { limit });
    } else {
      if (!VALID_POLICY_STATES.has(status as PolicyStatus)) {
        throw new HttpError(400, `status must be one of: active | superseded | closed | all (got "${status}")`);
      }
      policies = loadPolicies(opts.hippoRoot, ctx.tenantId, {
        status: status as PolicyStatus,
        limit,
      });
    }
    sendJson(res, 200, { policies });
    return;
  }

  // The as-of query: must precede the /:id GET (literal 'asof' is non-numeric so
  // the /(\d+)/ route would not match it, but order it first for clarity).
  if (method === 'GET' && path === '/v1/policies/asof') {
    const date = query.get('date');
    if (date === null || date.length === 0) {
      throw new HttpError(400, 'date is required (ISO-8601 valid-time)');
    }
    const name = query.get('name') ?? undefined;
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    try {
      const policies = loadPoliciesAsOf(opts.hippoRoot, ctx.tenantId, date, { name });
      sendJson(res, 200, { policies });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    return;
  }

  const policySupersedeMatch = path.match(/^\/v1\/policies\/(\d+)\/supersede$/);
  if (method === 'POST' && policySupersedeMatch) {
    const id = parseInt(policySupersedeMatch[1], 10);
    const body = await parseJsonBody(req);
    const policyText = body['policyText'];
    if (typeof policyText !== 'string' || policyText.trim().length === 0) {
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
      if (typeof changeRaw !== 'string') {
        throw new HttpError(400, 'changeSummary must be a string');
      }
      if (changeRaw.length > 4096) {
        throw new HttpError(400, 'changeSummary exceeds 4096-character cap');
      }
      changeSummary = changeRaw;
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
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
      const msg = (e as Error).message;
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

  const policyCloseMatch = path.match(/^\/v1\/policies\/(\d+)\/close$/);
  if (method === 'POST' && policyCloseMatch) {
    const id = parseInt(policyCloseMatch[1], 10);
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    try {
      const policy = closePolicy(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
      sendJson(res, 200, { policy });
    } catch (e) {
      const msg = (e as Error).message;
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

  const policyByIdMatch = path.match(/^\/v1\/policies\/(\d+)$/);
  if (method === 'GET' && policyByIdMatch) {
    const id = parseInt(policyByIdMatch[1], 10);
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
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
  if (method === 'POST' && path === '/v1/skills') {
    const body = await parseJsonBody(req);
    const skillName = body['skillName'];
    if (typeof skillName !== 'string' || skillName.trim().length === 0) {
      throw new HttpError(400, 'skillName is required (non-empty string)');
    }
    if (skillName.length > 256) {
      throw new HttpError(400, 'skillName exceeds 256-character cap');
    }
    const instructions = body['instructions'];
    if (typeof instructions !== 'string' || instructions.trim().length === 0) {
      throw new HttpError(400, 'instructions are required (non-empty string)');
    }
    if (instructions.length > 8192) {
      throw new HttpError(400, 'instructions exceed 8192-character cap');
    }
    const triggerRaw = body['trigger'];
    let trigger: string | undefined;
    if (triggerRaw !== undefined && triggerRaw !== null) {
      if (typeof triggerRaw !== 'string') {
        throw new HttpError(400, 'trigger must be a string');
      }
      if (triggerRaw.length > 1024) {
        throw new HttpError(400, 'trigger exceeds 1024-character cap');
      }
      trigger = triggerRaw;
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    try {
      const skill = saveSkill(opts.hippoRoot, ctx.tenantId, {
        skillName,
        instructions,
        trigger,
      }, ctx.actor.subject);
      sendJson(res, 201, { skill });
    } catch (e) {
      // saveSkill throws on validation (single-line name etc.) -> 400.
      throw new HttpError(400, (e as Error).message);
    }
    return;
  }

  if (method === 'GET' && path === '/v1/skills') {
    const status = query.get('status') ?? 'all';
    const limit = parseListLimit(query.get('limit'));
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    let skills;
    if (status === 'all') {
      skills = loadSkills(opts.hippoRoot, ctx.tenantId, { limit });
    } else {
      if (!VALID_SKILL_STATES.has(status as SkillStatus)) {
        throw new HttpError(400, `status must be one of: active | superseded | closed | all (got "${status}")`);
      }
      skills = loadSkills(opts.hippoRoot, ctx.tenantId, {
        status: status as SkillStatus,
        limit,
      });
    }
    sendJson(res, 200, { skills });
    return;
  }

  // The export renderer: must precede the /:id GET (literal 'export' is
  // non-numeric so the /(\d+)/ route would not match it, but order it first).
  if (method === 'GET' && path === '/v1/skills/export') {
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const markdown = exportSkills(opts.hippoRoot, ctx.tenantId);
    sendJson(res, 200, { markdown });
    return;
  }

  const skillSupersedeMatch = path.match(/^\/v1\/skills\/(\d+)\/supersede$/);
  if (method === 'POST' && skillSupersedeMatch) {
    const id = parseInt(skillSupersedeMatch[1], 10);
    const body = await parseJsonBody(req);
    const instructions = body['instructions'];
    if (typeof instructions !== 'string' || instructions.trim().length === 0) {
      throw new HttpError(400, 'instructions are required (non-empty string)');
    }
    if (instructions.length > 8192) {
      throw new HttpError(400, 'instructions exceed 8192-character cap');
    }
    const triggerRaw = body['trigger'];
    let trigger: string | undefined;
    if (triggerRaw !== undefined && triggerRaw !== null) {
      if (typeof triggerRaw !== 'string') {
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
      if (typeof changeRaw !== 'string') {
        throw new HttpError(400, 'changeSummary must be a string');
      }
      if (changeRaw.length > 4096) {
        throw new HttpError(400, 'changeSummary exceeds 4096-character cap');
      }
      changeSummary = changeRaw;
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
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
      const msg = (e as Error).message;
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

  const skillCloseMatch = path.match(/^\/v1\/skills\/(\d+)\/close$/);
  if (method === 'POST' && skillCloseMatch) {
    const id = parseInt(skillCloseMatch[1], 10);
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    try {
      const skill = closeSkill(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
      sendJson(res, 200, { skill });
    } catch (e) {
      const msg = (e as Error).message;
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

  const skillByIdMatch = path.match(/^\/v1\/skills\/(\d+)$/);
  if (method === 'GET' && skillByIdMatch) {
    const id = parseInt(skillByIdMatch[1], 10);
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const skill = loadSkillById(opts.hippoRoot, ctx.tenantId, id);
    if (!skill) {
      throw new HttpError(404, `skill ${id} not found`);
    }
    sendJson(res, 200, { skill });
    return;
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
  if (method === 'POST' && path === '/v1/project-briefs') {
    const body = await parseJsonBody(req);
    const repo = body['repo'];
    if (typeof repo !== 'string' || repo.trim().length === 0) {
      throw new HttpError(400, 'repo is required (non-empty string)');
    }
    if (repo.length > 256) {
      throw new HttpError(400, 'repo exceeds 256-character cap');
    }
    const summary = body['summary'];
    if (typeof summary !== 'string' || summary.trim().length === 0) {
      throw new HttpError(400, 'summary is required (non-empty string)');
    }
    if (summary.length > 8192) {
      throw new HttpError(400, 'summary exceeds 8192-character cap');
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    try {
      const brief = saveProjectBrief(opts.hippoRoot, ctx.tenantId, {
        repo,
        summary,
      }, ctx.actor.subject);
      sendJson(res, 201, { brief });
    } catch (e) {
      // saveProjectBrief throws on validation (single-line repo etc.) -> 400.
      throw new HttpError(400, (e as Error).message);
    }
    return;
  }

  if (method === 'GET' && path === '/v1/project-briefs') {
    const status = query.get('status') ?? 'all';
    const repoFilter = query.get('repo');
    const limit = parseListLimit(query.get('limit'));
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const listOpts: { status?: BriefStatus; repo?: string; limit: number } = { limit };
    if (repoFilter !== null && repoFilter.trim().length > 0) {
      listOpts.repo = repoFilter.trim();
    }
    if (status !== 'all') {
      if (!VALID_BRIEF_STATES.has(status as BriefStatus)) {
        throw new HttpError(400, `status must be one of: active | superseded | closed | all (got "${status}")`);
      }
      listOpts.status = status as BriefStatus;
    }
    const briefs = loadProjectBriefs(opts.hippoRoot, ctx.tenantId, listOpts);
    sendJson(res, 200, { briefs });
    return;
  }

  // The refresh op: must precede the /:id routes (literal 'refresh' is non-numeric
  // so the /(\d+)/ routes would not match it, but order it first).
  if (method === 'POST' && path === '/v1/project-briefs/refresh') {
    const body = await parseJsonBody(req);
    const repo = body['repo'];
    if (typeof repo !== 'string' || repo.trim().length === 0) {
      throw new HttpError(400, 'repo is required (non-empty string)');
    }
    if (repo.length > 256) {
      throw new HttpError(400, 'repo exceeds 256-character cap');
    }
    const dryRun = body['dryRun'] === true;
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
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
      const msg = (e as Error).message;
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

  const briefSupersedeMatch = path.match(/^\/v1\/project-briefs\/(\d+)\/supersede$/);
  if (method === 'POST' && briefSupersedeMatch) {
    const id = parseInt(briefSupersedeMatch[1], 10);
    const body = await parseJsonBody(req);
    const summary = body['summary'];
    if (typeof summary !== 'string' || summary.trim().length === 0) {
      throw new HttpError(400, 'summary is required (non-empty string)');
    }
    if (summary.length > 8192) {
      throw new HttpError(400, 'summary exceeds 8192-character cap');
    }
    const changeRaw = body['changeSummary'];
    let changeSummary: string | undefined;
    if (changeRaw !== undefined && changeRaw !== null) {
      if (typeof changeRaw !== 'string') {
        throw new HttpError(400, 'changeSummary must be a string');
      }
      if (changeRaw.length > 4096) {
        throw new HttpError(400, 'changeSummary exceeds 4096-character cap');
      }
      changeSummary = changeRaw;
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
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
      const msg = (e as Error).message;
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

  const briefCloseMatch = path.match(/^\/v1\/project-briefs\/(\d+)\/close$/);
  if (method === 'POST' && briefCloseMatch) {
    const id = parseInt(briefCloseMatch[1], 10);
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    try {
      const brief = closeProjectBrief(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
      sendJson(res, 200, { brief });
    } catch (e) {
      const msg = (e as Error).message;
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

  const briefByIdMatch = path.match(/^\/v1\/project-briefs\/(\d+)$/);
  if (method === 'GET' && briefByIdMatch) {
    const id = parseInt(briefByIdMatch[1], 10);
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
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
  if (method === 'POST' && path === '/v1/customer-notes') {
    const body = await parseJsonBody(req);
    const customer = body['customer'];
    if (typeof customer !== 'string' || customer.trim().length === 0) {
      throw new HttpError(400, 'customer is required (non-empty string)');
    }
    if (customer.length > 256) {
      throw new HttpError(400, 'customer exceeds 256-character cap');
    }
    const note = body['note'];
    if (typeof note !== 'string' || note.trim().length === 0) {
      throw new HttpError(400, 'note is required (non-empty string)');
    }
    if (note.length > 8192) {
      throw new HttpError(400, 'note exceeds 8192-character cap');
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    try {
      const customerNote = saveCustomerNote(opts.hippoRoot, ctx.tenantId, {
        customer,
        note,
      }, ctx.actor.subject);
      sendJson(res, 201, { note: customerNote });
    } catch (e) {
      // saveCustomerNote throws on validation (single-line customer etc.) -> 400.
      throw new HttpError(400, (e as Error).message);
    }
    return;
  }

  if (method === 'GET' && path === '/v1/customer-notes') {
    const status = query.get('status') ?? 'all';
    const customerFilter = query.get('customer');
    const limit = parseListLimit(query.get('limit'));
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const listOpts: { status?: NoteStatus; customer?: string; limit: number } = { limit };
    if (customerFilter !== null && customerFilter.trim().length > 0) {
      listOpts.customer = customerFilter.trim();
    }
    if (status !== 'all') {
      if (!VALID_NOTE_STATES.has(status as NoteStatus)) {
        throw new HttpError(400, `status must be one of: active | superseded | closed | all (got "${status}")`);
      }
      listOpts.status = status as NoteStatus;
    }
    const notes = loadCustomerNotes(opts.hippoRoot, ctx.tenantId, listOpts);
    sendJson(res, 200, { notes });
    return;
  }

  const noteSupersedeMatch = path.match(/^\/v1\/customer-notes\/(\d+)\/supersede$/);
  if (method === 'POST' && noteSupersedeMatch) {
    const id = parseInt(noteSupersedeMatch[1], 10);
    const body = await parseJsonBody(req);
    const note = body['note'];
    if (typeof note !== 'string' || note.trim().length === 0) {
      throw new HttpError(400, 'note is required (non-empty string)');
    }
    if (note.length > 8192) {
      throw new HttpError(400, 'note exceeds 8192-character cap');
    }
    const changeRaw = body['changeSummary'];
    let changeSummary: string | undefined;
    if (changeRaw !== undefined && changeRaw !== null) {
      if (typeof changeRaw !== 'string') {
        throw new HttpError(400, 'changeSummary must be a string');
      }
      if (changeRaw.length > 4096) {
        throw new HttpError(400, 'changeSummary exceeds 4096-character cap');
      }
      changeSummary = changeRaw;
    }
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
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
      const msg = (e as Error).message;
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

  const noteCloseMatch = path.match(/^\/v1\/customer-notes\/(\d+)\/close$/);
  if (method === 'POST' && noteCloseMatch) {
    const id = parseInt(noteCloseMatch[1], 10);
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    try {
      const customerNote = closeCustomerNote(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
      sendJson(res, 200, { note: customerNote });
    } catch (e) {
      const msg = (e as Error).message;
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

  const noteByIdMatch = path.match(/^\/v1\/customer-notes\/(\d+)$/);
  if (method === 'GET' && noteByIdMatch) {
    const id = parseInt(noteByIdMatch[1], 10);
    const ctx = buildContextWithAuth(req, opts.hippoRoot);
    const customerNote = loadCustomerNoteById(opts.hippoRoot, ctx.tenantId, id);
    if (!customerNote) {
      throw new HttpError(404, `customer note ${id} not found`);
    }
    sendJson(res, 200, { note: customerNote });
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
      // v1.12.6 (B4): parse-failure tenant attribution. Pre-fix this path
      // wrote tenant_id=HIPPO_TENANT regardless of the originating workspace,
      // silently routing parse failures from workspace A into the deployment's
      // tenant DLQ. Fix: use the regex-extracted teamIdFromRaw to resolve
      // tenant via the same slack_workspaces table the happy path uses
      // (resolveTenantForTeam at line ~1044). When teamIdFromRaw is null
      // (totally unparseable body) OR the team is unknown, write with
      // tenantId=null so the row lands as '__unroutable__' (matching the
      // existing unroutable bucket convention).
      const db = openHippoDb(opts.hippoRoot);
      try {
        const parseFailTenant =
          teamIdFromRaw !== null ? resolveTenantForTeam(db, teamIdFromRaw) : null;
        writeToDlq(db, {
          tenantId: parseFailTenant, // null → '__unroutable__' sentinel
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
      actor: adminActor('connector:slack'),
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
      actor: adminActor('connector:github'),
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
        // v1.12.0: McpContext.actor stays string; extract subject at the boundary.
        actor: ctx.actor.subject,
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

  // E3: per-IP rate limiter for /v1/*. Built here (not at module scope) so
  // HIPPO_V1_RPS is read at boot, matching HIPPO_PORT above and letting a test
  // set the rate before serve(). A non-positive or non-finite value disables
  // limiting (the opt-out knob).
  const v1Rps = Number(process.env.HIPPO_V1_RPS ?? 20);
  const limiter: RateLimiter | undefined =
    Number.isFinite(v1Rps) && v1Rps > 0
      ? createRateLimiter({ ratePerSec: v1Rps, burst: v1Rps * 2, idleEvictMs: 60000, maxKeys: 10000 })
      : undefined;

  const server: Server = createServer((req, res) => {
    handleRequest(req, res, opts, startedAt, limiter).catch((err: unknown) => {
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
