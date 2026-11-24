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
import { hasGroup, hasGroups, type HippoStore, type StoreWith } from '../../base/ports/store.js';
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
import { enableRequestTrail, errorFields, log } from '../../base/util/log.js';
import { JSON_HEADERS, sendJson } from '../http/http-util.js';
import { isLocalCaller } from './auth.js';
import { assertClientIpHeaderPinned, enforceRateLimit } from './client-ip.js';
import { createSleepQueue } from './sleep-offload.js';
import { createCallerState, newRowsOn, type CallerState } from '../../api/callers.js';
import {
  DEFAULT_SHUTDOWN_DRAIN_MS,
  DETACHED_SETTLE_MS,
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
import {
  githubSiteFromEnv,
  githubTrustedUserIds,
  warnGitHubPreviousSecretOpen,
} from '../connectors/github/webhook.js';
import { warnSlackPreviousSecretOpen } from '../connectors/slack/webhook.js';
import { oauthBoot } from './oauth-resource.js';
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
  OAuthChallenge,
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
  if (path === '/mcp') res.setHeader(MCP_PROJECT_SCOPED_HEADER, '1');

  const routeRequest: RouteRequest = { req, res, opts, query };
  const request = { method, path };
  if (await dispatchProbeRoute(routeRequest, request, options)) return;

  enforceRateLimit(req, path, limiter);

  if (await dispatchLimitedRoute(routeRequest, method, path)) return;

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

async function dispatchLimitedRoute(
  r: RouteRequest,
  method: string,
  path: string,
): Promise<boolean> {
  if (await dispatchV1Route(r, method, path)) return true;
  if (dispatchPublicJson(r, method, path)) return true;
  if (await dispatchAddonRoute(r, method, path)) return true;
  return dispatchHostRoute(r, { method, path }, HOST_ROUTES.mcp, () =>
    handleMcpPost(r.req, r.res, r.opts),
  );
}

function sendHealth(
  req: IncomingMessage,
  res: ServerResponse,
  { startedAt, counts, workerCounts }: HandleRequestOptions,
): void {
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
  enableRequestTrail();
  const host = opts.host ?? DEFAULT_SERVER_HOST;
  const requestedPort = opts.port ?? Number(envPort() ?? DEFAULT_SERVER_PORT);
  const routes = frozenAddonRoutes(opts.routes);
  const oauth = oauthBoot(opts);
  const publicJsonBodies = new Map([...assertPublicJson(opts.publicJson ?? {}), ...oauth.bodies]);
  const limiters = bootLimiters(opts.rateLimits);
  assertClientIpHeaderPinned();
  assertFlagsValid();
  githubSiteFromEnv();
  githubTrustedUserIds();
  const loopbackHosts = await loopbackBindHosts(host);
  assertTlsOrCleartextAllowed(
    host,
    opts.tls,
    loopbackHosts,
    opts.allowCleartext ?? envAllowCleartext(),
  );
  warnSlackPreviousSecretOpen();
  warnGitHubPreviousSecretOpen();

  const startedAt = new Date().toISOString();
  await claimPidfile(opts.hippoRoot, startedAt);
  try {
    return await bindClaimed(opts, {
      host,
      requestedPort,
      routes,
      publicJsonBodies,
      oauthChallenge: oauth.challenge,
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
  oauthChallenge: OAuthChallenge | undefined;
  limiters: ReturnType<typeof bootLimiters>;
  startedAt: string;
}

async function bindClaimed(opts: ServeOptions, plan: BootPlan): Promise<ServerHandle> {
  const { host, requestedPort, startedAt } = plan;

  const runtime = defaultServerRuntime(opts.hippoRoot, {
    store: opts.store,
    queueMax: envStoreQueueMax(),
    ...evalStoreRules(envLossAversionRatio()),
    vectorGraphMaxVectors: loadConfig(opts.hippoRoot).vectorGraph.maxVectors,
  });
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
    await served.sleeps.settled();
    await runtime.close(DETACHED_SETTLE_MS);
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
  const routes = Object.freeze(
    (addonRoutes ?? []).map(({ path, handler, storeReady, level }) =>
      Object.freeze({
        path,
        handler,
        ...(storeReady !== undefined && { storeReady }),
        ...(level !== undefined && { level }),
      }),
    ),
  );
  assertAddonRoutes(routes);
  return routes;
}

function servedOptsFor(
  opts: ServeOptions,
  { routes, publicJsonBodies, oauthChallenge, limiters }: BootPlan,
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
  const sleepsHere = opts.autoSleep !== false && runtime.onHippoDb;
  const counted = sleepsHere && hasGroup(store, 'reports') ? store : undefined;
  const autoSleep = counted && { run, hostTenantId: envTenant(), newSince: newRowsOn(counted) };
  const callers = createCallerState(autoSleep);
  return {
    ...opts,
    routes,
    publicJsonBodies,
    oauthChallenge,
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
    detached: runtime.detached,
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

function servedFor(
  served: ResolvedServeOptions,
  runtime: ServerRuntime,
  { limits, session }: { readonly limits: RequestLimits; readonly session: StoreSession },
): ResolvedServeOptions {
  const views = new Map<HippoStore, HippoStore>();
  const storeFor = <S extends HippoStore>(own: S): S => {
    // SAFETY: each view was made by runtime.storeFor from the same `own`, so it has its type.
    const view = (views.get(own) as S | undefined) ?? runtime.storeFor(own, limits, session);
    views.set(own, view);
    return view;
  };
  return {
    ...served,
    store: storeFor(served.store),
    reachOf: (shared) => runtime.reachOf(shared, limits, session),
    storeFor,
    callers: served.callersFor(storeFor),
    ledgerStore: served.ledgerStore && storeFor(served.ledgerStore),
    signal: limits.signal,
  };
}

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
  removePidfileIfOwned(opts.hippoRoot, { pid: process.pid, startedAt });
  await drainAndClose(server, inflight, opts.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS);
}
