import { envPort, envRequireAuth, envV1Rps } from './env.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { detectServer, removePidfileIfOwned, writePidfile } from './server-detect.js';
import { closeHippoDb, type DatabaseSyncLike, getHippoDbPath, isStoreBusy, openHippoDb, SERVER_DB_WAIT_MS, withBusyWait, withSqliteBlocked } from './db.js';
import { sqliteStore, type HippoStore } from './store-port.js';
import { auditWriteFailureCount } from './audit.js';
import { PACKAGE_VERSION } from './version.js';
import { errorFields, log } from './log.js';
import { createRateLimiter, type RateLimiter } from './rate-limit.js';
import { type Actor, authRevoke, type Context, RecallContractError } from './api.js';
import { handleSlackEventsWebhook } from './connectors/slack/webhook.js';
import { handleGitHubEventsWebhook } from './connectors/github/webhook.js';
import { BodyTooLargeError, HttpError, JSON_HEADERS, sendJson } from './http-util.js';
import { ForbiddenError } from './api-errors.js';
import { buildContextWithAuth, isLoopback, requireAuth } from './server/auth.js';
import { enforceRateLimit } from './server/client-ip.js';
import { drainAndClose } from './server/lifecycle.js';
import { handleMcpPost, handleMcpStream } from './server/mcp-http.js';
import { logRequestFailure, matchPath, parseRequest, rejectEncodedSlash, replyFor, requestIds, resolveRequestId, sendError } from './server/request.js';
import { handleApproveQuarantine, handleCreateAuthKey, handleListAudit, handleListAuthKeys, handleListQuarantine, handleRejectQuarantine, handleRevokeAuthKey } from './server/routes/admin.js';
import { handleCloseCustomerNote, handleCreateCustomerNote, handleGetCustomerNote, handleListCustomerNotes, handleSupersedeCustomerNote } from './server/routes/customer-notes.js';
import { handleCloseDecision, handleCreateDecision, handleGetDecision, handleListDecisions, handleSupersedeDecision } from './server/routes/decisions.js';
import { handleCloseIncident, handleCreateIncident, handleGetIncident, handleListIncidents, handleResolveIncident } from './server/routes/incidents.js';
import { handleApplyOutcome, handleArchiveMemory, handleCreateMemory, handleForgetMemory, handleGetGraph, handlePromoteMemory, handleSleep, handleSupersedeMemory } from './server/routes/memories.js';
import { handleClosePolicy, handleCreatePolicy, handleGetPolicy, handleListPolicies, handlePoliciesAsOf, handleSupersedePolicy } from './server/routes/policies.js';
import { handleClosePrediction, handleCreatePrediction, handleGetPrediction, handleListPredictions, handlePredictionStats } from './server/routes/predictions.js';
import { handleCloseProcess, handleCreateProcess, handleGetProcess, handleListProcesses, handleSupersedeProcess } from './server/routes/processes.js';
import { handleCloseProjectBrief, handleCreateProjectBrief, handleGetProjectBrief, handleListProjectBriefs, handleRefreshProjectBrief, handleSupersedeProjectBrief } from './server/routes/project-briefs.js';
import { handleAssembleSession, handleDrillRecall, handleGetContext, handleRecallMemories } from './server/routes/recall.js';
import { handleCloseSkill, handleCreateSkill, handleExportSkills, handleGetSkill, handleListSkills, handleSupersedeSkill } from './server/routes/skills.js';
import { parseJsonBody } from './server/validation.js';
import type { AddonRoute, ResolvedServeOpts, Route, RouteRequest, ServeOpts, ServerHandle } from './server/types.js';

// Add-on packages revoke keys through these without importing the whole api surface.
export { authRevoke, ForbiddenError, type Context, type Actor };
// Published on the hippo-memory/server subpath before they moved to http-util.ts, so they stay exported here.
export { isCrossSite, LOOPBACK_HOST_HEADER } from './http-util.js';
// The code behind these lives in src/server/; this subpath keeps exporting them.
export { __resetSessionRecallHistoryHttp } from './server/routes/recall.js';
export { clientIpForRateLimit } from './server/client-ip.js';
export { isLoopback, isReservedActor } from './server/auth.js';
export type { AddonCall, AddonRoute, AuthResolver, ResolvedBearer, ServeOpts, ServerHandle } from './server/types.js';
// What an add-on route handler needs: HttpError for its 4xx replies, promptHookContext for a caller that renders the prompt hook elsewhere, JsonValue for its body.
export { HttpError } from './http-util.js';
export { promptHookContext } from './prompt-hook.js';
export type { JsonValue } from './json.js';
// An add-on serves from another database by passing serve() its own HippoStore.
export { sqliteStore, type HippoStore } from './store-port.js';
export type { ApiKeyRecord } from './auth.js';
export { StoreBusyError } from './db.js';

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

// server.address() returns AddressInfo once a TCP socket is bound; null before
// listening, a string only for pipe/unix-socket listeners (never used here).
function isAddressInfo(
  a: string | import('node:net').AddressInfo | null,
): a is import('node:net').AddressInfo {
  return a !== null && typeof a !== 'string';
}

// Pinned at module load. Bumped alongside package.json on releases. The
// HTTP /health response uses this; reading package.json synchronously here
// would couple the daemon to its on-disk install path, which we want to
// avoid for tests that mkdtemp a hippoRoot.
const VERSION = PACKAGE_VERSION;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

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

/** The route's handler bound to this request's path params, or null when method or path differ. The matcher runs before the
 *  method check, as the inline route blocks did, so a malformed `%` escape still throws from matchPath on any method. */
function routeMatches(route: Route, method: string, path: string): ((r: RouteRequest) => Promise<void>) | null {
  if ('path' in route) return method === route.method && path === route.path ? route.handler : null;
  if ('pattern' in route) {
    const params = matchPath(route.pattern, path);
    return method === route.method && params ? (r) => route.handler(r, params) : null;
  }
  const match = path.match(route.regex);
  return method === route.method && match ? (r) => route.handler(r, match) : null;
}

/** Run the first /v1 route whose method and path match. */
async function dispatchV1Route(r: RouteRequest, method: string, path: string): Promise<boolean> {
  for (const route of V1_ROUTES) {
    const run = routeMatches(route, method, path);
    if (run === null) continue;
    if (!route.storeReady) await refuseUnportedRoute(r.req, r.opts);
    await run(r);
    return true;
  }
  return false;
}

const ADDON_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;

// A path with only ADDON_SEGMENT_RE characters never holds a `%`, so matchPath cannot throw here.
function isCorePostPath(path: string): boolean {
  return PUBLIC_ROUTES.has(`POST ${path}`) || V1_ROUTES.some((route) => routeMatches(route, 'POST', path) !== null);
}

/** Boot-time check: an add-on path must be plain, unique and not one core serves, so no add-on shadows a core route or hides from dispatch. */
function assertAddonRoutes(routes: readonly AddonRoute[]): void {
  const seen = new Set<string>();
  for (const { path } of routes) {
    const plain = path.startsWith('/v1/') && new URL(path, 'http://h').pathname === path
      && path.slice('/v1/'.length).split('/').every((segment) => ADDON_SEGMENT_RE.test(segment));
    if (!plain) throw new Error(`add-on route '${path}' is not a plain /v1/ path (segments use A-Z a-z 0-9 . _ ~ -)`);
    if (seen.has(path)) throw new Error(`add-on route '${path}' is registered twice`);
    if (isCorePostPath(path)) throw new Error(`add-on route '${path}' is already served by core`);
    seen.add(path);
  }
}

/** Core authenticates and parses before the handler runs, so an add-on route gets the same 401, 400 and 501 as a core one. */
async function dispatchAddonRoute({ req, res, opts }: RouteRequest, method: string, path: string): Promise<boolean> {
  const route = method === 'POST' ? opts.routes?.find((r) => r.path === path) : undefined;
  if (!route) return false;
  await refuseUnportedRoute(req, opts);
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  sendJson(res, 200, await route.handler({ ctx, body }));
  return true;
}

const NOT_ON_STORE_MESSAGE = 'not available on this store';

function assertSqliteStore(opts: ResolvedServeOpts): void {
  if (opts.store.kind !== 'sqlite') throw new HttpError(501, NOT_ON_STORE_MESSAGE);
}

/** Under another store, a route not yet ported answers 501 without running; the caller is checked first, so a bad key is still a 401. */
async function refuseUnportedRoute(req: IncomingMessage, opts: ResolvedServeOpts): Promise<void> {
  if (opts.store.kind === 'sqlite') return;
  await requireAuth(req, opts);
  assertSqliteStore(opts);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ResolvedServeOpts,
  startedAt: string,
  streamSlots: Map<string, number>,
  limiter?: RateLimiter,
): Promise<void> {
  // Pre-decode raw-URL slash check. Catches `%2F` / `%2f` before
  // Node's URL parser collapses them and they slip past the route table.
  rejectEncodedSlash(req.url ?? '/');

  const { method, path, query } = parseRequest(req);

  if (method === 'GET' && path === '/health') {
    sendHealth(req, res, startedAt);
    return;
  }

  enforceRateLimit(req, path, limiter);

  const routeRequest: RouteRequest = { req, res, opts, query };
  if (await dispatchV1Route(routeRequest, method, path)) return;
  if (await dispatchAddonRoute(routeRequest, method, path)) return;

  if (method === 'POST' && path === '/v1/connectors/slack/events') {
    // Bearer auth deliberately skipped: this route is in PUBLIC_ROUTES and authenticates via the Slack HMAC signature.
    if (!isPublicRoute(method, path)) {
      // Defensive: PUBLIC_ROUTES drift would land here. Fail closed.
      throw new HttpError(401, 'auth required');
    }
    assertSqliteStore(opts);
    await handleSlackEventsWebhook({ req, res, opts });
    return;
  }

  if (method === 'POST' && path === '/v1/connectors/github/events') {
    if (!isPublicRoute(method, path)) {
      throw new HttpError(401, 'auth required');
    }
    assertSqliteStore(opts);
    await handleGitHubEventsWebhook({ req, res, opts });
    return;
  }

  if (method === 'POST' && path === '/mcp') {
    await refuseUnportedRoute(req, opts);
    await handleMcpPost(req, res, opts);
    return;
  }

  // Store-ready: the stream and its heartbeat only authenticate, and auth goes through the port.
  if (method === 'GET' && path === '/mcp/stream') {
    await handleMcpStream(req, res, opts, streamSlots);
    return;
  }

  res.writeHead(404, JSON_HEADERS);
  res.end(JSON.stringify({ error: 'not found' }));
}

function sendHealth(req: IncomingMessage, res: ServerResponse, startedAt: string): void {
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
      audit_write_failures: auditWriteFailureCount(),
    });
  } else {
    sendJson(res, 200, { ok: true });
  }
}

function assertBindable(host: string): void {
  if (!LOOPBACK_HOSTS.has(host) && !envRequireAuth()) {
    throw new Error(
      `Refusing to bind hippo serve to non-loopback host '${host}' without auth. ` +
      `Set HIPPO_REQUIRE_AUTH=1 to bind non-loopback; every request then requires ` +
      `a valid API key. Bind to 127.0.0.1 / ::1 / localhost otherwise.`,
    );
  }
}

async function assertNoLiveServer(hippoRoot: string): Promise<void> {
  // Refuse to start if a live hippo server already serves this hippoRoot.
  // detectServer probes the recorded /health — a stale pidfile is unlinked and
  // ignored, but a live peer means a concurrent `hippo serve` would race for
  // the port and clobber the pidfile.
  const existing = await detectServer(hippoRoot);
  if (existing) {
    throw new Error(
      `hippo serve: already running on port ${existing.port} (pid ${existing.pid}). ` +
      `Stop that server before starting another on the same hippoRoot.`,
    );
  }
}

function bootRateLimiter(): RateLimiter | undefined {
  // Per-IP rate limiter for /v1/* and /mcp*. Built here (not at module scope) so
  // HIPPO_V1_RPS is read at boot, matching HIPPO_PORT above and letting a test
  // set the rate before serve(). A non-positive or non-finite value disables
  // limiting (the opt-out knob).
  const v1Rps = Number(envV1Rps() ?? 20);
  return Number.isFinite(v1Rps) && v1Rps > 0
    ? createRateLimiter({ ratePerSec: v1Rps, burst: v1Rps * 2, idleEvictMs: 60000, maxKeys: 10000 })
    : undefined;
}

interface StoreHolder {
  hold: () => void;
  release: () => void;
}

function createStoreHolder(hippoRoot: string, store: HippoStore): StoreHolder {
  if (store.kind !== 'sqlite') {
    log.info(`serve: the '${store.kind}' store serves ${hippoRoot}, so no hippo.db connection is held`);
    return { hold: () => {}, release: () => {} };
  }
  // Handlers open and close their own connections; while this one is held, none of those closes is SQLite's last,
  // which checkpoints and deletes the WAL. It opens only once the store exists, so serving never creates one.
  let heldDb: DatabaseSyncLike | undefined;
  let stopHolding = false;
  const hold = (): void => {
    if (heldDb || stopHolding || !existsSync(getHippoDbPath(hippoRoot))) return;
    try {
      heldDb = openHippoDb(hippoRoot);
    } catch (err) {
      stopHolding = true;
      log.warn(`serve: could not hold a store connection; requests still work, only slower: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const release = (): void => {
    stopHolding = true;
    if (heldDb) closeHippoDb(heldDb);
    heldDb = undefined;
  };
  return { hold, release };
}

function replyWithFailure<E>(req: IncomingMessage, res: ServerResponse, err: E, requestId: string): void {
  const mapped = replyFor(err);
  logRequestFailure(req, err, requestId, mapped.status);
  if (res.headersSent) {
    try { res.end(); } catch { /* socket already gone */ }
    return;
  }
  if (isStoreBusy(err)) res.setHeader('Retry-After', '1');
  if (mapped.status === 500) {
    // The id lets an operator find the logged cause without the client seeing internal text.
    sendJson(res, 500, { error: mapped.message, requestId });
    return;
  }
  // RecallContractError keeps the shared {error} shape and adds `code` so clients branch without parsing prose.
  if (err instanceof RecallContractError) {
    sendJson(res, 400, { error: err.message, code: err.code });
    return;
  }
  sendError(res, mapped.status, mapped.message);
  // readBody hit the 1 MB cap mid-stream, so drop the socket rather than drain unbounded bytes.
  if (err instanceof BodyTooLargeError) req.destroy();
}

function replyOrClose<E>(req: IncomingMessage, res: ServerResponse, err: E, requestId: string): void {
  try {
    replyWithFailure(req, res, err, requestId);
  } catch (replyErr) {
    // A throw here would be an unhandled rejection, which stops the daemon for every caller.
    log.error(`serve: failure reply not sent, socket closed: ${replyErr instanceof Error ? replyErr.message : String(replyErr)}`, { requestId });
    res.destroy();
  }
}

function setKeepAliveTimeouts(server: Server): void {
  // The default 5s keepAliveTimeout closes idle sockets just as clients reuse them (ECONNRESET).
  // headersTimeout must stay ABOVE keepAliveTimeout + keepAliveTimeoutBuffer (1s), or it closes idle reused sockets itself.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
}

function listenOn(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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
    server.listen(port, host);
  });
}

function installSignalHandlers(stop: () => Promise<void>): void {
  let shuttingDown = false;
  const gracefulShutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn(`received ${signal}, shutting down`);
    try {
      await stop();
      process.exit(0);
    } catch (err) {
      log.error(`error during stop: ${err instanceof Error ? err.message : String(err)}`, errorFields(err));
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
  process.once('SIGINT', () => { void gracefulShutdown('SIGINT'); });
}

/**
 * Boot the HTTP daemon on host:port and write the pidfile under hippoRoot.
 *
 * Refuses non-loopback hosts at boot unless
 * HIPPO_REQUIRE_AUTH=1 is set. The auth middleware (buildContextWithAuth /
 * requireAuth) has shipped and every route checks it except GET /health
 * (public by design for platform health checks) and the two connector
 * webhooks in PUBLIC_ROUTES, which are HMAC-gated by their own signing
 * secrets and 404 when those secrets are unset. But the loopback
 * no-auth fallback inside buildContextWithAuth still admits unauthenticated
 * requests from a loopback remote address (unless they carry Forwarded,
 * X-Forwarded-For/-Host/-Proto, X-Real-IP, Cf-Connecting-Ip or True-Client-Ip, which mark a same-host proxy and get
 * a 401 like any keyless remote request), so binding to a non-loopback host
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
  const requestedPort = opts.port ?? Number(envPort() ?? 6789);

  // A frozen copy, so a route the caller adds or renames after boot never skips the check below.
  const routes = Object.freeze((opts.routes ?? []).map(({ path, handler }) => Object.freeze({ path, handler })));
  assertAddonRoutes(routes);
  assertBindable(host);
  await assertNoLiveServer(opts.hippoRoot);

  // The server's start time. Single source of truth: it is returned by every
  // GET /health response and (below) written into the pidfile, so detectServer
  // can match the two and prove a pid-reusing impostor is not the real server.
  const startedAt = new Date().toISOString();

  const limiter = bootRateLimiter();

  // Open /mcp/stream count per client key, so the cap is per server rather than per process.
  const streamSlots = new Map<string, number>();

  const served: ResolvedServeOpts = { ...opts, routes, store: opts.store ?? sqliteStore(opts.hippoRoot) };
  const { kind } = served.store;
  const holder = createStoreHolder(opts.hippoRoot, served.store);

  const inflight = new Set<ServerResponse>();
  const server: Server = createServer((req, res) => {
    res.once('finish', holder.hold);
    inflight.add(res);
    res.once('close', () => inflight.delete(res));
    const requestId = resolveRequestId(req.headers['x-request-id']);
    requestIds.set(req, requestId);
    res.setHeader('X-Request-Id', requestId);
    const run = (): Promise<void> => withBusyWait(SERVER_DB_WAIT_MS, () => handleRequest(req, res, served, startedAt, streamSlots, limiter));
    // A missed port under another store would otherwise create and write a hippo.db that store never reads.
    (kind === 'sqlite' ? run() : withSqliteBlocked(kind, run)).catch(<E>(err: E) => replyOrClose(req, res, err, requestId));
  });

  setKeepAliveTimeouts(server);

  await listenOn(server, requestedPort, host);

  const address = server.address();
  if (!isAddressInfo(address)) {
    throw new Error('server.address() returned unexpected shape');
  }
  const addressInfo = address;
  const actualPort = addressInfo.port;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${actualPort}`;

  writePidfile(opts.hippoRoot, { port: actualPort, url, startedAt });
  holder.hold();

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    // Remove the pidfile only if it still names this server. A newer server
    // may have started on this hippoRoot and rewritten the pidfile; an
    // unconditional unlink here would orphan it.
    removePidfileIfOwned(opts.hippoRoot, { pid: process.pid, startedAt });
    await drainAndClose(server, inflight, opts.shutdownDrainMs ?? 5000);
    holder.release();
    if (!opts.store) await served.store.close();
  };

  if (opts.handleSignals) installSignalHandlers(stop);

  return { port: actualPort, url, stop, server };
}
