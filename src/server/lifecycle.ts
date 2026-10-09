// Graceful shutdown and the socket deadlines for hippo's HTTP listeners: the API server and the dashboard.
import type { Server, ServerResponse } from 'node:http';
import { bodyDeadlineMs } from '../util/http-util.js';
import { log } from '../util/log.js';

// Node's own default, named so the three socket deadlines read together. It times the request arriving, never the handler, so a 10 minute sleep is not cut.
const REQUEST_RECEIVE_TIMEOUT_MS = 300_000;

export function setKeepAliveTimeouts(server: Server): void {
  // The default 5s keepAliveTimeout closes idle sockets just as clients reuse them (ECONNRESET).
  // headersTimeout must stay ABOVE keepAliveTimeout + keepAliveTimeoutBuffer (1s), or it closes idle reused sockets itself.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  // Never below what a raised body deadline allows, or Node's bare 408 would come before the route's own.
  server.requestTimeout = Math.max(REQUEST_RECEIVE_TIMEOUT_MS, server.headersTimeout + bodyDeadlineMs());
}

export const DEFAULT_SHUTDOWN_DRAIN_MS = 5000;

// Past the request drain, a stop only waits for each store thread to end its statement and close: seconds at most, so longer means a thread that will not end.
const STORE_CLOSE_GRACE_MS = 10_000;

/** How long a signal or crash shutdown may run before the process is ended without it. */
export function shutdownBoundMs(drainMs: number): number {
  return drainMs + STORE_CLOSE_GRACE_MS;
}

/**
 * Stop accepting, end streams at once (they never finish on their own), give other in-flight
 * requests up to `drainMs`, then close whatever is left.
 */
export async function drainAndClose(server: Server, inflight: ReadonlySet<ServerResponse>, drainMs: number): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  server.closeIdleConnections?.();
  for (const res of inflight) {
    if (res.headersSent && !res.writableEnded) res.destroy();
    else if (!res.headersSent) res.setHeader('Connection', 'close');
  }
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), drainMs);
  });
  const late = await Promise.race([closed.then(() => false), timedOut]);
  clearTimeout(timer);
  if (late) {
    log.warn(`shutdown: ${inflight.size} request(s) still running after ${drainMs} ms; closing them`);
    server.closeAllConnections?.();
  }
  await closed;
}
