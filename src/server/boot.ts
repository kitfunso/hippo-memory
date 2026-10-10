import { envPort, envRequireAuth, envV1Rps } from '../util/env.js';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { detectServer, removePidfileIfOwned, writePidfile } from './server-detect.js';
import {
  closeHippoDb,
  type DatabaseSyncLike,
  getHippoDbPath,
  isStoreBusy,
  openHippoDb,
  outsideRequestStores,
  outsideSqliteOffLoop,
  runWithRequestStores,
  SERVER_DB_WAIT_MS,
  withSqliteBlocked
} from '../db/index.js';
import { startWalCheckpointer, type WalCheckpointer } from '../db/wal-checkpointer.js';
import { requireGroup, type HippoStore } from '../store/index.js';
import { workerSqliteStore } from '../store/sqlite/worker-store.js';
import { markSharedStore } from '../core/config.js';
import { auditWriteFailureCount } from '../store/audit.js';
import { PACKAGE_VERSION } from '../util/version.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import { runWithRequestId } from '../util/request-scope.js';
import { createRateLimiter, type RateLimiter } from './rate-limit.js';
import { RecallContractError } from '../api/index.js';
import { handleSlackEventsWebhook } from '../connectors/slack/webhook.js';
import { handleGitHubEventsWebhook } from '../connectors/github/webhook.js';
import { BodyTimeoutError, BodyTooLargeError, closeAfterReply, DeadlineExceededError, HttpError, JSON_HEADERS, sendJson } from '../util/http-util.js';
import { workerCounts } from '../store/sqlite/executor-counts.js';
import { isLocalCaller, LIMITER_MAX_KEYS } from './auth.js';
import { enforceRateLimit, warnIfClientIpHeaderUnpinned } from './client-ip.js';
import { answerAtDeadline, handlerDeadlineCount, isAbandoned, requestDeadlineFor } from './deadline.js';
import { DEFAULT_SHUTDOWN_DRAIN_MS, drainAndClose, setKeepAliveTimeouts, shutdownBoundMs } from './lifecycle.js';
import { readyProbeFor } from './ready.js';
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from './defaults.js';
import { installCrashHandlers, installSignalHandlers } from '../util/crash-handlers.js';
import { handleMcpPost, handleMcpStream } from './mcp-http.js';
import { MCP_PROJECT_SCOPED_HEADER } from '../core/project-identity.js';
import { accessRouteOf, logRequestFailure, noteAccess, openRequest, parseRequest, rejectEncodedSlash, replyFor, sendError } from './request.js';
import { createListener, warnIfCleartext } from './tls.js';
import { assertAddonRoutes, assertPublicJson, dispatchAddonRoute, dispatchPublicJson, dispatchV1Route, isPublicRoute } from './route-table.js';
import type { AuthResolver, RateLimitSpec, ResolvedServeOpts, RouteRequest, ServeOpts, ServerHandle } from './types.js';

// server.address() returns AddressInfo once a TCP socket is bound; null before
// listening, a string only for pipe/unix-socket listeners (never used here).
function isAddressInfo(
  a: string | import('node:net').AddressInfo | null,
): a is import('node:net').AddressInfo {
  return a !== null && typeof a !== 'string';
}

// Pinned at module load, bumped with package.json on releases; reading package.json synchronously here would couple the daemon to its install path,
// which tests that mkdtemp a hippoRoot avoid.
const VERSION = PACKAGE_VERSION;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
interface HandleRequestOptions {
  readonly startedAt: string;
  readonly streamSlots: Map<string, number>;
  readonly limiter?: RateLimiter;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ResolvedServeOpts,
  options: HandleRequestOptions,
): Promise<void> {
  const { startedAt, streamSlots, limiter } = options;
  // Pre-decode raw-URL slash check. Catches `%2F` / `%2f` before
  // Node's URL parser collapses them and they slip past the route table.
  rejectEncodedSlash(req.url ?? '/');

  const { method, path, query } = parseRequest(req);
  // An older core ignores X-Hippo-Project, so every /mcp reply, a 429 or 401 too, tells the client this one filters by it.
  if (path === '/mcp') res.setHeader(MCP_PROJECT_SCOPED_HEADER, '1');

  if (method === 'GET' && path === '/health') {
    noteAccess(req, { route: path });
    sendHealth(req, res, startedAt);
    return;
  }
  if (method === 'GET' && path === '/ready') {
    noteAccess(req, { route: path });
    await sendReady(res, opts.store);
    return;
  }

  enforceRateLimit(req, path, limiter);

  const routeRequest: RouteRequest = { req, res, opts, query };
  if (await runWithRequestStores(() => dispatchScopedRoute(routeRequest, method, path), { busyWaitMs: SERVER_DB_WAIT_MS })) return;

  // A scope of its own, which the heartbeat timer keeps after it closes, so the key check and every
  // heartbeat wait the server's lock wait. Store-ready: the stream only authenticates, through the port.
  if (method === 'GET' && path === '/mcp/stream') {
    noteAccess(req, { route: path });
    await runWithRequestStores(() => handleMcpStream(req, res, opts, streamSlots), { busyWaitMs: SERVER_DB_WAIT_MS });
    return;
  }

  res.writeHead(404, JSON_HEADERS);
  res.end(JSON.stringify({ error: 'not found' }));
}

const WEBHOOK_GROUPS = ['entryWrites', 'connectorWrites', 'connectorEvents'] as const;

/** A store missing a group a delivery writes through refuses the webhook up front, so no delivery is acknowledged and then half stored. */
function requireWebhookGroups(store: HippoStore): void {
  for (const group of WEBHOOK_GROUPS) requireGroup(store, group);
}

/** Every route that runs inside a request scope, so it opens each store once: the /v1 table, public JSON, add-on routes, the webhooks and POST /mcp. */
async function dispatchScopedRoute(r: RouteRequest, method: string, path: string): Promise<boolean> {
  if (await dispatchV1Route(r, method, path)) return true;
  if (dispatchPublicJson(r, method, path)) return true;
  if (await dispatchAddonRoute(r, method, path)) return true;
  const { req, res, opts } = r;

  if (method === 'POST' && path === '/v1/connectors/slack/events') {
    noteAccess(req, { route: path });
    // Bearer auth deliberately skipped: this route is in PUBLIC_ROUTES and authenticates via the Slack HMAC signature.
    if (!isPublicRoute(method, path)) {
      // Defensive: PUBLIC_ROUTES drift would land here. Fail closed.
      throw new HttpError(401, 'auth required');
    }
    requireWebhookGroups(opts.store);
    await handleSlackEventsWebhook({ req, res, opts }, opts.store);
    return true;
  }

  if (method === 'POST' && path === '/v1/connectors/github/events') {
    noteAccess(req, { route: path });
    if (!isPublicRoute(method, path)) {
      throw new HttpError(401, 'auth required');
    }
    requireWebhookGroups(opts.store);
    await handleGitHubEventsWebhook({ req, res, opts }, opts.store);
    return true;
  }

  // Store-ready: under another store the MCP layer lists and runs only the tools ported to the port.
  if (method === 'POST' && path === '/mcp') {
    noteAccess(req, { route: path });
    await handleMcpPost(req, res, opts);
    return true;
  }
  return false;
}

function sendHealth(req: IncomingMessage, res: ServerResponse, startedAt: string): void {
  // A caller on this machine (detectServer's probe reads version and pid) gets the full body; anyone else, even a proxied caller or a browser page on loopback,
  // gets liveness only: the version would fingerprint the build and the pid is noise. Platform health checks only need the 200.
  if (isLocalCaller(req)) {
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      started_at: startedAt,
      pid: process.pid,
      audit_write_failures: auditWriteFailureCount(),
      store_queue_refusals: workerCounts.queueRefusals,
      store_jobs_expired: workerCounts.jobsExpired,
      store_workers_replaced: workerCounts.workersReplaced,
      handler_deadlines: handlerDeadlineCount(),
    });
  } else {
    sendJson(res, 200, { ok: true });
  }
}

/** Readiness: one cheap read on the served store under the server's lock wait. /health stays
 * liveness only, so a probe can tell a store that does not answer from a dead process. */
async function sendReady(res: ServerResponse, store: HippoStore): Promise<void> {
  const { readiness } = store;
  if (readiness === undefined) {
    sendJson(res, 200, { ok: true, store: 'unchecked' });
    return;
  }
  if (!(await readyProbeFor(store, readiness)())) {
    sendJson(res, 503, { ok: false, error: 'store_unavailable' });
    return;
  }
  sendJson(res, 200, { ok: true });
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
  // Refuse to start if a live hippo server already serves this hippoRoot (detectServer probes the recorded /health and unlinks a stale pidfile):
  // a concurrent `hippo serve` would race for the port and clobber the pidfile.
  const existing = await detectServer(hippoRoot);
  if (existing) {
    throw new Error(
      `hippo serve: already running on port ${existing.port} (pid ${existing.pid}). ` +
      `Stop that server before starting another on the same hippoRoot.`,
    );
  }
}

// SHORTCUT: buckets live in this process and reset on restart or LRU eviction; move them to the store if serve ever runs as several processes.
function limiterFor({ ratePerSec, burst }: RateLimitSpec): RateLimiter {
  return createRateLimiter({ ratePerSec, burst, idleEvictMs: 60000, maxKeys: LIMITER_MAX_KEYS });
}

function bootRateLimiter(perAddress: RateLimitSpec | 'off' | undefined): RateLimiter | undefined {
  if (perAddress === 'off') return undefined;
  if (perAddress !== undefined) return limiterFor(perAddress);
  // Per-IP rate limiter for /v1/* and /mcp*, built here (not at module scope) so HIPPO_V1_RPS is read at boot and a test can set it before serve().
  // A non-positive or non-finite value disables limiting (the opt-out knob).
  const v1Rps = Number(envV1Rps() ?? 20);
  return Number.isFinite(v1Rps) && v1Rps > 0 ? limiterFor({ ratePerSec: v1Rps, burst: v1Rps * 2 }) : undefined;
}

const DEFAULT_FAILED_AUTH: RateLimitSpec = { ratePerSec: 20, burst: 40 };

function assertRateLimitSpec(name: string, { ratePerSec, burst }: RateLimitSpec): void {
  if (!Number.isFinite(ratePerSec) || ratePerSec <= 0) throw new Error(`rateLimits.${name}.ratePerSec must be a finite number above 0`);
  if (!Number.isFinite(burst) || burst < 1) throw new Error(`rateLimits.${name}.burst must be a finite number of at least 1`);
}

interface BootedLimiters {
  perAddress: RateLimiter | undefined;
  callerLimiter: RateLimiter | undefined;
  failedAuthLimiter: RateLimiter;
}

/** Refuses a bad spec at boot, since a NaN or zero rate would otherwise turn a bucket off or refuse every request. */
function bootLimiters(rateLimits: ServeOpts['rateLimits']): BootedLimiters {
  const { perCaller, perAddress, failedAuthPerAddress = DEFAULT_FAILED_AUTH } = rateLimits ?? {};
  if (perCaller !== undefined) assertRateLimitSpec('perCaller', perCaller);
  if (perAddress !== undefined && perAddress !== 'off') assertRateLimitSpec('perAddress', perAddress);
  assertRateLimitSpec('failedAuthPerAddress', failedAuthPerAddress);
  warnIfClientIpHeaderUnpinned();
  return {
    perAddress: bootRateLimiter(perAddress),
    callerLimiter: perCaller === undefined ? undefined : limiterFor(perCaller),
    failedAuthLimiter: limiterFor(failedAuthPerAddress),
  };
}

interface StoreHolder {
  hold: () => void;
  afterResponse: () => void;
  release: () => Promise<void>;
}

function createStoreHolder(hippoRoot: string, store: HippoStore): StoreHolder {
  if (store.kind !== 'sqlite') {
    log.info(`serve: the '${store.kind}' store serves ${hippoRoot}, so no hippo.db connection is held`);
    return { hold: () => {}, afterResponse: () => {}, release: async () => {} };
  }
  // Handlers open and close their own connections; while this one is held, none of those closes is SQLite's last,
  // which checkpoints and deletes the WAL. It opens only once the store exists, so serving never creates one.
  let heldDb: DatabaseSyncLike | undefined;
  let checkpointer: WalCheckpointer | undefined;
  let stopHolding = false;
  const hold = (): void => {
    if (heldDb || stopHolding || !existsSync(getHippoDbPath(hippoRoot))) return;
    try {
      // The 'finish' listener can fire inside a request scope (closing this connection with the request) and inside a `loop: 'off'` block (refusing the open).
      // The server's lock wait: this open runs on the event loop, where SQLite's 5 s default and the 30 s journal-mode retry would stall every request.
      heldDb = outsideSqliteOffLoop(() => outsideRequestStores(() => openHippoDb(hippoRoot, { busyWaitMs: SERVER_DB_WAIT_MS })));
      checkpointer = startWalCheckpointer(getHippoDbPath(hippoRoot));
    } catch (err) {
      stopHolding = true;
      log.warn(`serve: could not hold a store connection; requests still work, only slower: ${errorMessage(err)}`);
    }
  };
  const afterResponse = (): void => {
    hold();
    checkpointer?.noteResponse();
  };
  const release = async (): Promise<void> => {
    stopHolding = true;
    // The worker's connection closes first, so the held one is SQLite's last and its close checkpoints and deletes the WAL.
    await checkpointer?.stop();
    if (heldDb) closeHippoDb(heldDb);
    heldDb = undefined;
  };
  return { hold, afterResponse, release };
}

// A plugin's resolver may read hippo.db through this package's synchronous functions, so it runs outside the block of a `loop: 'off'` route.
function outsideRouteBlock(resolver: AuthResolver | undefined): AuthResolver | undefined {
  return resolver && ((token) => outsideSqliteOffLoop(() => resolver(token)));
}

function replyWithFailure<E>(req: IncomingMessage, res: ServerResponse, err: E, requestId: string): void {
  const mapped = replyFor(err);
  logRequestFailure(req, err, mapped.status);
  if (res.headersSent) {
    try { res.end(); } catch { /* socket already gone */ }
    return;
  }
  if (isStoreBusy(err)) res.setHeader('Retry-After', '1');
  else if (err instanceof HttpError && err.retryAfterSec !== undefined) res.setHeader('Retry-After', String(err.retryAfterSec));
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
  if (err instanceof DeadlineExceededError) {
    sendJson(res, 504, { error: err.message, code: err.code, requestId });
    return;
  }
  // readBody hit its cap or deadline, so close once the 413 or 408 is out rather than drain what the client keeps sending.
  if (err instanceof BodyTooLargeError || err instanceof BodyTimeoutError) res.once('finish', () => closeAfterReply(req));
  sendError(res, mapped.status, mapped.message);
}

const HANDLER_LATE = 'the request did not finish by its deadline and was abandoned; a write it started may or may not be saved';

// The caller already has its 504, so this line is the only trace of the failure. The path and the error text can hold caller data, so it carries neither.
function logLateFailure<E>(req: IncomingMessage, err: E, requestId: string): void {
  const fields = { requestId, method: req.method ?? 'GET', route: accessRouteOf(req), failureStatus: replyFor(err).status };
  log.warn('request failed after its deadline reply', { ...fields, errorClass: errorFields(err).errorClass });
}

// A handler that ends after the 504 finds the response finished, so sending its own reply throws this: its work ran to the end.
function isDroppedLateReply<E>(err: E): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ERR_HTTP_HEADERS_SENT';
}

/** A GET only reads; every other method this server routes can write. */
const isRead = (method: string): boolean => method === 'GET';

// A read that ends late changed nothing. A write that ends late ran to its end after its caller was told it may not have been saved.
function logLateFinish(req: IncomingMessage, requestId: string): void {
  const method = req.method ?? 'GET';
  if (isRead(method)) return;
  log.info('request finished after its deadline reply; its own reply was dropped', { requestId, method, route: accessRouteOf(req) });
}

function replyOrClose<E>(req: IncomingMessage, res: ServerResponse, err: E, requestId: string): void {
  try {
    replyWithFailure(req, res, err, requestId);
  } catch (replyErr) {
    // A throw here would be an unhandled rejection, which stops the daemon for every caller.
    log.error(`serve: failure reply not sent, socket closed: ${errorMessage(replyErr)}`, errorFields(replyErr));
    res.destroy();
  }
}

/** Runs `handle` under the request's id and deadline; a failure becomes the reply, unless the deadline has already answered. */
function answerRequest(req: IncomingMessage, res: ServerResponse, handle: () => Promise<void>, slowWarnMs: number | undefined): void {
  const requestId = openRequest(req, res, slowWarnMs);
  const deadline = requestDeadlineFor(req);
  // Inside the scope, so the failure reply's log line carries the id too.
  runWithRequestId(requestId, () => {
    if (deadline) answerAtDeadline(res, deadline, () => replyOrClose(req, res, new DeadlineExceededError(HANDLER_LATE), requestId));
    handle().then(() => {
      if (isAbandoned(res)) logLateFinish(req, requestId);
    }, <E>(err: E) => {
      if (!isAbandoned(res)) replyOrClose(req, res, err, requestId);
      else if (isDroppedLateReply(err)) logLateFinish(req, requestId);
      else logLateFailure(req, err, requestId);
    });
  }, deadline);
}


function listenOn(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      // With no listener, an 'error' event after boot is an uncaught exception that stops the server for every caller.
      server.on('error', (err) => log.error(`serve: listener error: ${err.message}`, errorFields(err)));
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}


function exitOnSignalOrCrash(stop: () => Promise<void>, drainMs: number): void {
  const shutdown = { run: stop, boundMs: shutdownBoundMs(drainMs) };
  installSignalHandlers('serve', shutdown);
  installCrashHandlers('serve', shutdown);
}

/** Boots the HTTP daemon on host:port and writes the pidfile under hippoRoot; refuses non-loopback hosts unless HIPPO_REQUIRE_AUTH=1.
 * Use port: 0 in tests for an ephemeral port. See docs/ARCHITECTURE.md#srcserverbootts. */
export async function serve(opts: ServeOpts): Promise<ServerHandle> {
  const host = opts.host ?? DEFAULT_SERVER_HOST;
  const requestedPort = opts.port ?? Number(envPort() ?? DEFAULT_SERVER_PORT);

  const routes = frozenAddonRoutes(opts.routes);
  const publicJsonBodies = assertPublicJson(opts.publicJson ?? {});
  const limiters = bootLimiters(opts.rateLimits);
  assertBindable(host);
  await assertNoLiveServer(opts.hippoRoot);

  // Single source of truth for the start time: returned by GET /health and written into the pidfile, so detectServer can prove a pid-reusing impostor is not
  // this server.
  const startedAt = new Date().toISOString();

  // Open /mcp/stream count per client key, so the cap is per server rather than per process.
  const streamSlots = new Map<string, number>();

  const served = servedOptsFor(opts, routes, publicJsonBodies, limiters);
  // A store other than hippo.db is a team's central server, so its folder's config.json must not decide shared-ness.
  if (served.store.kind !== 'sqlite') markSharedStore(opts.hippoRoot);
  const holder = createStoreHolder(opts.hippoRoot, served.store);

  const inflight = new Set<ServerResponse>();
  const server = acceptingServer(served, holder, inflight, { startedAt, streamSlots, limiter: limiters.perAddress });

  setKeepAliveTimeouts(server);

  const { port: actualPort, url } = await listenAndDescribe(server, requestedPort, host, opts.tls);

  writePidfile(opts.hippoRoot, { port: actualPort, url, startedAt });
  holder.hold();

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await stopListening(opts, server, inflight, startedAt);
    // The store's worker threads close their connections first, so the held one is still SQLite's last.
    if (!opts.store) await served.store.close();
    await holder.release();
  };

  if (opts.handleSignals) exitOnSignalOrCrash(stop, opts.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS);

  return { port: actualPort, url, stop, server };
}

function frozenAddonRoutes(addonRoutes: ServeOpts['routes']): NonNullable<ServeOpts['routes']> {
  // A frozen copy, so a route the caller adds or renames after boot never skips the check below.
  const routes = Object.freeze((addonRoutes ?? []).map(({ path, handler, storeReady }) => Object.freeze(storeReady === undefined
    ? { path, handler }
    : { path, handler, storeReady })));
  assertAddonRoutes(routes);
  return routes;
}

function servedOptsFor(
  opts: ServeOpts,
  routes: NonNullable<ServeOpts['routes']>,
  publicJsonBodies: ReadonlyMap<string, string>,
  { callerLimiter, failedAuthLimiter }: BootedLimiters,
): ResolvedServeOpts {
  return {
    ...opts, routes, publicJsonBodies, store: opts.store ?? workerSqliteStore(opts.hippoRoot), callerLimiter, failedAuthLimiter,
    authResolver: outsideRouteBlock(opts.authResolver),
  };
}

function acceptingServer(served: ResolvedServeOpts, holder: StoreHolder, inflight: Set<ServerResponse>, options: HandleRequestOptions): Server {
  const { kind } = served.store;
  return createListener(served.tls, (req, res) => {
    res.once('finish', holder.afterResponse);
    inflight.add(res);
    res.once('close', () => inflight.delete(res));
    const run = (): Promise<void> => handleRequest(req, res, served, options);
    // A missed port under another store would otherwise create and write a hippo.db that store never reads.
    answerRequest(req, res, () => (kind === 'sqlite' ? run() : withSqliteBlocked(kind, run)), served.slowRequestWarnMs);
  });
}

async function listenAndDescribe(server: Server, port: number, host: string, tls: ServeOpts['tls']): Promise<{ port: number; url: string }> {
  await listenOn(server, port, host);

  const address = server.address();
  if (!isAddressInfo(address)) {
    throw new Error('server.address() returned unexpected shape');
  }
  const addressInfo = address;
  const actualPort = addressInfo.port;
  const url = `${tls ? 'https' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${actualPort}`;
  warnIfCleartext(host, tls, LOOPBACK_HOSTS);
  return { port: actualPort, url };
}

async function stopListening(opts: ServeOpts, server: Server, inflight: Set<ServerResponse>, startedAt: string): Promise<void> {
  // Remove the pidfile only if it still names this server: a newer server may have rewritten it, and an unconditional unlink would orphan it.
  removePidfileIfOwned(opts.hippoRoot, { pid: process.pid, startedAt });
  await drainAndClose(server, inflight, opts.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS);
}