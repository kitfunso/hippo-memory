// Request plumbing: request ids, error replies, URL parsing and path matching.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isStoreBusy, STORE_BUSY_MESSAGE } from '../db.js';
import { errorFields, errorMessage, log } from '../log.js';
import { HttpError, mapApiError, sendJson } from '../http-util.js';

// The caller's id lands in a response header and in logs, so only a short plain token is echoed back.
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** The caller's `X-Request-Id` when it is a short plain token, else a fresh UUID. */
function resolveRequestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? undefined : header;
  return value && REQUEST_ID_RE.test(value) ? value : randomUUID();
}

/** One line per failed request; 4xx is the caller's mistake, a busy 503 is back-pressure and a 501 is a route not on this store, so none logs as an error. */
export function logRequestFailure<E>(req: IncomingMessage, err: E, status: number): void {
  const message = errorMessage(err);
  const line = `${req.method ?? 'GET'} ${(req.url ?? '/').split('?')[0]} failed: ${message}`;
  if (isStoreBusy(err)) log.warn(line, { status });
  else if (status >= 500 && status !== 501) log.error(line, { status, ...errorFields(err) });
  else log.info(line, { status });
}

/** The status and client message for a failed request; a held write lock is a retryable 503, never a 500. */
export function replyFor<E>(err: E): { status: number; message: string } {
  return isStoreBusy(err) ? { status: 503, message: STORE_BUSY_MESSAGE } : mapApiError(err);
}

// Above the 30 s body deadline and the 5 s resolver deadline, so a request those govern is answered before it is called slow.
const SLOW_REQUEST_WARN_MS = 60_000;

/** Logs one warn when `res` has sent nothing after `afterMs`. It never ends the request or touches the reply; the timer goes when the reply finishes or the socket closes. */
function watchSlowRequest(req: IncomingMessage, res: ServerResponse, requestId: string, afterMs: number = SLOW_REQUEST_WARN_MS): void {
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    // A reply already under way is a stream doing its job, not a stuck request.
    if (res.headersSent) return;
    log.warn(`${req.method ?? 'GET'} ${(req.url ?? '/').split('?')[0]} is still running`, { requestId, elapsedMs: Date.now() - startedAt });
  }, afterMs);
  // The watchdog alone must never keep the process alive.
  timer.unref();
  const clear = (): void => clearTimeout(timer);
  res.once('finish', clear);
  res.once('close', clear);
}

/** What the route layer learned about a request, for its access line. */
interface AccessNote {
  route?: string;
  tenant?: string;
}

const accessNotes = new WeakMap<IncomingMessage, AccessNote>();

// A path that matched no route is caller data, so the access line never repeats it.
const UNMATCHED_ROUTE = 'unmatched';

/** Names the matched route (the table's pattern, never the path sent) or the caller's tenant for the request's access line. */
export function noteAccess(req: IncomingMessage, note: AccessNote): void {
  const held = accessNotes.get(req);
  if (held) Object.assign(held, note);
}

/** One info line per finished request. A path id and a query string can both hold caller data, so the line carries neither. */
function logAccessWhenFinished(req: IncomingMessage, res: ServerResponse, requestId: string): void {
  const note: AccessNote = {};
  accessNotes.set(req, note);
  const startedAt = performance.now();
  res.once('finish', () => {
    log.info('request', {
      requestId,
      method: req.method ?? 'GET',
      route: note.route ?? UNMATCHED_ROUTE,
      status: res.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
      tenant: note.tenant,
    });
  });
}

/** The request's id, after stamping the headers every reply carries and starting the slow-request watchdog and the access line. */
export function openRequest(req: IncomingMessage, res: ServerResponse, slowWarnMs?: number): string {
  const requestId = resolveRequestId(req.headers['x-request-id']);
  res.setHeader('X-Request-Id', requestId);
  // Memory text is caller-written, so no browser may guess a reply into HTML or script.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  watchSlowRequest(req, res, requestId, slowWarnMs);
  logAccessWhenFinished(req, res, requestId);
  return requestId;
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

interface ParsedRoute {
  method: string;
  path: string;
  query: URLSearchParams;
}

export function parseRequest(req: IncomingMessage): ParsedRoute {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://placeholder');
  } catch (e) {
    // A request target the URL parser rejects is the caller's fault, not a server failure.
    if (e instanceof TypeError) throw new HttpError(400, e.message);
    throw e;
  }
  return {
    method: req.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
  };
}

/**
 * Lightweight pattern matcher for /v1/memories/:id/<action>. Avoids pulling
 * in a router dependency for the half-dozen patterns we actually use.
 *
 * Returns null if `path` does not match `pattern`. Otherwise returns an object
 * mapping each :param name to its value. Path segments are exact-matched
 * except for parameter slots.
 */
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (e) {
    if (e instanceof URIError) throw new HttpError(400, e.message);
    throw e;
  }
}

export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i]!;
    const ap = pathParts[i]!;
    if (pp.startsWith(':')) {
      if (ap.length === 0) return null;
      params[pp.slice(1)] = decodePathSegment(ap);
    } else if (pp !== ap) {
      return null;
    }
  }
  return params;
}

/**
 * Reject URL-encoded slashes in path segments BEFORE the URL parser decodes
 * them — otherwise `%2F` becomes `/`, path-split runs, and the route either
 * silently 404s or matches the wrong template.
 *
 * Only the PATHNAME is scanned (split on the first `?`), so recall queries
 * containing URLs like `?q=https%3A%2F%2Fexample.com` are not rejected.
 */
export function rejectEncodedSlash(rawUrl: string): void {
  const queryIdx = rawUrl.indexOf('?');
  const pathname = queryIdx === -1 ? rawUrl : rawUrl.slice(0, queryIdx);
  if (/%2[Ff]/.test(pathname)) {
    throw new HttpError(400, 'URL-encoded slash (%2F) not allowed in path segments');
  }
}
