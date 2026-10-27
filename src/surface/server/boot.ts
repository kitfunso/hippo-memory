import { evalStoreRules } from '../../infra/eval-switches.js';
import {
  envAllowCleartext,
  envLossAversionRatio,
  envPort,
  envRuntimeSettings,
  envStoreQueueMax,
  envTenant,
  validateFlags,
} from '../../base/util/env.js';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { rootInfra } from '../../infra/ports.js';
import { claimPidfile, removePidfileIfOwned, writePidfile } from './server-detect.js';
import { issueLocalKey, type LocalKey } from './local-key.js';
import { KeyVerifier } from './api-key.js';
import { hasGroup, hasGroups, type StoreWith } from '../../base/ports/store.js';
import {
  defaultServerRuntime,
  tenantOfApiKey,
  type ResolveOptions,
  type ServerRuntime,
  type StoreSession,
} from '../open-store.js';
import { configReader, loadConfig } from '../../host/config-file.js';
import { auditWriteFailureCount } from '../../base/records/audit-report.js';
import { PACKAGE_VERSION } from '../../base/util/version.js';
import { errorFields, log } from '../../base/util/log.js';
import { JSON_HEADERS, sendJson } from '../http/http-util.js';
import { isLocalCaller } from './auth.js';
import { assertClientIpHeaderPinned, enforceRateLimit } from './client-ip.js';
import { createSleepQueue } from './sleep-offload.js';
import { createCallerState, newRowsOn, type CallerState } from '../../api/callers.js';
import {
  DEFAULT_SHUTDOWN_DRAIN_MS,
  drainAndClose,
  setKeepAliveTimeouts,
  shutdownBoundMs,
} from './lifecycle.js';
import { createReadyProbe, type ReadyProbe } from './ready.js';
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from './defaults.js';
import { installCrashHandlers, installSignalHandlers } from '../../base/util/crash-handlers.js';
import { handleMcpPost, handleMcpStream } from './mcp-http.js';
import { bindMcpTools } from '../mcp/request.js';
import { MCP_PROJECT_SCOPED_HEADER } from '../../base/scope/project-identity.js';
import { parseRequest, rejectEncodedSlash } from './request.js';
import { loopbackBindHosts } from './loopback.js';
import type { RequestLimits } from '../../base/util/request-scope.js';
import { assertTlsOrCleartextAllowed, createListener } from './tls.js';
import { assertAddonRoutes, assertPublicJson } from './route-checks.js';
import { answerRequest } from './failure-replies.js';
import { bootLimiters } from './rate-limits.js';
import type { RateLimiter } from './rate-limit.js';
import { warnGitHubPreviousSecretOpen } from '../connectors/github/webhook.js';
import { warnSlackPreviousSecretOpen } from '../connectors/slack/webhook.js';
import {
  bindAddonRoutes,
  bindV1Routes,
  dispatchAddonRoute,
  dispatchHostRoute,
  dispatchPublicJson,
  dispatchV1Route,
  HOST_ROUTES,
} from './route-table.js';
import type {
  ResolvedServeOptions,
  RouteRequest,
  ServeOptions,
  ServerCounts,
  ServerHandle,
} from './types.js';

// server.address() returns AddressInfo once a TCP socket is bound; null before listening, a string
// only for pipe/unix-socket listeners (never used here).
function isAddressInfo(
  a: string | import('node:net').AddressInfo | null,
): a is import('node:net').AddressInfo {
  return a !== null && typeof a !== 'string';
}

interface HandleRequestOptions {
  readonly startedAt: string;
  readonly streamSlots: Map<string, number>;
  readonly limiter?: RateLimiter;
  readonly counts: ServerCounts;
  readonly workerCounts: ServerRuntime['workerCounts'];
  /** /ready's one probe for the server's life, on the store as booted; unset when the store has
   * no readiness group. */
  readonly ready: ReadyProbe | undefined;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ResolvedServeOptions,
  options: HandleRequestOptions,
): Promise<void> {
  const { streamSlots, limiter } = options;
  // Pre-decode raw-URL slash check. Catches `%2F` / `%2f` before Node's URL parser collapses them
  // and they slip past the route table.
  rejectEncodedSlash(req.url ?? '/');

  const { method, path, query } = parseRequest(req);
  // An older core ignores X-Hippo-Project, so every /mcp reply, a 429 or 401 too, tells the client
  // this one filters by it.
  if (path === '/mcp') res.setHeader(MCP_PROJECT_SCOPED_HEADER, '1');

  const routeRequest: RouteRequest = { req, res, opts, query };
  const request = { method, path };
  if (await dispatchProbeRoute(routeRequest, request, options)) return;

  enforceRateLimit(req, path, limiter);

  if (await dispatchLimitedRoute(routeRequest, method, path)) return;

  // Store-ready: the stream only authenticates, through the port.
  if (
    await dispatchHostRoute(routeRequest, request, HOST_ROUTES.mcpStream, () =>
      handleMcpStream(req, res, opts, streamSlots),
    )
  ) {
    return;
  }

  res.writeHead(404, JSON_HEADERS);
  res.end(JSON.stringify({ error: 'not found' }));
}

/** GET /health then /ready; false when the request is neither. */
async function dispatchProbeRoute(
  r: RouteRequest,
  request: { method: string; path: string },
  options: HandleRequestOptions,
): Promise<boolean> {
  const { health, ready } = HOST_ROUTES;
  if (await dispatchHostRoute(r, request, health, async () => sendHealth(r.req, r.res, options))) {
    return true;
  }
  return dispatchHostRoute(r, request, ready, () => sendReady(r.res, options.ready));
}

/** The routes behind the rate limit: the /v1 table with the webhooks, public JSON, add-on routes
 * and POST /mcp. */
async function dispatchLimitedRoute(
  r: RouteRequest,
  method: string,
  path: string,
): Promise<boolean> {
  if (await dispatchV1Route(r, method, path)) return true;
  if (dispatchPublicJson(r, method, path)) return true;
  if (await dispatchAddonRoute(r, method, path)) return true;
  // Store-ready: under another store the MCP layer lists and runs only the tools ported to the
  // port.
  return dispatchHostRoute(r, { method, path }, HOST_ROUTES.mcp, () =>
    handleMcpPost(r.req, r.res, r.opts),
  );
}

function sendHealth(
  req: IncomingMessage,
  res: ServerResponse,
  { startedAt, counts, workerCounts }: HandleRequestOptions,
): void {
  // A caller on this machine (detectServer's probe reads version and pid) gets the full body;
  // anyone else, even a proxied caller or a browser page on loopback, gets liveness only: the
  // version would fingerprint the build and the pid is noise. Platform health checks only need the
  // 200.
  if (isLocalCaller(req)) {
    sendJson(res, 200, {
      ok: true,
      version: PACKAGE_VERSION,
      started_at: startedAt,
      pid: process.pid,
      audit_write_failures: auditWriteFailureCount(),
      store_queue_refusals: workerCounts.queueRefusals,
      store_jobs_expired: workerCounts.jobsExpired,
      store_workers_replaced: workerCounts.workersReplaced,
      handler_deadlines: counts.handlerDeadlines,
      auto_sleeps: counts.autoSleeps,
    });
  } else {
    sendJson(res, 200, { ok: true });
  }
}

/** Readiness: one cheap read on the served store under the server's lock wait. /health stays
 * liveness only, so a probe can tell a store that does not answer from a dead process. */
async function sendReady(res: ServerResponse, ready: ReadyProbe | undefined): Promise<void> {
  if (ready === undefined) {
    sendJson(res, 200, { ok: true, store: 'unchecked' });
    return;
  }
  if (!(await ready())) {
    sendJson(res, 503, { ok: false, error: 'store_unavailable' });
    return;
  }
  sendJson(res, 200, { ok: true });
}

/** A flag typo is refused at boot, since the safe side it would take may not be the side the
 * operator meant. */
function assertFlagsValid(): void {
  const bad = validateFlags();
  if (bad.length > 0) {
    throw new Error(
      `hippo serve: unknown flag value(s) ${bad.join(', ')}; use 1, true, on, 0, false or off`,
    );
  }
}

export function listenOn(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      // With no listener, an 'error' event after boot is an uncaught exception that stops the
      // server for every caller.
      server.on('error', (err) =>
        log.error(`serve: listener error: ${err.message}`, errorFields(err)),
      );
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

/** The ./testing kit's tenant resolver, kept at this root because it reads HIPPO_TENANT: the
 * tenant `opts.apiKey` names, else HIPPO_TENANT's (the default tenant when unset or blank), as
 * the server names it. */
export function resolveTenantId(opts: ResolveOptions): string {
  return opts.apiKey ? tenantOfApiKey({ ...opts, apiKey: opts.apiKey }) : envTenant();
}

/**
 * Boots the HTTP daemon on host:port and writes the local key and the pidfile under hippoRoot;
 * refuses a non-loopback host unless `tls` or allowCleartext is given, and refuses
 * HIPPO_CLIENT_IP_HEADER without HIPPO_TRUSTED_PROXIES. Use port: 0 in tests for an ephemeral
 * port. See docs/ARCHITECTURE.md#srcserverbootts. */
export async function serve(opts: ServeOptions): Promise<ServerHandle> {
  const host = opts.host ?? DEFAULT_SERVER_HOST;
  const requestedPort = opts.port ?? Number(envPort() ?? DEFAULT_SERVER_PORT);
  const routes = frozenAddonRoutes(opts.routes);
  const publicJsonBodies = assertPublicJson(opts.publicJson ?? {});
  const limiters = bootLimiters(opts.rateLimits);
  assertClientIpHeaderPinned();
  assertFlagsValid();
  const loopbackHosts = await loopbackBindHosts(host);
  assertTlsOrCleartextAllowed(
    host,
    opts.tls,
    loopbackHosts,
    opts.allowCleartext ?? envAllowCleartext(),
  );
  // An open-ended previous secret keeps working, so the operator hears once that nothing will close
  // it.
  warnSlackPreviousSecretOpen();
  warnGitHubPreviousSecretOpen();

  // Single source of truth for the start time: returned by GET /health and written into the
  // pidfile, so detectServer can prove a pid-reusing impostor is not this server.
  const startedAt = new Date().toISOString();
  await claimPidfile(opts.hippoRoot, startedAt);
  try {
    return await bindClaimed(opts, {
      host,
      requestedPort,
      routes,
      publicJsonBodies,
      limiters,
      startedAt,
    });
  } catch (err) {
    removePidfileIfOwned(opts.hippoRoot, { pid: process.pid, startedAt });
    throw err;
  }
}

interface BootPlan {
  host: string;
  requestedPort: number;
  routes: ReturnType<typeof frozenAddonRoutes>;
  publicJsonBodies: ReturnType<typeof assertPublicJson>;
  limiters: ReturnType<typeof bootLimiters>;
  startedAt: string;
}

/** Everything after the pidfile claim; a throw here releases the claim in serve(). */
async function bindClaimed(opts: ServeOptions, plan: BootPlan): Promise<ServerHandle> {
  const { host, requestedPort, startedAt } = plan;

  const runtime = defaultServerRuntime(opts.hippoRoot, {
    store: opts.store,
    queueMax: envStoreQueueMax(),
    ...evalStoreRules(envLossAversionRatio()),
    vectorGraphMaxVectors: loadConfig(opts.hippoRoot).vectorGraph.maxVectors,
  });
  // Before the listen, so the first request already has the key it is checked against.
  const localKey = issueLocalKey(opts.hippoRoot);
  const served = servedOptsFor(opts, plan, runtime, localKey);

  const inflight = new Set<ServerResponse>();
  const options = requestOptionsFor(plan, served, runtime);
  const server = acceptingServer(served, runtime, inflight, options);

  setKeepAliveTimeouts(server);

  const { port: actualPort, url } = await listenAndDescribe(server, requestedPort, host, opts.tls);

  writePidfile(opts.hippoRoot, { port: actualPort, url, startedAt });
  runtime.hold();

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await stopListening(opts, server, inflight, startedAt);
    // An auto-sleep answers no request, so draining skips it; its child must leave the store before
    // the store closes.
    await served.sleeps.settled();
    await runtime.close();
  };

  if (opts.handleSignals) {
    exitOnSignalOrCrash(stop, opts.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS);
  }

  return { port: actualPort, url, stop, server };
}

function requestOptionsFor(
  { startedAt, limiters }: BootPlan,
  served: ResolvedServeOptions,
  { workerCounts }: ServerRuntime,
): HandleRequestOptions {
  return {
    startedAt,
    // Open /mcp/stream count per client key, so the cap is per server rather than per process.
    streamSlots: new Map<string, number>(),
    limiter: limiters.perAddress,
    counts: served.counts,
    workerCounts,
    ready: served.store.readiness && createReadyProbe(served.store.readiness),
  };
}

function frozenAddonRoutes(
  addonRoutes: ServeOptions['routes'],
): NonNullable<ServeOptions['routes']> {
  // A frozen copy, so a route the caller adds or renames after boot never skips the check below.
  const routes = Object.freeze(
    (addonRoutes ?? []).map(({ path, handler, storeReady }) =>
      Object.freeze({ path, handler, ...(storeReady !== undefined && { storeReady }) }),
    ),
  );
  assertAddonRoutes(routes);
  return routes;
}

function servedOptsFor(
  opts: ServeOptions,
  { routes, publicJsonBodies, limiters }: BootPlan,
  runtime: ServerRuntime,
  localKey: LocalKey,
): ResolvedServeOptions {
  const { callerLimiter, failedAuthLimiter } = limiters;
  const { store } = runtime;
  const sleeps = createSleepQueue(opts.hippoRoot, runtime.onHippoDb);
  const counts: ServerCounts = { handlerDeadlines: 0, autoSleeps: 0 };
  const run = (): Promise<void> => {
    counts.autoSleeps += 1;
    return sleeps.consolidate();
  };
  // The auto-sleep child reopens hippo.db by its folder, so another store never starts one.
  const sleepsHere = opts.autoSleep !== false && runtime.onHippoDb;
  // The count reads the store's reports, so a store without them starts no sleep.
  const counted = sleepsHere && hasGroup(store, 'reports') ? store : undefined;
  const autoSleep = counted && { run, hostTenantId: envTenant(), newSince: newRowsOn(counted) };
  const callers = createCallerState(autoSleep);
  return {
    ...opts,
    routes,
    publicJsonBodies,
    v1Routes: bindV1Routes(store, runtime.onHippoDb),
    addonRoutes: bindAddonRoutes(routes, store, runtime.onHippoDb),
    mcpTools: bindMcpTools(store),
    store,
    onHippoDb: runtime.onHippoDb,
    reachOf: (shared) => runtime.reachOf(shared, {}),
    storeFor: (own) => own,
    configAt: configReader(envRuntimeSettings),
    callerLimiter,
    failedAuthLimiter,
    localKey,
    keyVerifier: new KeyVerifier(),
    callers,
    callersFor: (storeFor) => callersOnRequest(callers, counted && storeFor(counted)),
    ledgerStore: hasGroups(store, ['ledger', 'folderFiles']) ? store : undefined,
    infra: rootInfra(runtime.host),
    sleeps,
    counts,
  };
}

function acceptingServer(
  served: ResolvedServeOptions,
  runtime: ServerRuntime,
  inflight: Set<ServerResponse>,
  options: HandleRequestOptions,
): Server {
  return createListener(served.tls, (req, res) => {
    res.once('finish', runtime.afterResponse);
    inflight.add(res);
    res.once('close', () => inflight.delete(res));
    const answer = (limits: RequestLimits): Promise<void> =>
      runtime.runRequest((session) =>
        handleRequest(req, res, servedFor(served, runtime, { limits, session }), options),
      );
    answerRequest(req, res, answer, {
      slowWarnMs: served.slowRequestWarnMs,
      counts: options.counts,
    });
  });
}

/** `served` as one request reads it: each store call to a worker waits on the request's
 * deadline, an in-process store opens on the request's session, and its Context carries the
 * abort signal. */
function servedFor(
  served: ResolvedServeOptions,
  runtime: ServerRuntime,
  { limits, session }: { readonly limits: RequestLimits; readonly session: StoreSession },
): ResolvedServeOptions {
  return {
    ...served,
    store: runtime.storeFor(served.store, limits, session),
    reachOf: (shared) => runtime.reachOf(shared, limits, session),
    storeFor: (own) => runtime.storeFor(own, limits, session),
    callers: served.callersFor((own) => runtime.storeFor(own, limits, session)),
    ledgerStore: served.ledgerStore && runtime.storeFor(served.ledgerStore, limits, session),
    signal: limits.signal,
  };
}

/** The server's callers for one request: the shared latch, and the count on the request's store. */
function callersOnRequest(callers: CallerState, counted?: StoreWith<'reports'>): CallerState {
  const { autoSleep } = callers;
  if (autoSleep === undefined || counted === undefined) return callers;
  return { ...callers, autoSleep: { ...autoSleep, newSince: newRowsOn(counted) } };
}

async function listenAndDescribe(
  server: Server,
  port: number,
  host: string,
  tls: ServeOptions['tls'],
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
  opts: ServeOptions,
  server: Server,
  inflight: Set<ServerResponse>,
  startedAt: string,
): Promise<void> {
  // Remove the pidfile only if it still names this server: a newer server may have rewritten it,
  // and an unconditional unlink would orphan it.
  removePidfileIfOwned(opts.hippoRoot, { pid: process.pid, startedAt });
  await drainAndClose(server, inflight, opts.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS);
}
