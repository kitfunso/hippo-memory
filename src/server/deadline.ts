// The deadline of a served request: past it the caller gets a 504, whatever the handler is still waiting on.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { envRequestDeadlineMs } from '../env.js';
import { RequestDeadline } from '../util/request-scope.js';

const DEFAULT_REQUEST_DEADLINE_MS = 120_000;

// Each has a deadline of its own kind: sleep stops its child process, and the stream is meant to stay open.
const EXEMPT = new Set(['POST /v1/sleep', 'GET /mcp/stream']);

const abandoned = new WeakSet<ServerResponse>();
let handlerDeadlines = 0;

/** Requests answered 504 by the handler deadline since the process started; /health reports it. */
export function handlerDeadlineCount(): number {
  return handlerDeadlines;
}

/** Whether `res` was answered at its deadline, so whatever its handler does later has no caller. */
export function isAbandoned(res: ServerResponse): boolean {
  return abandoned.has(res);
}

/** How long a request may run: 120 s, or HIPPO_REQUEST_DEADLINE_MS, where 0 turns the deadline off. */
export function requestDeadlineMs(): number {
  return envRequestDeadlineMs() ?? DEFAULT_REQUEST_DEADLINE_MS;
}

/** The deadline of `req`, for every /v1 and /mcp route but the two exempt ones. */
export function requestDeadlineFor(req: IncomingMessage): RequestDeadline | undefined {
  const ms = requestDeadlineMs();
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (ms === 0 || EXEMPT.has(`${req.method ?? 'GET'} ${path}`)) return undefined;
  return path.startsWith('/v1/') || path === '/mcp' ? new RequestDeadline(Date.now() + ms) : undefined;
}

/** Calls `reply` when `res` has sent nothing by `deadline`. A store call still in flight answers first, since only the store knows what became of a write. */
export function answerAtDeadline(res: ServerResponse, deadline: RequestDeadline, reply: () => void): void {
  const expire = (): void => {
    if (res.headersSent || res.destroyed) return;
    handlerDeadlines += 1;
    abandoned.add(res);
    reply();
  };
  // One turn of the loop later, so a handler that fails on the store's answer sends that answer itself.
  const timer = setTimeout(() => deadline.onceIdle(() => setImmediate(expire)), deadline.at - Date.now());
  // The open socket keeps the process alive; this timer alone must not.
  timer.unref();
  const clear = (): void => clearTimeout(timer);
  res.once('finish', clear);
  res.once('close', clear);
}
