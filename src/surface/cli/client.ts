/**
 * HTTP client wrapper for `hippo serve`: the routed writes (remember, forget, archive, promote) and
 * the nearest-vector read; every other command opens the store directly. Server errors rethrow with
 * the message verbatim so CLI substring matches still work; network errors propagate as the native
 * fetch failure.
 */

import type { RememberOptions, RememberResult, RememberSkipped } from '../../api/index.js';
import { fetchWithRetry } from '../../infra/http-retry.js';
import { readCappedJson } from '../../base/util/capped-json.js';
import { MAX_REPLY_BYTES } from '../../base/util/limits.js';
import { isJsonObject, isJsonString, type JsonValue } from '../../base/util/json.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { isObjectLike } from '../../base/session/capture-contract.js';

/** A write the local server has not answered in this long is stuck; the caller treats it as
 * delivery-unknown. */
const SERVER_TIMEOUT_MS = 30_000;

/**
 * Five tries at the server's 1 s Retry-After keeps the roughly 5 s wait the CLI had before the
 * server answered busy with 503.
 */
const STORE_BUSY_ATTEMPTS = 5;

/**
 * The server sets Retry-After on a 503 only for a held write lock (server.ts replyFor); the
 * auth-provider 503 has none.
 */
function isStoreBusy(res: Response): boolean {
  return res.status === 503 && res.headers.has('retry-after');
}

/**
 * Replaying is safe because each routed write commits in one transaction and anything after it
 * is best-effort, so a busy 503 means nothing landed; a sleep is safe too, as a re-run finishes
 * a partial one. */
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
 * An error the server answered with, not one the transport raised, so the transport classifier can
 * skip it by class.
 */
export class HttpResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HttpResponseError';
  }
}

/** Throw an Error carrying the server's message verbatim, so cli.ts handlers can match the same
 * substrings ("not found", "already superseded") as on the direct path. */
async function throwForStatus(res: Response): Promise<never> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = await readCappedJson(res, MAX_REPLY_BYTES);
    if (isJsonObject(body) && isJsonString(body.error) && body.error.length > 0) {
      message = body.error;
    }
  } catch (err) {
    // body wasn't JSON or ran past the cap; fall back to status line.
    log.debug(
      `server error body unreadable (${errorMessage(err)}); using the status line`,
      errorFields(err),
    );
  }
  throw new HttpResponseError(message, res.status);
}

/** A 2xx reply that is not the JSON object the route promises: another process may now own the
 * pidfile's port. */
export class MalformedReplyError extends Error {
  constructor(
    readonly route: string,
    detail: string,
    cause?: unknown,
  ) {
    super(
      `the hippo server's reply to ${route} was not the expected JSON object (${detail})`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'MalformedReplyError';
  }
}

/** A 2xx body under the cap: the plain Errors `readCappedJson` throws become a MalformedReplyError,
 * and a transport error keeps its class. */
async function readReplyBody(res: Response, route: string): Promise<JsonValue> {
  try {
    return await readCappedJson(res, MAX_REPLY_BYTES);
  } catch (err) {
    if (err instanceof Error && err.constructor === Error) {
      throw new MalformedReplyError(route, err.message, err);
    }
    throw err;
  }
}

/**
 * A 2xx reply's body, read under the cap; it must be a JSON object, and `guard` narrows it further
 * where the shape is known.
 */
async function readReply<T>(
  res: Response,
  route: string,
  guard?: (body: { [key: string]: JsonValue }) => boolean,
): Promise<T> {
  const body = await readReplyBody(res, route);
  if (!isJsonObject(body)) {
    throw new MalformedReplyError(
      route,
      body === null ? 'null' : Array.isArray(body) ? 'array' : 'a scalar',
    );
  }
  if (guard && !guard(body)) throw new MalformedReplyError(route, 'unexpected fields');
  const reply: JsonValue = body;
  // SAFETY: the reply comes from hippo's own server, whose route returns this api result as JSON.
  return reply as T;
}

/** The server gates every write, so a reply may be a skip; `force: true` stores it anyway. */
export async function postRemember(
  serverUrl: string,
  apiKey: string | undefined,
  opts: RememberOptions & { force: true },
): Promise<RememberResult>;
export async function postRemember(
  serverUrl: string,
  apiKey: string | undefined,
  opts: RememberOptions,
): Promise<RememberResult | RememberSkipped>;
export async function postRemember(
  serverUrl: string,
  apiKey: string | undefined,
  opts: RememberOptions & { force?: boolean },
): Promise<RememberResult | RememberSkipped> {
  const res = await sendWrite(`${serverUrl}/v1/memories`, {
    method: 'POST',
    headers: buildHeaders(apiKey, true),
    body: JSON.stringify(opts),
  });
  if (!res.ok) await throwForStatus(res);
  return readReply<RememberResult | RememberSkipped>(res, 'POST /v1/memories');
}

export async function postForget(
  serverUrl: string,
  apiKey: string | undefined,
  id: string,
): Promise<{ ok: true; id: string }> {
  const res = await sendWrite(`${serverUrl}/v1/memories/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: buildHeaders(apiKey, false),
  });
  if (!res.ok) await throwForStatus(res);
  return readReply<{ ok: true; id: string }>(res, 'DELETE /v1/memories/:id', (b) =>
    isJsonString(b.id),
  );
}

export async function postPromote(
  serverUrl: string,
  apiKey: string | undefined,
  id: string,
): Promise<{ ok: true; sourceId: string; globalId: string }> {
  const res = await sendWrite(`${serverUrl}/v1/memories/${encodeURIComponent(id)}/promote`, {
    method: 'POST',
    headers: buildHeaders(apiKey, false),
  });
  if (!res.ok) await throwForStatus(res);
  return readReply<{ ok: true; sourceId: string; globalId: string }>(
    res,
    'POST /v1/memories/:id/promote',
    (b) => isJsonString(b.sourceId) && isJsonString(b.globalId),
  );
}

/** Which raw row to archive and the reason the archive records. */
export interface ArchiveRawOptions {
  readonly id: string;
  readonly reason: string;
}

export async function postArchiveRaw(
  serverUrl: string,
  apiKey: string | undefined,
  { id, reason }: ArchiveRawOptions,
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

/** The nearest-row read's body: the query vector and the spec the caller's own scan would apply. */
export interface NearestIdsBody {
  readonly vector: readonly number[];
  readonly spec: JsonValue;
}

/** The ids the server finds nearest `body.vector`, nearest first, in one try that gives up after
 * `timeoutMs`. */
export async function nearestIds(
  serverUrl: string,
  apiKey: string | undefined,
  body: NearestIdsBody,
  timeoutMs: number,
): Promise<string[]> {
  const res = await fetchWithRetry(
    `${serverUrl}/v1/vectors/nearest`,
    { method: 'POST', headers: buildHeaders(apiKey, true), body: JSON.stringify(body) },
    { timeoutMs, attempts: 1 },
  );
  if (!res.ok) await throwForStatus(res);
  const reply = await readReply<{ ids: string[] }>(
    res,
    'POST /v1/vectors/nearest',
    (b) => Array.isArray(b.ids) && b.ids.every(isJsonString),
  );
  return reply.ids;
}

/** 'never-sent': the connection never opened, so a write replays locally. 'none': the server answered
 * with an error, or the request could not be built. 'delivery-unknown': the default for every error
 * not listed, as the request may have committed, so a write is never replayed. */
export type TransportFailure = 'none' | 'never-sent' | 'delivery-unknown';

/**
 * The syscall code Node puts on a system error itself (`http` errors) or on the `cause` of a fetch
 * `TypeError`; '' when there is none.
 */
function transportCode(err: Error): string {
  if ('code' in err) return String(err.code);
  // Node's fetch attaches the syscall code (ECONNREFUSED, ECONNRESET) on a non-null object `cause`.
  const cause: unknown = err.cause;
  return isObjectLike(cause) && 'code' in cause ? String(cause.code) : '';
}

const SOCKET_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'UND_ERR_SOCKET',
]);

/** A request that was on the wire when it failed: a dead socket, a fetch TypeError (no code means no
 * known syscall) or a server gone quiet. */
function diedOnTheWire(err: Error): boolean {
  return (
    SOCKET_CODES.has(transportCode(err)) || err instanceof TypeError || err.name === 'TimeoutError'
  );
}

export function classifyTransportFailure(err: Error): TransportFailure {
  // The server answered, or encodeURIComponent threw before any request existed.
  if (err instanceof HttpResponseError || err instanceof URIError) return 'none';
  const code = transportCode(err);
  // Connect-phase failures: no request bytes ever left the client, so a stale pidfile can be healed
  // and the call replayed on the direct path.
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'never-sent';
  // Any other error may have committed: only the two classes above are known not to have.
  return 'delivery-unknown';
}

const WRITE_MAY_HAVE_LANDED = 'so the write may already have been applied. Not retrying locally.';

/** The syscall code or the class name of an error hippo does not know, never its message, which a
 * foreign library may fill with the request's headers. */
function unrecognisedDetail(err: Error): string {
  const code = transportCode(err);
  const name = err.constructor.name;
  const detail = /^[A-Z0-9_]+$/.test(code) ? code : name === 'Error' ? '' : name;
  return detail === '' ? '' : ` (${detail})`;
}

/** What the user reads when a write may have landed and is not replayed. */
export function deliveryUnknownReason(err: Error, url: string): string {
  if (err instanceof MalformedReplyError) {
    return `${url} answered, but its reply could not be read, ${WRITE_MAY_HAVE_LANDED}`;
  }
  if (diedOnTheWire(err)) {
    return `the connection to ${url} dropped or timed out mid-request, ${WRITE_MAY_HAVE_LANDED}`;
  }
  const unrecognised = `failed in a way hippo does not recognise${unrecognisedDetail(err)}`;
  return `the request to ${url} ${unrecognised}, ${WRITE_MAY_HAVE_LANDED}`;
}
