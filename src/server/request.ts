// Request plumbing: request ids, error replies, URL parsing and path matching.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isSqliteBusy, STORE_BUSY_MESSAGE } from '../db.js';
import { errorFields, log } from '../log.js';
import { HttpError, mapApiError, sendJson } from '../http-util.js';

// The caller's id lands in a response header and in logs, so only a short plain token is echoed back.
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** The caller's `X-Request-Id` when it is a short plain token, else a fresh UUID. */
export function resolveRequestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? undefined : header;
  return value && REQUEST_ID_RE.test(value) ? value : randomUUID();
}

/** One line per failed request; 4xx is the caller's mistake, so it stays below the default level and skips the stack. */
export function logRequestFailure<E>(req: IncomingMessage, err: E, requestId: string, status: number): void {
  const message = err instanceof Error ? err.message : String(err);
  const line = `${req.method ?? 'GET'} ${(req.url ?? '/').split('?')[0]} failed: ${message}`;
  if (status >= 500) log.error(line, { requestId, status, ...errorFields(err) });
  else log.info(line, { requestId, status });
}

/** The status and client message for a failed request; a held write lock is a retryable 503, never a 500. */
export function replyFor<E>(err: E): { status: number; message: string } {
  return isSqliteBusy(err) ? { status: 503, message: STORE_BUSY_MESSAGE } : mapApiError(err);
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

// The auth helpers only see the request, so its id rides here for their log lines.
export const requestIds = new WeakMap<IncomingMessage, string>();

/**
 * Reject URL-encoded slashes in path segments BEFORE the URL parser decodes
 * them — otherwise `%2F` becomes `/`, path-split runs, and the route either
 * silently 404s or matches the wrong template.
 *
 * codex round 3 P2: only scan the PATHNAME portion of the raw URL, not the
 * query string. Pre-fix, `?q=https%3A%2F%2Fexample.com` would 400 because
 * the regex matched `%2F` anywhere in `req.url`. Recall queries containing
 * URLs would have been rejected as bypass attempts. Splitting on the first
 * `?` confines the check to the path.
 */
export function rejectEncodedSlash(rawUrl: string): void {
  const queryIdx = rawUrl.indexOf('?');
  const pathname = queryIdx === -1 ? rawUrl : rawUrl.slice(0, queryIdx);
  if (/%2[Ff]/.test(pathname)) {
    throw new HttpError(400, 'URL-encoded slash (%2F) not allowed in path segments');
  }
}
