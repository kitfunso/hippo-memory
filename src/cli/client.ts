/**
 * HTTP client wrapper for `hippo serve`: only the routed writes (remember, forget, archive, promote); every other
 * command opens the store directly.
 * Server errors rethrow with the message verbatim so CLI substring matches still work; network errors propagate as the
 * native fetch failure.
 */

import type { RememberOpts, RememberResult } from '../api/index.js';
import { fetchWithRetry } from '../util/http-retry.js';
import { readCappedJson } from '../util/capped-json.js';
import { isJsonObject, isJsonString, type JsonValue } from '../util/json.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import { isObjectLike } from '../core/capture-contract.js';

/** A write the local server has not answered in this long is stuck; the caller treats it as delivery-unknown. */
const SERVER_TIMEOUT_MS = 30_000;

/**
 * Five tries at the server's 1 s Retry-After keeps the roughly 5 s wait the CLI had before the server answered busy
 * with 503.
 */
const STORE_BUSY_ATTEMPTS = 5;

/**
 * Every routed write answers with a few short fields; the pidfile's port may now be another process, so cap what it
 * sends.
 */
const MAX_REPLY_BYTES = 1024 * 1024;

/**
 * The server sets Retry-After on a 503 only for a held write lock (server.ts replyFor); the auth-provider 503 has none.
 */
function isStoreBusy(res: Response): boolean {
  return res.status === 503 && res.headers.has('retry-after');
}

/**
 * Replaying is safe because each routed write commits in one transaction and anything after it is best-effort, so a
 * busy 503 means
 * nothing landed; a sleep is safe too, as a re-run finishes a partial one. */
function sendWrite(url: string, init: RequestInit): Promise<Response> {
  return fetchWithRetry(url, init, {
    timeoutMs: SERVER_TIMEOUT_MS,
    attempts: STORE_BUSY_ATTEMPTS,
    retryOn: isStoreBusy,
  });
}

function buildHeaders(apiKey: string | undefined, withBody: boolean) {
  const headers: Record<string, string> = {};
  if (withBody) headers['content-type'] = 'application/json';
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return headers;
}

/**
 * An error the server answered with, not one the transport raised, so the transport classifier can skip it by class.
 */
export class HttpResponseError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HttpResponseError';
  }
}

/** Throw an Error carrying the server's message verbatim, so cli.ts handlers can match the same substrings
 * ("not found", "already superseded") as on the direct path. */
async function throwForStatus(res: Response): Promise<never> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = await readCappedJson(res, MAX_REPLY_BYTES);
    if (isJsonObject(body) && isJsonString(body.error) && body.error.length > 0) {
      message = body.error;
    }
  } catch (err) {
    // body wasn't JSON or ran past the cap; fall back to status line.
    log.debug(`server error body unreadable (${errorMessage(err)}); using the status line`, errorFields(err));
  }
  throw new HttpResponseError(message, res.status);
}

/** A 2xx reply that is not the JSON object the route promises: another process may now own the pidfile's port. */
export class MalformedReplyError extends Error {
  constructor(readonly route: string, detail: string) {
    super(`the hippo server's reply to ${route} was not the expected JSON object (${detail})`);
    this.name = 'MalformedReplyError';
  }
}

/**
 * A 2xx reply's body, read under the cap; it must be a JSON object, and `guard` narrows it further where the shape is
 * known.
 */
async function readReply<T>(
  res: Response,
  route: string,
  guard?: (body: { [key: string]: JsonValue }) => boolean,
): Promise<T> {
  const body = await readCappedJson(res, MAX_REPLY_BYTES);
  if (!isJsonObject(body)) {
    throw new MalformedReplyError(route, body === null ? 'null' : Array.isArray(body) ? 'array' : 'a scalar');
  }
  if (guard && !guard(body)) throw new MalformedReplyError(route, 'unexpected fields');
  const reply: JsonValue = body;
  // SAFETY: the reply comes from hippo's own server, whose route returns this api result as JSON.
  return reply as T;
}

export async function remember(
  serverUrl: string,
  apiKey: string | undefined,
  opts: RememberOpts,
): Promise<RememberResult> {
  const res = await sendWrite(`${serverUrl}/v1/memories`, {
    method: 'POST',
    headers: buildHeaders(apiKey, true),
    body: JSON.stringify(opts),
  });
  if (!res.ok) await throwForStatus(res);
  return readReply<RememberResult>(res, 'POST /v1/memories');
}

export async function forget(
  serverUrl: string,
  apiKey: string | undefined,
  id: string,
): Promise<{ ok: true; id: string }> {
  const res = await sendWrite(`${serverUrl}/v1/memories/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: buildHeaders(apiKey, false),
  });
  if (!res.ok) await throwForStatus(res);
  return readReply<{ ok: true; id: string }>(res, 'DELETE /v1/memories/:id', (b) => isJsonString(b.id));
}

export async function promote(
  serverUrl: string,
  apiKey: string | undefined,
  id: string,
): Promise<{ ok: true; sourceId: string; globalId: string }> {
  const res = await sendWrite(`${serverUrl}/v1/memories/${encodeURIComponent(id)}/promote`, {
    method: 'POST',
    headers: buildHeaders(apiKey, false),
  });
  if (!res.ok) await throwForStatus(res);
  return readReply<{ ok: true; sourceId: string; globalId: string }>(res, 'POST /v1/memories/:id/promote',
    (b) => isJsonString(b.sourceId) && isJsonString(b.globalId));
}

export async function archiveRaw(
  serverUrl: string,
  apiKey: string | undefined,
  id: string,
  reason: string,
): Promise<{ ok: true; archivedAt: string }> {
  const res = await sendWrite(`${serverUrl}/v1/memories/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
    headers: buildHeaders(apiKey, true),
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) await throwForStatus(res);
  return readReply<{ ok: true; archivedAt: string }>(res, 'POST /v1/memories/:id/archive', (b) =>
    isJsonString(b.archivedAt),
  );
}

/**
 * 'never-sent': connection never opened, safe to replay locally. 'delivery-unknown': the request was on the wire and
 * may have
 * committed, so never replay a write. 'none': not a transport failure. */
export type TransportFailure = 'none' | 'never-sent' | 'delivery-unknown';

/**
 * The syscall code Node puts on a system error itself (`http` errors) or on the `cause` of a fetch `TypeError`; '' when
 * there is none.
 */
function transportCode(err: Error): string {
  if ('code' in err) return String(err.code);
  // Node's fetch attaches the syscall code (ECONNREFUSED, ECONNRESET) on a non-null object `cause`.
  const cause: unknown = err.cause;
  return isObjectLike(cause) && 'code' in cause ? String(cause.code) : '';
}

export function classifyTransportFailure(err: Error): TransportFailure {
  // The server answered, so the transport worked, whatever the message says.
  if (err instanceof HttpResponseError) return 'none';
  const code = transportCode(err);
  // Connect-phase failures: no request bytes ever left the client, so a stale
  // pidfile can be healed and the call replayed on the direct path.
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'never-sent';
  // The socket died mid-exchange.
  if (code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') {
    return 'delivery-unknown';
  }
  // Fetch rejects every network failure as a TypeError, with a cause only when the syscall is known, so no code means
  // the conservative answer.
  if (err instanceof TypeError) return 'delivery-unknown';
  // The request was sent and the server went quiet, so it may have committed.
  if (err.name === 'TimeoutError') return 'delivery-unknown';
  return 'none';
}
