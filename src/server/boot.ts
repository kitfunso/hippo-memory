import { envPort, envRequireAuth, envV1Rps } from '../env.js';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { detectServer, removePidfileIfOwned, writePidfile } from '../server-detect.js';
import { closeHippoDb, type DatabaseSyncLike, getHippoDbPath, isStoreBusy, openHippoDb, outsideRequestStores, runWithRequestStores, SERVER_DB_WAIT_MS, withSqliteBlocked } from '../db.js';
import { startWalCheckpointer, type WalCheckpointer } from '../db/wal-checkpointer.js';
import { sqliteStore, type HippoStore } from '../store-port.js';
import { markSharedStore } from '../config.js';
import { auditWriteFailureCount } from '../audit.js';
import { PACKAGE_VERSION } from '../version.js';
import { errorFields, errorMessage, log } from '../log.js';
import { runWithRequestId } from '../util/request-scope.js';
import { createRateLimiter, type RateLimiter } from '../rate-limit.js';
import { RecallContractError } from '../api.js';
import { handleSlackEventsWebhook } from '../connectors/slack/webhook.js';
import { handleGitHubEventsWebhook } from '../connectors/github/webhook.js';
import { bodyDeadlineMs, BodyTimeoutError, BodyTooLargeError, closeAfterReply, HttpError, JSON_HEADERS, sendJson } from '../http-util.js';
import { isLoopback, LIMITER_MAX_KEYS } from './auth.js';
import { enforceRateLimit, warnIfClientIpHeaderUnpinned } from './client-ip.js';
import { drainAndClose } from './lifecycle.js';
import { installCrashHandlers } from '../util/crash-handlers.js';
import { handleMcpPost, handleMcpStream } from './mcp-http.js';
import { MCP_PROJECT_SCOPED_HEADER } from '../project-identity.js';
import { logRequestFailure, noteAccess, openRequest, parseRequest, rejectEncodedSlash, replyFor, sendError } from './request.js';
import { createListener, warnIfCleartext } from './tls.js';
import { assertAddonRoutes, assertPublicJson, assertSqliteStore, dispatchAddonRoute, dispatchPublicJson, dispatchV1Route, isPublicRoute } from './route-table.js';
import type { RateLimitSpec, ResolvedServeOpts, RouteRequest, ServeOpts, ServerHandle } from './types.js';

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

  // A scope of its own, which the heartbeat timer keeps after it closes, so the key check and every heartbeat wait the server's lock wait. Store-ready: the stream only authenticates, through the port.
  if (method === 'GET' && path === '/mcp/stream') {
    noteAccess(req, { route: path });
    await runWithRequestStores(() => handleMcpStream(req, res, opts, streamSlots), { busyWaitMs: SERVER_DB_WAIT_MS });
    return;
  }

  res.writeHead(404, JSON_HEADERS);
  res.end(JSON.stringify({ error: 'not found' }));
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
    assertSqliteStore(opts);
    await handleSlackEventsWebhook({ req, res, opts });
    return true;
  }

  if (method === 'POST' && path === '/v1/connectors/github/events') {
    noteAccess(req, { route: path });
    if (!isPublicRoute(method, path)) {
      throw new HttpError(401, 'auth required');
    }
    assertSqliteStore(opts);
    await handleGitHubEventsWebhook({ req, res, opts });
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

/** Readiness: one cheap read on the served store under the server's lock wait. /health stays liveness only, so a probe can tell a store that does not answer from a dead process. */
async function sendReady(res: ServerResponse, store: HippoStore): Promise<void> {
  const { readiness } = store;
  if (readiness === undefined) {
    sendJson(res, 200, { ok: true, store: 'unchecked' });
    return;
  }
  try {
    await runWithRequestStores(() => readiness.ping(), { busyWaitMs: SERVER_DB_WAIT_MS });
  } catch (err) {
    log.warn(`GET /ready: the store did not answer: ${errorMessage(err)}`, errorFields(err));
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

// SHORTCUT: buckets live in this process and reset on restart or LRU eviction; move them to the store if serve ever runs as several processes.
function limiterFor({ ratePerSec, burst }: RateLimitSpec): RateLimiter {
  return createRateLimiter({ ratePerSec, burst, idleEvictMs: 60000, maxKeys: LIMITER_MAX_KEYS });
}

function bootRateLimiter(perAddress: RateLimitSpec | 'off' | undefined): RateLimiter | undefined {
  if (perAddress === 'off') return undefined;
  if (perAddress !== undefined) return limiterFor(perAddress);
  // Per-IP rate limiter for /v1/* and /mcp*. Built here (not at module scope) so
  // HIPPO_V1_RPS is read at boot, matching HIPPO_PORT above and letting a test
  // set the rate before serve(). A non-positive or non-finite value disables
  // limiting (the opt-out knob).
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
      // The 'finish' listener can fire inside a request scope, which would close this connection with the request.
      // The server's lock wait: this open runs on the event loop, where SQLite's 5 s default and the 30 s journal-mode retry would stall every request.
      heldDb = outsideRequestStores(() => openHippoDb(hippoRoot, { busyWaitMs: SERVER_DB_WAIT_MS }));
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
  // readBody hit its cap or deadline, so close once the 413 or 408 is out rather than drain what the client keeps sending.
  if (err instanceof BodyTooLargeError || err instanceof BodyTimeoutError) res.once('finish', () => closeAfterReply(req));
  sendError(res, mapped.status, mapped.message);
}

function replyOrClose<E>(req: IncomingMessage, res: ServerResponse, err: E, requestId: string): void {
  try {
    replyWithFailure(req, res, err, requestId);
  } catch (replyErr) {
    // A throw here would be an unhandled rejection, which stops the daemon for every caller.
    log.error(`serve: failure reply not sent, socket closed: ${errorMessage(replyErr)}`);
    res.destroy();
  }
}

// Node's own default, named so the three socket deadlines read together. It times the request arriving, never the handler, so a 10 minute sleep is not cut.
const REQUEST_RECEIVE_TIMEOUT_MS = 300_000;

function setKeepAliveTimeouts(server: Server): void {
  // The default 5s keepAliveTimeout closes idle sockets just as clients reuse them (ECONNRESET).
  // headersTimeout must stay ABOVE keepAliveTimeout + keepAliveTimeoutBuffer (1s), or it closes idle reused sockets itself.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  // Never below what a raised body deadline allows, or Node's bare 408 would come before the route's own.
  server.requestTimeout = Math.max(REQUEST_RECEIVE_TIMEOUT_MS, server.headersTimeout + bodyDeadlineMs());
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
      log.error(`error during stop: ${errorMessage(err)}`, errorFields(err));
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
 * secrets and 404 when those secrets are unset, and any publicJson GET path. But the loopback
 * no-auth fallback inside buildContextWithAuth still admits unauthenticated
 * requests from a loopback remote address (unless they carry Forwarded,
 * X-Forwarded-For/-Host/-Proto, X-Real-IP, Cf-Connecting-Ip, True-Client-Ip or Fly-Client-Ip, which mark a same-host proxy and get
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
  const routes = Object.freeze((opts.routes ?? []).map(({ path, handler, storeReady }) => Object.freeze(storeReady === undefined ? { path, handler } : { path, handler, storeReady })));
  assertAddonRoutes(routes);
  const publicJsonBodies = assertPublicJson(opts.publicJson ?? {});
  const { perAddress: limiter, callerLimiter, failedAuthLimiter } = bootLimiters(opts.rateLimits);
  assertBindable(host);
  await assertNoLiveServer(opts.hippoRoot);

  // The server's start time. Single source of truth: it is returned by every
  // GET /health response and (below) written into the pidfile, so detectServer
  // can match the two and prove a pid-reusing impostor is not the real server.
  const startedAt = new Date().toISOString();

  // Open /mcp/stream count per client key, so the cap is per server rather than per process.
  const streamSlots = new Map<string, number>();

  const served: ResolvedServeOpts = {
    ...opts, routes, publicJsonBodies, store: opts.store ?? sqliteStore(opts.hippoRoot), callerLimiter, failedAuthLimiter,
  };
  const { kind } = served.store;
  // A store other than hippo.db is a team's central server, so its folder's config.json must not decide shared-ness.
  if (kind !== 'sqlite') markSharedStore(opts.hippoRoot);
  const holder = createStoreHolder(opts.hippoRoot, served.store);

  const inflight = new Set<ServerResponse>();
  const server: Server = createListener(opts.tls, (req, res) => {
    res.once('finish', holder.afterResponse);
    inflight.add(res);
    res.once('close', () => inflight.delete(res));
    const requestId = openRequest(req, res, opts.slowRequestWarnMs);
    const run = (): Promise<void> => handleRequest(req, res, served, { startedAt, streamSlots, limiter });
    // A missed port under another store would otherwise create and write a hippo.db that store never reads.
    const guarded = (): Promise<void> => (kind === 'sqlite' ? run() : withSqliteBlocked(kind, run));
    // Inside the scope, so the failure reply's log line carries the id too.
    runWithRequestId(requestId, () => { guarded().catch(<E>(err: E) => replyOrClose(req, res, err, requestId)); });
  });

  setKeepAliveTimeouts(server);

  await listenOn(server, requestedPort, host);

  const address = server.address();
  if (!isAddressInfo(address)) {
    throw new Error('server.address() returned unexpected shape');
  }
  const addressInfo = address;
  const actualPort = addressInfo.port;
  const url = `${opts.tls ? 'https' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${actualPort}`;
  warnIfCleartext(host, opts.tls, LOOPBACK_HOSTS);

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
    await holder.release();
    if (!opts.store) await served.store.close();
  };

  if (opts.handleSignals) {
    installSignalHandlers(stop);
    installCrashHandlers('serve', stop);
  }

  return { port: actualPort, url, stop, server };
}