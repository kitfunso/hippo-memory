// Graceful shutdown for the HTTP server.
import type { Server, ServerResponse } from 'node:http';
import { log } from '../log.js';

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
