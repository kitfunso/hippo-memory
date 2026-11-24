import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { adminActor } from '../../api/index.js';
import { requireGroups } from '../../base/ports/store.js';
import { DASHBOARD_GROUPS } from './dashboard-types.js';
import { configReader } from '../../host/config-file.js';
import { evalClock, evalStoreRules } from '../../infra/eval-switches.js';
import { loadStaticFiles } from '../dashboard/static-file.js';
import { defaultServerRuntime, type ServerRuntime } from '../open-store.js';
import { installSignalHandlers } from '../../base/util/crash-handlers.js';
import { envLossAversionRatio, envRuntimeSettings } from '../../base/util/env.js';
import { bodyDeadlineMs } from '../http/http-util.js';
import { listenOn } from './boot.js';
import { answerRequest } from './failure-replies.js';
import { startDashboardReader } from './dashboard-reader.js';
import { answerDashboard, type DashboardServing } from './dashboard-routes.js';
import { dashboardTickets } from './dashboard-session.js';
import {
  DEFAULT_SHUTDOWN_DRAIN_MS,
  DETACHED_SETTLE_MS,
  drainAndClose,
  setKeepAliveTimeouts,
  shutdownBoundMs,
} from './lifecycle.js';
import { createListener } from './tls.js';
import type { ServerHandle } from './types.js';
import { rootInfra } from '../../infra/ports.js';

const DASHBOARD_ACTOR = 'dashboard';
const DASHBOARD_HOST = '127.0.0.1';

export interface DashboardOptions {
  readonly hippoRoot: string;
  readonly tenantId: string;
  readonly port: number;
  readonly token: string;
  readonly now?: () => number;
  readonly cacheClock?: () => number;
  readonly handleSignals?: boolean;
  readonly bodyDeadlineMs?: number;
}

/** A running dashboard, which hands out the one-time tickets its URL carries. */
export interface DashboardHandle extends ServerHandle {
  readonly ticket: () => string;
}

/** The listener failed to bind, so the CLI can tell a busy port from any other failure. */
export class DashboardListenError extends Error {
  constructor(
    readonly port: number,
    cause: Error,
  ) {
    super(cause.message, { cause });
    this.name = 'DashboardListenError';
  }
}

function servingFor(
  opts: DashboardOptions,
  { store, storeFor, host }: ServerRuntime,
): DashboardServing {
  const { hippoRoot, tenantId } = opts;
  const clock = evalClock();
  const now = opts.now ?? ((): number => clock().getTime());
  const configAt = configReader(envRuntimeSettings);
  const infra = rootInfra(host);
  const dashboardStore = requireGroups(store, DASHBOARD_GROUPS);
  return {
    access: { token: opts.token, port: opts.port, tickets: dashboardTickets() },
    reader: startDashboardReader(
      { hippoRoot, tenantId },
      { now, cacheClock: opts.cacheClock ?? Date.now },
    ),
    context: (limits) => ({
      hippoRoot,
      tenantId,
      actor: adminActor(DASHBOARD_ACTOR),
      store: storeFor(dashboardStore, limits),
      config: configAt(hippoRoot),
      infra: infra(),
      signal: limits.signal,
    }),
    bodyDeadlineMs: bodyDeadlineMs(opts.bodyDeadlineMs),
    staticFiles: loadStaticFiles(),
  };
}

/** Serves the dashboard on 127.0.0.1 behind its tickets and the cookies they buy; it never
 * claims the API server's pidfile, so both can serve one store. */
export async function serveDashboard(opts: DashboardOptions): Promise<DashboardHandle> {
  const runtime = defaultServerRuntime(opts.hippoRoot, evalStoreRules(envLossAversionRatio()));
  const serving = servingFor(opts, runtime);
  const inflight = new Set<ServerResponse>();
  const server = dashboardListener(serving, runtime, inflight);
  setKeepAliveTimeouts(server);
  const release = async (): Promise<void> => {
    await serving.reader.close();
    await runtime.close(DETACHED_SETTLE_MS);
  };
  try {
    await listenOn(server, opts.port, DASHBOARD_HOST);
  } catch (err) {
    await release();
    throw err instanceof Error ? new DashboardListenError(opts.port, err) : err;
  }
  runtime.hold();
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= drainAndClose(server, inflight, DEFAULT_SHUTDOWN_DRAIN_MS).finally(release);
    return stopping;
  };
  if (opts.handleSignals) {
    installSignalHandlers('dashboard', {
      run: stop,
      boundMs: shutdownBoundMs(DEFAULT_SHUTDOWN_DRAIN_MS),
    });
  }
  // SAFETY: listenOn bound a TCP port, so address() is an AddressInfo.
  const { port } = server.address() as AddressInfo;
  const ticket = (): string => serving.access.tickets.mint(Date.now());
  return { port, url: `http://${DASHBOARD_HOST}:${port}`, stop, server, ticket };
}

function dashboardListener(
  serving: DashboardServing,
  runtime: ServerRuntime,
  inflight: Set<ServerResponse>,
): Server {
  const counts = { handlerDeadlines: 0 };
  return createListener(undefined, (req, res) => {
    res.once('finish', runtime.afterResponse);
    inflight.add(res);
    res.once('close', () => inflight.delete(res));
    answerRequest(req, res, (limits) => answerDashboard(serving, { req, res, limits }), {
      slowWarnMs: undefined,
      counts,
    });
  });
}
