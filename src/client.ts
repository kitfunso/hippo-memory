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

function buildHeaders(apiKey: string | undefined, withBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (withBody) headers['content-type'] = 'application/json';
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return headers;
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
    const body = await res.json() as { error?: string };
    if (body && typeof body.error === 'string' && body.error.length > 0) {
      message = body.error;
    }
  } catch {
    // body wasn't JSON; fall back to status line.
  }
  throw new Error(message);
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
  return await res.json() as RememberResult;
}

export async function recall(
  serverUrl: string,
  apiKey: string | undefined,
  opts: RecallOpts,
): Promise<RecallResult> {
  // v1.1.0: includeContinuity is supported on the in-process api.recall but
  // the HTTP route does not yet carry it. Fail loudly instead of silently
  // dropping the flag and returning a result without the continuity block
  // the caller asked for. HTTP support lands in v1.2.0 alongside the scope
  // read-side filter.
  if (opts.includeContinuity) {
    throw new Error(
      'recall(): includeContinuity is not yet supported over HTTP. ' +
      'Call api.recall in-process, or wait for v1.2.0 which adds ' +
      'GET /v1/memories?include_continuity=true alongside scope filtering.',
    );
  }
  const params = new URLSearchParams();
  params.set('q', opts.query);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.mode !== undefined) params.set('mode', opts.mode);
  const res = await fetch(`${serverUrl}/v1/memories?${params.toString()}`, {
    method: 'GET',
    headers: buildHeaders(apiKey, false),
  });
  if (!res.ok) await throwForStatus(res);
  return await res.json() as RecallResult;
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
  return await res.json() as { ok: true; id: string };
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
  return await res.json() as { ok: true; sourceId: string; globalId: string };
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
  return await res.json() as { ok: true; oldId: string; newId: string };
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
  return await res.json() as { ok: true; archivedAt: string };
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
  return await res.json() as AuthCreateResult;
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
  return await res.json() as ApiKeyListItem[];
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
  return await res.json() as { ok: true; revokedAt: string };
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
  return await res.json() as AuditEvent[];
}

/**
 * True for fetch failures that look like "server not actually running" (the
 * pidfile said one was, but the connection refused, or DNS / abort errors).
 * The CLI uses this to detect a stale pidfile and self-heal back to direct mode.
 */
export function isConnectionRefused(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  // Node fetch wraps the underlying cause; the surface message contains 'fetch failed'
  // and the cause has the syscall code. We check both shapes.
  if (message.includes('econnrefused')) return true;
  if (message.includes('connect econnrefused')) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const code = (cause as { code?: unknown }).code;
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return true;
  }
  // Fallthrough: 'fetch failed' alone is suspicious. Treat as connection failure
  // so the CLI heals on a stale pidfile rather than surfacing a cryptic error.
  if (message.includes('fetch failed')) return true;
  return false;
}
