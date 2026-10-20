// The deadline of a served request: past it the caller gets a 504 and the request's abort signal fires, whatever the
// handler is still waiting on.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { envRequestDeadlineMs } from '../../base/util/env.js';
import { RequestDeadline, requestDeadlineMs } from '../../base/util/request-scope.js';

// Each has a deadline of its own kind: sleep stops its child process, and the stream is meant to stay open.
const EXEMPT = new Set(['POST /v1/sleep', 'GET /mcp/stream']);

const abandoned = new WeakSet<ServerResponse>();

/** Whether `res` was answered at its deadline, so whatever its handler does later has no caller. */
export function isAbandoned(res: ServerResponse): boolean {
  return abandoned.has(res);
}

/** The deadline of `req`, for every /v1, /mcp and dashboard /api route but the two exempt ones. */
export function requestDeadlineFor(req: IncomingMessage): RequestDeadline | undefined {
  const ms = requestDeadlineMs(envRequestDeadlineMs());
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (ms === 0 || EXEMPT.has(`${req.method ?? 'GET'} ${path}`)) return undefined;
  const timed = path.startsWith('/v1/') || path.startsWith('/api/') || path === '/mcp';
  return timed ? new RequestDeadline(Date.now() + ms) : undefined;
}

/**
 * Calls `reply` when `res` has sent nothing by `deadline`. A store call still in flight answers first, since only the
 * store knows what became of a write.
 */
export function answerAtDeadline(
  res: ServerResponse,
  deadline: RequestDeadline,
  reply: () => void,
  onDeadline: () => void = () => {},
): void {
  const expire = (): void => {
    if (res.headersSent || res.destroyed) return;
    abandoned.add(res);
    reply();
  };
  // One turn of the loop later, so a handler that fails on the store's answer sends that answer itself.
  const timer = setTimeout(() => {
    // Before the wait for store calls, so a call still queued is dropped rather than run for a caller who left.
    onDeadline();
    deadline.onceIdle(() => setImmediate(expire));
  }, deadline.at - Date.now());
  // The open socket keeps the process alive; this timer alone must not.
  timer.unref();
  const clear = (): void => clearTimeout(timer);
  res.once('finish', clear);
  res.once('close', clear);
}
