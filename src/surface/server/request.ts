import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isStoreBusy, STORE_BUSY_MESSAGE } from '../../base/ports/store.js';
import { errorClassFields, errorFields, errorMessage, log } from '../../base/util/log.js';
import { mapApiError } from '../../api/error-reply.js';
import { HttpError } from '../../base/errors/http-errors.js';
import { sendJson } from '../http/http-util.js';
import { MINUTE_MS } from '../../base/util/time.js';
import type { RouteParams } from './types.js';
import type { Role } from '../../base/scope/role.js';

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function resolveRequestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? undefined : header;
  return value && REQUEST_ID_RE.test(value) ? value : randomUUID();
}

/**
 * One line per failed request, naming the route template since a path can hold caller data; 4xx is
 * the caller's mistake, a busy 503 is back-pressure and a 501 is a route not on this store, so none
 * logs as an error.
 */
export function logRequestFailure<E>(req: IncomingMessage, err: E, status: number): void {
  const message = errorMessage(err);
  const line = `${req.method ?? 'GET'} ${accessRouteOf(req)} failed: ${message}`;
  if (
    isStoreBusy(err) ||
    (status >= 500 && err instanceof HttpError && err.retryAfterSec !== undefined)
  ) {
    log.warn(line, { status, ...errorClassFields(err) });
  } else if (status >= 500 && status !== 501) {
    log.error(line, { status, ...errorFields(err) });
  } else if (status === 401 || status === 403) {
    log.warn(line, { status, ...errorClassFields(err) });
  } else {
    log.trail(line, { status, ...errorClassFields(err) });
  }
}

/** The status and client message for a failed request; a held write lock is a retryable 503,
 * never a 500. */
export function replyFor<E>(err: E): { status: number; message: string } {
  return isStoreBusy(err) ? { status: 503, message: STORE_BUSY_MESSAGE } : mapApiError(err);
}

const SLOW_REQUEST_WARN_MS = MINUTE_MS;

function watchSlowRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  afterMs: number = SLOW_REQUEST_WARN_MS,
): void {
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    if (res.headersSent) return;
    log.warn(`${req.method ?? 'GET'} ${accessRouteOf(req)} is still running`, {
      requestId,
      elapsedMs: Date.now() - startedAt,
    });
  }, afterMs);
  timer.unref();
  const clear = (): void => clearTimeout(timer);
  res.once('finish', clear);
  res.once('close', clear);
}

interface AccessNote {
  route?: string;
  tenant?: string;
  role?: Role;
}

const accessNotes = new WeakMap<IncomingMessage, AccessNote>();

const UNMATCHED_ROUTE = 'unmatched';

/**
 * Names the matched route (the table's pattern, never the path sent), the caller's tenant or its role for the
 * request's access line.
 */
export function noteAccess(req: IncomingMessage, note: AccessNote): void {
  const held = accessNotes.get(req);
  if (held) Object.assign(held, note);
}

/** The route name the request's access line carries, for a line about the same request logged
 * after its reply. */
export function accessRouteOf(req: IncomingMessage): string {
  return accessNotes.get(req)?.route ?? UNMATCHED_ROUTE;
}

function logAccessWhenFinished(req: IncomingMessage, res: ServerResponse, requestId: string): void {
  const note: AccessNote = {};
  accessNotes.set(req, note);
  const startedAt = performance.now();
  res.once('finish', () => {
    log.trail('request', {
      requestId,
      method: req.method ?? 'GET',
      route: note.route ?? UNMATCHED_ROUTE,
      status: res.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
      tenant: note.tenant,
      role: note.role,
    });
  });
}

/**
 * The request's id, after stamping the headers every reply carries and starting the slow-request
 * watchdog and the access line.
 */
export function openRequest(
  req: IncomingMessage,
  res: ServerResponse,
  slowWarnMs?: number,
): string {
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

/** Ends the reply; a socket that refuses is logged under the request's id, once, since no other
 * reply can follow. */
export function endReply(res: ServerResponse): void {
  try {
    res.end();
  } catch (err) {
    log.warn('could not end the reply', errorFields(err));
  }
}

/** True when the socket took the chunk; one that refuses is logged under the request's id and is
 * not written again. */
export function writeChunk(res: ServerResponse, chunk: string): boolean {
  try {
    res.write(chunk);
    return true;
  } catch (err) {
    log.warn('could not write to the reply', errorFields(err));
    return false;
  }
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
    if (e instanceof TypeError) throw new HttpError(400, e.message);
    throw e;
  }
  return {
    method: req.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
  };
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (e) {
    if (e instanceof URIError) throw new HttpError(400, e.message);
    throw e;
  }
}

export const INT_PARAM = '(int)';
const DIGITS = /^\d+$/;

function paramName(spec: string): string {
  return spec.slice(1, spec.endsWith(INT_PARAM) ? -INT_PARAM.length : undefined);
}

function paramValue(spec: string, segment: string): string | null {
  if (spec.endsWith(INT_PARAM)) return DIGITS.test(segment) ? segment : null;
  return segment.length === 0 ? null : decodePathSegment(segment);
}

/** The params of a pattern such as `/v1/policies/:id(int)/close`, by name, or null when `path`
 * is another path. */
export function matchPath(pattern: string, path: string): RouteParams | null {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i]!;
    const ap = pathParts[i]!;
    if (!pp.startsWith(':')) {
      if (pp !== ap) return null;
      continue;
    }
    const value = paramValue(pp, ap);
    if (value === null) return null;
    params[paramName(pp)] = value;
  }
  return params;
}

/**
 * Rejects URL-encoded slashes in path segments BEFORE the URL parser decodes them (`%2F` would
 * become `/` and 404 or match the wrong template). Only the PATHNAME is scanned, so recall
 * queries like `?q=https%3A%2F%2Fexample.com` are not rejected. */
export function rejectEncodedSlash(rawUrl: string): void {
  const queryIdx = rawUrl.indexOf('?');
  const pathname = queryIdx === -1 ? rawUrl : rawUrl.slice(0, queryIdx);
  if (/%2[Ff]/.test(pathname)) {
    throw new HttpError(400, 'URL-encoded slash (%2F) not allowed in path segments');
  }
}
