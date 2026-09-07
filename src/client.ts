/**
 * HTTP client wrapper for `hippo serve`.
 *
 * Mirrors the function signatures in src/api.ts so the CLI can route through
 * either path uniformly. Each function takes (serverUrl, apiKey?, ...) and
 * returns the same shape that api.ts would.
 *
 * Errors from the server (4xx/5xx) are mapped back into thrown Errors with
 * the server's `error` message preserved verbatim so existing CLI handlers
 * that match on substrings (e.g. "not found", "already superseded") still
 * work unchanged.
 *
 * Network errors (ECONNREFUSED on a stale pidfile, etc.) propagate as the
 * native fetch failure so the caller can detect them and self-heal.
 */

import type { MemoryKind } from './memory.js';
import type { AuditEvent, AuditOp } from './audit.js';
import type { ApiKeyListItem } from './auth.js';
import type {
  RememberOpts,
  RememberResult,
  RecallOpts,
  RecallResult,
  AuthCreateOpts,
  AuthCreateResult,
  AuditListOpts,
} from './api.js';

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

export async function recall(
  serverUrl: string,
  apiKey: string | undefined,
  opts: RecallOpts,
): Promise<RecallResult> {
  const params = new URLSearchParams();
  params.set('q', opts.query);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.mode !== undefined) params.set('mode', opts.mode);
  if (opts.scope !== undefined && opts.scope !== '') params.set('scope', opts.scope);
  if (opts.includeContinuity) params.set('include_continuity', '1');
  // v1.7.2 T4 — RecallOpts parity sweep. Pre-v1.7.2 the thin-client only
  // serialized the five fields above; the HTTP server already accepted
  // fresh_tail_count, fresh_tail_session_id, summarize_overflow. Adding
  // scorer_window alone would have perpetuated the drift. Serializing all
  // four together. Validation lives in api.recall(); transport just
  // forwards.
  if (opts.freshTailCount !== undefined) params.set('fresh_tail_count', String(opts.freshTailCount));
  if (opts.freshTailSessionId !== undefined && opts.freshTailSessionId !== '')
    params.set('fresh_tail_session_id', opts.freshTailSessionId);
  if (opts.summarizeOverflow !== undefined)
    params.set('summarize_overflow', opts.summarizeOverflow ? '1' : '0');
  if (opts.scorerWindow !== undefined) params.set('scorer_window', String(opts.scorerWindow));
  // v1.7.4 sessionId for dlPFC goal-stack boost + v0.33 / J1 sessionId
  // for per-session anchoring ring. Pre-v0.33 the thin-client silently
  // dropped opts.sessionId, so HTTP-routed SDK callers got no goal
  // boost and (post-J1) the HTTP ring logged recall_anchor_skipped_no_session.
  // Codex round-3 P2 catch: align serialization with the RecallOpts type.
  // Note: opts.recallHistory is intentionally NOT serialized — it is an
  // in-process snapshot only; the HTTP server maintains its own ring per
  // sessionId, so passing recallHistory over the wire would be a no-op
  // at best and a tenant-leak risk at worst.
  if (opts.sessionId !== undefined && opts.sessionId !== '') {
    params.set('session_id', opts.sessionId);
  }
  const res = await fetch(`${serverUrl}/v1/memories?${params.toString()}`, {
    method: 'GET',
    headers: buildHeaders(apiKey, false),
  });
  if (!res.ok) await throwForStatus(res);
  const result: RecallResult = await res.json();
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

export async function supersede(
  serverUrl: string,
  apiKey: string | undefined,
  oldId: string,
  newContent: string,
): Promise<{ ok: true; oldId: string; newId: string }> {
  const res = await fetch(`${serverUrl}/v1/memories/${encodeURIComponent(oldId)}/supersede`, {
    method: 'POST',
    headers: buildHeaders(apiKey, true),
    body: JSON.stringify({ content: newContent }),
  });
  if (!res.ok) await throwForStatus(res);
  const result: { ok: true; oldId: string; newId: string } = await res.json();
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

export async function authCreate(
  serverUrl: string,
  apiKey: string | undefined,
  opts: AuthCreateOpts,
): Promise<AuthCreateResult> {
  const res = await fetch(`${serverUrl}/v1/auth/keys`, {
    method: 'POST',
    headers: buildHeaders(apiKey, true),
    body: JSON.stringify(opts),
  });
  if (!res.ok) await throwForStatus(res);
  const result: AuthCreateResult = await res.json();
  return result;
}

export async function authList(
  serverUrl: string,
  apiKey: string | undefined,
  opts: { active: boolean },
): Promise<ApiKeyListItem[]> {
  const params = new URLSearchParams();
  params.set('active', opts.active ? 'true' : 'false');
  const res = await fetch(`${serverUrl}/v1/auth/keys?${params.toString()}`, {
    method: 'GET',
    headers: buildHeaders(apiKey, false),
  });
  if (!res.ok) await throwForStatus(res);
  const result: ApiKeyListItem[] = await res.json();
  return result;
}

export async function authRevoke(
  serverUrl: string,
  apiKey: string | undefined,
  keyId: string,
): Promise<{ ok: true; revokedAt: string }> {
  const res = await fetch(`${serverUrl}/v1/auth/keys/${encodeURIComponent(keyId)}`, {
    method: 'DELETE',
    headers: buildHeaders(apiKey, false),
  });
  if (!res.ok) await throwForStatus(res);
  const result: { ok: true; revokedAt: string } = await res.json();
  return result;
}

export async function auditList(
  serverUrl: string,
  apiKey: string | undefined,
  opts: AuditListOpts,
): Promise<AuditEvent[]> {
  const params = new URLSearchParams();
  if (opts.op !== undefined) params.set('op', opts.op);
  if (opts.since !== undefined) params.set('since', opts.since);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const url = qs.length > 0 ? `${serverUrl}/v1/audit?${qs}` : `${serverUrl}/v1/audit`;
  const res = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(apiKey, false),
  });
  if (!res.ok) await throwForStatus(res);
  const result: AuditEvent[] = await res.json();
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
