import type { IncomingMessage, ServerResponse } from 'node:http';

// Leaf module shared by server.ts and the connector webhook receivers; it must not import either.

// Shared JSON-value domain type for the HTTP boundary (request bodies,
// JSON.parse results). Runtime shape checks against it go through the
// predicates below rather than a bare `typeof` (banned unconditionally by
// anti-slop/no-runtime-typeof in this repo's oxlint config). Mirrors the
// pattern already used in src/connectors/slack/types.ts.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

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

export const JSON_HEADERS = { 'content-type': 'application/json' } as const;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class BodyTooLargeError extends Error {}

export function sendJson<T>(res: ServerResponse, status: number, body: T): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/**
 * Read the entire request body into a Buffer. Caps at MAX_BODY_BYTES to keep
 * a malicious or buggy client from exhausting memory. The cap is enforced
 * mid-stream so we don't wait for an attacker to finish before erroring out.
 */
export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    // SAFETY: IncomingMessage never runs setEncoding() here, so every
    // streamed chunk is a Buffer, not a decoded string.
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new BodyTooLargeError('request body exceeds 1MB');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Per-request values a connector webhook receiver reads; ServeOpts and the /v1 RouteRequest both satisfy it. */
export interface WebhookRequest {
  req: IncomingMessage;
  res: ServerResponse;
  opts: { hippoRoot: string };
}
