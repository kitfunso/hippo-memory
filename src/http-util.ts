import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from './api-errors.js';
import { SqliteBlockedError } from './util/sqlite-blocked.js';
import { envBodyTimeoutMs } from './env.js';

// Leaf module shared by server.ts and the connector webhook receivers; it must not import either.

// node:http header values are `string | string[] | undefined` (never a bare
// unknown), so this gets its own predicate rather than reusing isJsonString.
export function isHeaderString(value: string | string[] | undefined): value is string {
  return typeof value === 'string';
}

// 1 MB body cap. The CLI never sends payloads near this; anything bigger is
// almost certainly a misconfigured client or a deliberate memory-blowup attempt.
export const MAX_BODY_BYTES = 1024 * 1024;

function sizeLabel(bytes: number): string {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)}MB` : `${Math.ceil(bytes / 1024)}KB`;
}

// How long a refused upload is still read and discarded after its reply, so a client that never stops cannot hold the socket.
const REFUSED_UPLOAD_LINGER_MS = 2000;

// Cap for id-shaped request fields (ids, tenant, session, scope, class): far above real values, small enough to bound logs and indexes.
export const MAX_ID_LEN = 256;

export const JSON_HEADERS = { 'content-type': 'application/json' } as const;

export class HttpError extends Error {
  status: number;
  /** Sent as the Retry-After header, so a refused caller knows when to come back. */
  readonly retryAfterSec: number | undefined;
  constructor(status: number, message: string, retryAfterSec?: number) {
    super(message);
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

/** A request, or a store call it waited on, ran past the request's deadline; the reply carries `code` so a client branches without parsing prose. */
export class DeadlineExceededError extends HttpError {
  readonly code = 'deadline_exceeded';
  constructor(message: string) {
    super(504, message);
  }
}

export class BodyTooLargeError extends Error {}

/** The body did not arrive in time. Its own class so mapApiError answers 408 and the server drops the socket. */
export class BodyTimeoutError extends Error {}

/** The status and client-facing message for one failed request. */
export interface ApiErrorReply {
  status: number;
  message: string;
}

export const INTERNAL_ERROR_MESSAGE = 'internal server error';

/** The reply when a request under another store reaches code that still opens hippo.db. */
export const STORE_NOT_PORTED_MESSAGE = 'store_not_ported';

/** Maps by class so rewording a message never moves a status; an untyped error is a 500 whose text stays in the server log. */
export function mapApiError<E>(err: E): ApiErrorReply {
  // An add-on can build an HttpError from any number, and writeHead throws on one outside 100-999.
  if (err instanceof HttpError && !(Number.isInteger(err.status) && err.status >= 100 && err.status <= 999)) {
    return { status: 500, message: INTERNAL_ERROR_MESSAGE };
  }
  if (err instanceof HttpError || err instanceof ApiError) return { status: err.status, message: err.message };
  if (err instanceof BodyTooLargeError) return { status: 413, message: err.message };
  if (err instanceof BodyTimeoutError) return { status: 408, message: err.message };
  if (err instanceof SqliteBlockedError) return { status: 501, message: STORE_NOT_PORTED_MESSAGE };
  return { status: 500, message: INTERNAL_ERROR_MESSAGE };
}

/** Serialises before the head goes out, so a body that is not JSON still reaches the caller's error reply. */
export function sendJson<T>(res: ServerResponse, status: number, body: T): void {
  const text = JSON.stringify(body);
  if (text === undefined) throw new Error('response body is not JSON');
  res.writeHead(status, JSON_HEADERS);
  res.end(text);
}

const DEFAULT_BODY_DEADLINE_MS = 30_000;

/** How long any route waits for a request body, so a client that sends headers and then stalls cannot hold a request open: 30 s, or HIPPO_BODY_TIMEOUT_MS. */
export function bodyDeadlineMs(): number {
  return envBodyTimeoutMs() ?? DEFAULT_BODY_DEADLINE_MS;
}

export interface ReadBodyOpts {
  /** Defaults to 1 MB. */
  maxBytes?: number;
  /** Fails with BodyTimeoutError when the whole body has not arrived by then; defaults to bodyDeadlineMs(). */
  deadlineMs?: number;
}

/** The body as text, refused mid-stream past maxBytes and past deadlineMs, so an oversized or slow sender cannot tie up the server. */
export function readBody(req: IncomingMessage, { maxBytes = MAX_BODY_BYTES, deadlineMs = bodyDeadlineMs() }: ReadBodyOpts = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const refuse = (err: Error): void => {
      clearTimeout(timer);
      req.off('data', onData);
      chunks.length = 0;
      reject(err);
    };
    // Not for-await: leaving that loop early destroys the request, so the socket stops reading and the 413 caller cannot close it cleanly.
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total <= maxBytes) {
        chunks.push(chunk);
        return;
      }
      refuse(new BodyTooLargeError(`request body exceeds ${sizeLabel(maxBytes)}`));
    };
    const timer = setTimeout(() => refuse(new BodyTimeoutError(`request body not received within ${deadlineMs} ms`)), deadlineMs);
    req.on('data', onData);
    req.once('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// A full close with request bytes unread sends a TCP reset, which discards the reply before the client reads it (RFC 9112 9.6).
export function closeAfterReply(req: IncomingMessage): void {
  const socket = req.socket;
  req.resume();
  socket.end();
  const timer = setTimeout(() => socket.destroy(), REFUSED_UPLOAD_LINGER_MS);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
}

// Any other Host on a loopback socket is DNS rebinding: a hostile page resolved to 127.0.0.1.
export const LOOPBACK_HOST_HEADER = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** A browser request sent by another site. Non-browser clients send neither header and pass. */
export function isCrossSite(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  return origin !== undefined && origin !== `http://${req.headers.host}`;
}

/** Per-request values a connector webhook receiver reads; ServeOpts and the /v1 RouteRequest both satisfy it. */
export interface WebhookRequest {
  req: IncomingMessage;
  res: ServerResponse;
  opts: { hippoRoot: string; webhookBodyDeadlineMs?: number };
}

// A webhook route takes no key, so anyone holding a signature header could otherwise keep a socket open with a body that never ends.
const WEBHOOK_BODY_DEADLINE_MS = 10_000;

/** Call before refusing a webhook unread: a caller still sending its body loses the socket once the reply is out, as it does after a 413. */
export function closeIfBodyUnread({ req, res }: WebhookRequest): void {
  res.once('finish', () => {
    if (!req.complete) closeAfterReply(req);
  });
}

/** A webhook's raw body, exactly as sent, for the receiver's HMAC check; call it only once a secret is configured and the signature headers are present. */
export function readWebhookBody({ req, opts }: WebhookRequest): Promise<string> {
  return readBody(req, { deadlineMs: opts.webhookBodyDeadlineMs ?? WEBHOOK_BODY_DEADLINE_MS });
}
