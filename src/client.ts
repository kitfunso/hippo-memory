/**
 * HTTP client wrapper for `hippo serve`.
 *
 * Only the writes the CLI routes (remember, forget, archive, promote), which are
 * also all HIPPO_REQUIRE_SERVER covers; every other command opens the store
 * directly. Each call returns the same shape that api.ts would.
 *
 * Errors from the server (4xx/5xx) are mapped back into thrown Errors with
 * the server's `error` message preserved verbatim so existing CLI handlers
 * that match on substrings (e.g. "not found", "already superseded") still
 * work unchanged.
 *
 * Network errors (ECONNREFUSED on a stale pidfile, etc.) propagate as the
 * native fetch failure so the caller can detect them and self-heal.
 */

import type { RememberOpts, RememberResult } from './api.js';

function buildHeaders(apiKey: string | undefined, withBody: boolean) {
  const headers: Record<string, string> = {};
  if (withBody) headers['content-type'] = 'application/json';
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return headers;
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** An error the server answered with, not one the transport raised. The
 *  refused-connection classifier sniffs message text, and a server message
 *  quotes the caller's own id or content back verbatim. */
export class HttpResponseError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HttpResponseError';
  }
}

/**
 * Throw an Error matching the server's error message. Keeps message strings
 * intact so cli.ts handlers can match on the same substrings ("not found",
 * "already superseded", "Unknown key_id") whether the call went through
 * api.ts or client.ts.
 */
async function throwForStatus(res: Response): Promise<never> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body: { error?: string } = await res.json();
    if (body && isNonEmptyString(body.error)) {
      message = body.error;
    }
  } catch {
    // body wasn't JSON; fall back to status line.
  }
  throw new HttpResponseError(message, res.status);
}

export async function remember(
  serverUrl: string,
  apiKey: string | undefined,
  opts: RememberOpts,
): Promise<RememberResult> {
  const res = await fetch(`${serverUrl}/v1/memories`, {
    method: 'POST',
    headers: buildHeaders(apiKey, true),
    body: JSON.stringify(opts),
  });
  if (!res.ok) await throwForStatus(res);
  const result: RememberResult = await res.json();
  return result;
}

export async function forget(
  serverUrl: string,
  apiKey: string | undefined,
  id: string,
): Promise<{ ok: true; id: string }> {
  const res = await fetch(`${serverUrl}/v1/memories/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: buildHeaders(apiKey, false),
  });
  if (!res.ok) await throwForStatus(res);
  const result: { ok: true; id: string } = await res.json();
  return result;
}

export async function promote(
  serverUrl: string,
  apiKey: string | undefined,
  id: string,
): Promise<{ ok: true; sourceId: string; globalId: string }> {
  const res = await fetch(`${serverUrl}/v1/memories/${encodeURIComponent(id)}/promote`, {
    method: 'POST',
    headers: buildHeaders(apiKey, false),
  });
  if (!res.ok) await throwForStatus(res);
  const result: { ok: true; sourceId: string; globalId: string } = await res.json();
  return result;
}

export async function archiveRaw(
  serverUrl: string,
  apiKey: string | undefined,
  id: string,
  reason: string,
): Promise<{ ok: true; archivedAt: string }> {
  const res = await fetch(`${serverUrl}/v1/memories/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
    headers: buildHeaders(apiKey, true),
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) await throwForStatus(res);
  const result: { ok: true; archivedAt: string } = await res.json();
  return result;
}

/**
 * How far a request got before the transport failed.
 *
 * 'never-sent' means the connection never opened, so the caller may safely
 * replay the call locally. 'delivery-unknown' means the socket broke with the
 * request already on the wire: the server may have committed it, so replaying a
 * write would store it twice. 'none' means this was not a transport failure.
 */
export type TransportFailure = 'none' | 'never-sent' | 'delivery-unknown';

function hasObjectCause(e: Error): e is Error & { cause: { code?: unknown } } {
  // Node's fs/net system errors (ECONNREFUSED, ECONNRESET) attach the syscall
  // code on a non-null object `cause`; the strict-equality checks below
  // validate the code value before it is used for anything.
  return typeof e.cause === 'object' && e.cause !== null;
}

export function classifyTransportFailure(err: unknown): TransportFailure {
  if (!(err instanceof Error)) return 'none';
  // The server answered, so the transport worked, whatever the message says.
  if (err instanceof HttpResponseError) return 'none';
  const message = err.message.toLowerCase();
  const code = hasObjectCause(err) ? err.cause.code : undefined;
  // Connect-phase failures: no request bytes ever left the client, so a stale
  // pidfile can be healed and the call replayed on the direct path.
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'never-sent';
  if (message.includes('econnrefused')) return 'never-sent';
  // The socket died mid-exchange. Node fetch surfaces this as a bare
  // 'fetch failed' with the syscall code on the cause, so check both shapes.
  if (code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') {
    return 'delivery-unknown';
  }
  if (message.includes('socket hang up') || message.includes('fetch failed')) return 'delivery-unknown';
  return 'none';
}
