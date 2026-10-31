import { envAllowCleartext, envCallerRps, envPort, envRequireAuth, envV1Rps } from '../util/env.js';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { detectServer, removePidfileIfOwned, writePidfile } from './server-detect.js';
import { hasGroup, type HippoStore } from '../store/index.js';
import { isStoreBusy } from '../api/busy.js';
import {
  createStoreHolder, offLoopFor, outsideRouteBlock, type StoreHolder,
} from '../store/sqlite/held-connection.js';
import { workerSqliteStore } from '../store/sqlite/worker-store.js';
import { markSharedStore } from '../core/config.js';
import { auditWriteFailureCount } from '../store/audit.js';
import { PACKAGE_VERSION } from '../util/version.js';
import { MINUTE_MS } from '../util/time.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import { runWithRequestId } from '../util/request-scope.js';
import { createRateLimiter, type RateLimiter } from './rate-limit.js';
import { RecallContractError } from '../api/index.js';
import {
  BodyTimeoutError,
  BodyTooLargeError,
  closeAfterReply,
  DeadlineExceededError,
  HttpError,
  JSON_HEADERS,
  sendJson,
} from '../util/http-util.js';
import { workerCounts } from '../store/sqlite/executor-counts.js';
import { isLocalCaller, LIMITER_MAX_KEYS } from './auth.js';
import { assertClientIpHeaderPinned, enforceRateLimit } from './client-ip.js';
import { answerAtDeadline, handlerDeadlineCount, isAbandoned, requestDeadlineFor } from './deadline.js';
import { DEFAULT_SHUTDOWN_DRAIN_MS, drainAndClose, setKeepAliveTimeouts, shutdownBoundMs } from './lifecycle.js';
import { readyProbeFor } from './ready.js';
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from './defaults.js';
import { installCrashHandlers, installSignalHandlers } from '../util/crash-handlers.js';
import { handleMcpPost, handleMcpStream } from './mcp-http.js';
import { MCP_PROJECT_SCOPED_HEADER } from '../core/project-identity.js';
import {
  accessRouteOf,
  logRequestFailure,
  noteAccess,
  openRequest,
  parseRequest,
  rejectEncodedSlash,
  replyFor,
  sendError,
} from './request.js';
import { assertTlsOrCleartextAllowed, createListener } from './tls.js';
import { assertAddonRoutes, assertPublicJson } from './route-checks.js';
import { dispatchAddonRoute, dispatchPublicJson, dispatchV1Route } from './route-table.js';
import type { RateLimitSpec, ResolvedServeOpts, RouteRequest, ServeOpts, ServerHandle } from './types.js';

// server.address() returns AddressInfo once a TCP socket is bound; null before
// listening, a string only for pipe/unix-socket listeners (never used here).
function isAddressInfo(
  a: string | import('node:net').AddressInfo | null,
): a is import('node:net').AddressInfo {
  return a !== null && typeof a !== 'string';
}

// Pinned at module load, bumped with package.json on releases; reading package.json synchronously here would couple the
// daemon to its install path,
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
  // An older core ignores X-Hippo-Project, so every /mcp reply, a 429 or 401 too, tells the client this one filters by
  // it.
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
  if (await dispatchScopedRoute(routeRequest, method, path)) return;

  // The request scope (the server's lock wait) is kept by the heartbeat timer after it closes, so the key check and
  // every heartbeat wait that long. Store-ready: the stream only authenticates, through the port.
  if (method === 'GET' && path === '/mcp/stream') {
    noteAccess(req, { route: path });
    await handleMcpStream(req, res, opts, streamSlots);
    return;
  }

  res.writeHead(404, JSON_HEADERS);
  res.end(JSON.stringify({ error: 'not found' }));
}

/**
 * Every route that runs inside a request scope, so it opens each store once: the /v1 table with the webhooks, public
 * JSON, add-on routes and POST /mcp.
 */
async function dispatchScopedRoute(r: RouteRequest, method: string, path: string): Promise<boolean> {
  if (await dispatchV1Route(r, method, path)) return true;
  if (dispatchPublicJson(r, method, path)) return true;
  if (await dispatchAddonRoute(r, method, path)) return true;
  const { req, res, opts } = r;

  // Store-ready: under another store the MCP layer lists and runs only the tools ported to the port.
  if (method === 'POST' && path === '/mcp') {
    noteAccess(req, { route: path });
    await handleMcpPost(req, res, opts);
    return true;
  }
  return false;
}

function sendHealth(req: IncomingMessage, res: ServerResponse, startedAt: string): void {
  // A caller on this machine (detectServer's probe reads version and pid) gets the full body; anyone else, even a
  // proxied caller or a browser page on loopback,
  // gets liveness only: the version would fingerprint the build and the pid is noise. Platform health checks only need
  // the 200.
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
  // Refuse to start if a live hippo server already serves this hippoRoot (detectServer probes the recorded /health and
  // unlinks a stale pidfile):
  // a concurrent `hippo serve` would race for the port and clobber the pidfile.
  const existing = await detectServer(hippoRoot);
  if (existing) {
    throw new Error(
      `hippo serve: already running on port ${existing.port} (pid ${existing.pid}). ` +
      `Stop that server before starting another on the same hippoRoot.`,
    );
  }
}

// SHORTCUT: buckets live in this process and reset on restart or LRU eviction; move them to the store if serve ever
// runs as several processes.
function limiterFor({ ratePerSec, burst }: RateLimitSpec): RateLimiter {
  return createRateLimiter({ ratePerSec, burst, idleEvictMs: MINUTE_MS, maxKeys: LIMITER_MAX_KEYS });
}

function bootRateLimiter(perAddress: RateLimitSpec | 'off' | undefined): RateLimiter | undefined {
  if (perAddress === 'off') return undefined;
  if (perAddress !== undefined) return limiterFor(perAddress);
  // Per-IP rate limiter for /v1/* and /mcp*, built here (not at module scope) so HIPPO_V1_RPS is read at boot and a
  // test can set it before serve().
  // A typo must not switch the limit off, so only an explicit 0 does.
  const raw = envV1Rps();
  const v1Rps = raw === undefined ? 20 : Number(raw);
  if (!Number.isFinite(v1Rps) || v1Rps < 0) {
    throw new Error(`HIPPO_V1_RPS must be a number of at least 0 (0 turns the per-address limit off), not '${raw}'`);
  }
  return v1Rps > 0 ? limiterFor({ ratePerSec: v1Rps, burst: v1Rps * 2 }) : undefined;
}

const DEFAULT_FAILED_AUTH: RateLimitSpec = { ratePerSec: 20, burst: 40 };

function assertRateLimitSpec(name: string, { ratePerSec, burst }: RateLimitSpec): void {
  if (!Number.isFinite(ratePerSec) || ratePerSec <= 0) {
    throw new Error(`rateLimits.${name}.ratePerSec must be a finite number above 0`);
  }
  if (!Number.isFinite(burst) || burst < 1) {
    throw new Error(`rateLimits.${name}.burst must be a finite number of at least 1`);
  }
}

interface BootedLimiters {
  perAddress: RateLimiter | undefined;
  callerLimiter: RateLimiter | undefined;
  failedAuthLimiter: RateLimiter;
}

const DEFAULT_CALLER_RPS = 20;

/**
 * The per-caller spec when serve() names none: HIPPO_CALLER_RPS (0 is off), else 20 per second with a burst of twice
 * that.
 */
function defaultCallerSpec(): RateLimitSpec | 'off' {
  const raw = envCallerRps();
  const rps = raw === undefined ? DEFAULT_CALLER_RPS : Number(raw);
  // A typo must not switch the limit off, so only an explicit 0 does.
  if (!Number.isFinite(rps) || rps < 0) {
    throw new Error(`HIPPO_CALLER_RPS must be a number of at least 0 (0 turns the per-caller limit off), not '${raw}'`);
  }
  return rps === 0 ? 'off' : { ratePerSec: rps, burst: Math.max(1, rps * 2) };
}

/** Refuses a bad spec at boot, since a NaN or zero rate would otherwise turn a bucket off or refuse every request. */
function bootLimiters(rateLimits: ServeOpts['rateLimits']): BootedLimiters {
  const { perCaller = defaultCallerSpec(), perAddress, failedAuthPerAddress = DEFAULT_FAILED_AUTH } = rateLimits ?? {};
  if (perCaller !== 'off') assertRateLimitSpec('perCaller', perCaller);
  if (perAddress !== undefined && perAddress !== 'off') assertRateLimitSpec('perAddress', perAddress);
  assertRateLimitSpec('failedAuthPerAddress', failedAuthPerAddress);
  assertClientIpHeaderPinned();
  return {
    perAddress: bootRateLimiter(perAddress),
    callerLimiter: perCaller === 'off' ? undefined : limiterFor(perCaller),
    failedAuthLimiter: limiterFor(failedAuthPerAddress),
  };
}

function replyWithFailure<E>(req: IncomingMessage, res: ServerResponse, err: E, requestId: string): void {
  const mapped = replyFor(err);
  logRequestFailure(req, err, mapped.status);
  if (res.headersSent) {
    try { res.end(); } catch { /* socket already gone */ }
    return;
  }
  if (isStoreBusy(err)) {
    res.setHeader('Retry-After', '1');
  } else if (err instanceof HttpError && err.retryAfterSec !== undefined) {
    res.setHeader('Retry-After', String(err.retryAfterSec));
  }
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
  // readBody hit its cap or deadline, so close once the 413 or 408 is out rather than drain what the client keeps
  // sending.
  if (err instanceof BodyTooLargeError || err instanceof BodyTimeoutError) {
    res.once('finish', () => closeAfterReply(req));
  }
  sendError(res, mapped.status, mapped.message);
}

const HANDLER_LATE =
  'the request did not finish by its deadline and was abandoned; a write it started may or may not be saved';

// The caller already has its 504, so this line is the only trace of the failure. The path and the error text can hold
// caller data, so it carries neither.
function logLateFailure<E>(req: IncomingMessage, err: E, requestId: string): void {
  const fields = {
    requestId,
    method: req.method ?? 'GET',
    route: accessRouteOf(req),
    failureStatus: replyFor(err).status,
  };
  log.warn('request failed after its deadline reply', { ...fields, errorClass: errorFields(err).errorClass });
}

// A handler that ends after the 504 finds the response finished, so sending its own reply throws this: its work ran to
// the end.
function isDroppedLateReply<E>(err: E): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ERR_HTTP_HEADERS_SENT';
}

/** A GET only reads; every other method this server routes can write. */
const isRead = (method: string): boolean => method === 'GET';

// A read that ends late changed nothing. A write that ends late ran to its end after its caller was told it may not
// have been saved.
function logLateFinish(req: IncomingMessage, requestId: string): void {
  const method = req.method ?? 'GET';
  if (isRead(method)) return;
  log.info('request finished after its deadline reply; its own reply was dropped', {
    requestId,
    method,
    route: accessRouteOf(req),
  });
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

/**
 * Runs `handle` under the request's id and deadline; a failure becomes the reply, unless the deadline has already
 * answered.
 */
function answerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handle: () => Promise<void>,
  slowWarnMs: number | undefined,
): void {
  const requestId = openRequest(req, res, slowWarnMs);
  const deadline = requestDeadlineFor(req);
  const abort = deadline ? new AbortController() : undefined;
  // Inside the scope, so the failure reply's log line carries the id too.
  runWithRequestId(
    requestId,
    () => {
      if (deadline) {
        answerAtDeadline(
          res,
          deadline,
          () => replyOrClose(req, res, new DeadlineExceededError(HANDLER_LATE), requestId),
          () => abort?.abort(new DeadlineExceededError(HANDLER_LATE)),
        );
      }
      handle().then(
        () => {
          if (isAbandoned(res)) logLateFinish(req, requestId);
        },
        <E>(err: E) => {
          if (!isAbandoned(res)) replyOrClose(req, res, err, requestId);
          else if (isDroppedLateReply(err)) logLateFinish(req, requestId);
          else logLateFailure(req, err, requestId);
        },
      );
    },
    deadline,
    abort?.signal,
  );
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

/**
 * Boots the HTTP daemon on host:port and writes the pidfile under hippoRoot; refuses a non-loopback host unless
 * HIPPO_REQUIRE_AUTH=1 and
 * either `tls` or allowCleartext is given, and refuses HIPPO_CLIENT_IP_HEADER without HIPPO_TRUSTED_PROXIES.
 * Use port: 0 in tests for an ephemeral port. See docs/ARCHITECTURE.md#srcserverbootts. */
export async function serve(opts: ServeOpts): Promise<ServerHandle> {
  const host = opts.host ?? DEFAULT_SERVER_HOST;
  const requestedPort = opts.port ?? Number(envPort() ?? DEFAULT_SERVER_PORT);

  const routes = frozenAddonRoutes(opts.routes);
  const publicJsonBodies = assertPublicJson(opts.publicJson ?? {});
  const limiters = bootLimiters(opts.rateLimits);
  assertBindable(host);
  assertTlsOrCleartextAllowed(host, opts.tls, LOOPBACK_HOSTS, opts.allowCleartext ?? envAllowCleartext());
  await assertNoLiveServer(opts.hippoRoot);

  // Single source of truth for the start time: returned by GET /health and written into the pidfile, so detectServer
  // can prove a pid-reusing impostor is not
  // this server.
  const startedAt = new Date().toISOString();

  // Open /mcp/stream count per client key, so the cap is per server rather than per process.
  const streamSlots = new Map<string, number>();

  const served = servedOptsFor(opts, routes, publicJsonBodies, limiters);
  // A store other than hippo.db is a team's central server, so its folder's config.json must not decide shared-ness.
  if (!hasGroup(served.store, 'localFiles')) markSharedStore(opts.hippoRoot);
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
  const routes = Object.freeze(
    (addonRoutes ?? []).map(({ path, handler, storeReady }) =>
      Object.freeze(storeReady === undefined ? { path, handler } : { path, handler, storeReady }),
    ),
  );
  assertAddonRoutes(routes);
  return routes;
}

function servedOptsFor(
  opts: ServeOpts,
  routes: NonNullable<ServeOpts['routes']>,
  publicJsonBodies: ReadonlyMap<string, string>,
  { callerLimiter, failedAuthLimiter }: BootedLimiters,
): ResolvedServeOpts {
  const store = opts.store ?? workerSqliteStore(opts.hippoRoot);
  return {
    ...opts,
    routes,
    publicJsonBodies,
    store,
    offLoop: offLoopFor(store),
    callerLimiter,
    failedAuthLimiter,
    authResolver: outsideRouteBlock(opts.authResolver),
  };
}

function acceptingServer(
  served: ResolvedServeOpts,
  holder: StoreHolder,
  inflight: Set<ServerResponse>,
  options: HandleRequestOptions,
): Server {
  return createListener(served.tls, (req, res) => {
    res.once('finish', holder.afterResponse);
    inflight.add(res);
    res.once('close', () => inflight.delete(res));
    answerRequest(
      req,
      res,
      () => holder.runRequest(() => handleRequest(req, res, served, options)),
      served.slowRequestWarnMs,
    );
  });
}

async function listenAndDescribe(
  server: Server,
  port: number,
  host: string,
  tls: ServeOpts['tls'],
): Promise<{ port: number; url: string }> {
  await listenOn(server, port, host);

  const address = server.address();
  if (!isAddressInfo(address)) {
    throw new Error('server.address() returned unexpected shape');
  }
  const addressInfo = address;
  const actualPort = addressInfo.port;
  const url = `${tls ? 'https' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${actualPort}`;
  return { port: actualPort, url };
}

async function stopListening(
  opts: ServeOpts,
  server: Server,
  inflight: Set<ServerResponse>,
  startedAt: string,
): Promise<void> {
  // Remove the pidfile only if it still names this server: a newer server may have rewritten it, and an unconditional
  // unlink would orphan it.
  removePidfileIfOwned(opts.hippoRoot, { pid: process.pid, startedAt });
  await drainAndClose(server, inflight, opts.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS);
}