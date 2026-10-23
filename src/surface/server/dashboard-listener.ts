// `hippo dashboard` on the API server's own listener code: request ids, deadlines, body limits, error replies and the
// drain come from boot.ts and lifecycle.ts; only the route table and its session are the dashboard's.
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { adminActor } from '../../api/index.js';
import { configReader } from '../../host/config-file.js';
import { evalNow } from '../../base/memory/ablation.js';
import { loadStaticFiles } from '../dashboard/static-file.js';
import { defaultServerRuntime, type ServerRuntime } from '../open-store.js';
import { installSignalHandlers } from '../../base/util/crash-handlers.js';
import { envLossAversionRatio, envRuntimeSettings } from '../../base/util/env.js';
import { bodyDeadlineMs } from '../../base/util/http-util.js';
import { answerRequest, listenOn } from './boot.js';
import { startDashboardReader } from './dashboard-reader.js';
import { answerDashboard, type DashboardServing } from './dashboard-routes.js';
import { DEFAULT_SHUTDOWN_DRAIN_MS, drainAndClose, setKeepAliveTimeouts, shutdownBoundMs } from './lifecycle.js';
import { createListener } from './tls.js';
import type { ServerHandle } from './types.js';
import { rootInfra } from '../../infra/ports.js';

// The audit log's actor for every dashboard write.
const DASHBOARD_ACTOR = 'dashboard';
// Loopback only: the token guards the memories from other local users, never from the network.
const DASHBOARD_HOST = '127.0.0.1';

export interface DashboardOpts {
  readonly hippoRoot: string;
  /** The tenant the CLI root resolved; the dashboard reads and writes as it. */
  readonly tenantId: string;
  readonly port: number;
  /** The per-start secret the printed URL carries. */
  readonly token: string;
  /** Dates the strength projections; the eval clock when unset. */
  readonly now?: () => number;
  /** Ages the snapshot id; the wall clock when unset. */
  readonly cacheClock?: () => number;
  /** Stop and exit on SIGINT or SIGTERM; only `hippo dashboard` sets it. */
  readonly handleSignals?: boolean;
  /** The HIPPO_BODY_TIMEOUT_MS value the CLI read; 30 s when unset. */
  readonly bodyDeadlineMs?: number;
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

/** What every request shares: the reader thread on its own store connection, and a Context on the store's workers. */
function servingFor(opts: DashboardOpts, { store, offLoop, host }: ServerRuntime): DashboardServing {
  const { hippoRoot, tenantId } = opts;
  const now = opts.now ?? ((): number => evalNow().getTime());
  const configAt = configReader(envRuntimeSettings);
  const infra = rootInfra(host);
  return {
    access: { token: opts.token, port: opts.port },
    reader: startDashboardReader({ hippoRoot, tenantId }, { now, cacheClock: opts.cacheClock ?? Date.now }),
    context: () => ({
      hippoRoot,
      tenantId,
      actor: adminActor(DASHBOARD_ACTOR),
      store,
      config: configAt(hippoRoot),
      infra: infra(),
    }),
    bodyDeadlineMs: bodyDeadlineMs(opts.bodyDeadlineMs),
    staticFiles: loadStaticFiles(),
    offLoop,
  };
}

/** Serves the dashboard on 127.0.0.1 behind the per-start `token`; it never claims the API server's pidfile, so both
 * can serve one store. */
export async function serveDashboard(opts: DashboardOpts): Promise<ServerHandle> {
  const runtime = defaultServerRuntime(opts.hippoRoot, { lossAversionRatio: envLossAversionRatio() });
  const serving = servingFor(opts, runtime);
  const inflight = new Set<ServerResponse>();
  // Its own count: the dashboard serves no /health, so its late handlers never mix into the API server's.
  const counts = { handlerDeadlines: 0 };
  const server = createListener(undefined, (req, res) => {
    res.once('finish', runtime.afterResponse);
    inflight.add(res);
    res.once('close', () => inflight.delete(res));
    answerRequest(req, res, () => runtime.runRequest(() => answerDashboard(serving, req, res)), {
      slowWarnMs: undefined,
      counts,
    });
  });
  setKeepAliveTimeouts(server);
  // The reader thread closes before the runtime, which closes its held connection last, so that close is the last.
  const release = async (): Promise<void> => {
    await serving.reader.close();
    await runtime.close();
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
    installSignalHandlers('dashboard', { run: stop, boundMs: shutdownBoundMs(DEFAULT_SHUTDOWN_DRAIN_MS) });
  }
  // SAFETY: listenOn bound a TCP port, so address() is an AddressInfo.
  const { port } = server.address() as AddressInfo;
  return { port, url: `http://${DASHBOARD_HOST}:${port}`, stop, server };
}
