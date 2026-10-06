import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from './api-errors.js';
import type { JsonValue } from './json.js';

// Leaf module shared by server.ts and the connector webhook receivers; it must not import either.

export function isJsonObjectRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}

// node:http header values are `string | string[] | undefined` (never a bare
// unknown), so this gets its own predicate rather than reusing isJsonString.
export function isHeaderString(value: string | string[] | undefined): value is string {
  return typeof value === 'string';
}

// 1 MB body cap. The CLI never sends payloads near this; anything bigger is
// almost certainly a misconfigured client or a deliberate memory-blowup attempt.
const MAX_BODY_BYTES = 1024 * 1024;

function sizeLabel(bytes: number): string {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)}MB` : `${Math.ceil(bytes / 1024)}KB`;
}

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

export class BodyTooLargeError extends Error {}

/** The body did not arrive in time. Its own class so mapApiError answers 408 and the server drops the socket. */
export class BodyTimeoutError extends Error {}

/** The status and client-facing message for one failed request. */
export interface ApiErrorReply {
  status: number;
  message: string;
}

export const INTERNAL_ERROR_MESSAGE = 'internal server error';

/** Maps by class so rewording a message never moves a status; an untyped error is a 500 whose text stays in the server log. */
export function mapApiError<E>(err: E): ApiErrorReply {
  // An add-on can build an HttpError from any number, and writeHead throws on one outside 100-999.
  if (err instanceof HttpError && !(Number.isInteger(err.status) && err.status >= 100 && err.status <= 999)) {
    return { status: 500, message: INTERNAL_ERROR_MESSAGE };
  }
  if (err instanceof HttpError || err instanceof ApiError) return { status: err.status, message: err.message };
  if (err instanceof BodyTooLargeError) return { status: 413, message: err.message };
  if (err instanceof BodyTimeoutError) return { status: 408, message: err.message };
  return { status: 500, message: INTERNAL_ERROR_MESSAGE };
}

/** Serialises before the head goes out, so a body that is not JSON still reaches the caller's error reply. */
export function sendJson<T>(res: ServerResponse, status: number, body: T): void {
  const text = JSON.stringify(body);
  if (text === undefined) throw new Error('response body is not JSON');
  res.writeHead(status, JSON_HEADERS);
  res.end(text);
}

export interface ReadBodyOpts {
  /** Defaults to 1 MB. */
  maxBytes?: number;
  /** Fails with BodyTimeoutError when the whole body has not arrived by then; unset waits for as long as the socket stays open. */
  deadlineMs?: number;
}

/** The body as text, refused mid-stream past maxBytes and past deadlineMs, so an oversized or slow sender cannot tie up the server. */
export async function readBody(req: IncomingMessage, { maxBytes = MAX_BODY_BYTES, deadlineMs }: ReadBodyOpts = {}): Promise<string> {
  const read = readChunks(req, maxBytes);
  if (deadlineMs === undefined) return read;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BodyTimeoutError(`request body not received within ${deadlineMs} ms`)), deadlineMs);
  });
  try {
    // The race keeps a late failure of the abandoned read from surfacing as an unhandled rejection.
    return await Promise.race([read, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function readChunks(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    // SAFETY: IncomingMessage never runs setEncoding() here, so every
    // streamed chunk is a Buffer, not a decoded string.
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new BodyTooLargeError(`request body exceeds ${sizeLabel(maxBytes)}`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
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
  opts: { hippoRoot: string };
}
