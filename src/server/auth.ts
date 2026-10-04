// Bearer and loopback auth for the HTTP server.
import { envRequireAuth } from '../env.js';
import type { IncomingMessage } from 'node:http';
import { resolveTenantId } from '../tenant.js';
import { log } from '../log.js';
import { API_KEY_PREFIX, verifyApiKeyCached } from '../auth.js';
import type { Actor, Context } from '../api.js';
import { HttpError, isCrossSite, isHeaderString, LOOPBACK_HOST_HEADER, MAX_ID_LEN } from '../http-util.js';
import { requestIds } from './request.js';
import type { AuthResolver, ResolvedBearer, ServeOpts } from './types.js';
import { isJsonString } from '../json.js';

/**
 * Recognise loopback remote addresses. Node reports IPv6-mapped IPv4 as
 * '::ffff:127.0.0.1' on dual-stack sockets, so we accept that alongside
 * the bare v4 and v6 loopbacks. Anything else is treated as remote.
 */
export function isLoopback(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  if (remoteAddress === '127.0.0.1') return true;
  if (remoteAddress === '::1') return true;
  if (remoteAddress === '::ffff:127.0.0.1') return true;
  return false;
}

// A proxy on this host (nginx, Caddy, cloudflared) connects from loopback, so these headers mean the caller is not local.
const PROXY_HEADERS = [
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip',
] as const;

// A browser on this machine is loopback too, so the no-key fallback also needs a local Host and a same-site caller.
function assertLocalCaller(req: IncomingMessage): void {
  if (!isLoopback(req.socket.remoteAddress)) throw new HttpError(401, 'auth required');
  const proxyHeader = PROXY_HEADERS.find((name) => req.headers[name] !== undefined);
  if (proxyHeader !== undefined) {
    log.warn(
      `proxied loopback request refused: it carries ${proxyHeader}, so the no-key local fallback does not apply. ` +
        'Send an API key (hippo auth create, then Authorization: Bearer hk_...).',
      { requestId: requestIds.get(req) },
    );
    throw new HttpError(401, 'auth required');
  }
  const host = req.headers.host;
  if ((host !== undefined && !LOOPBACK_HOST_HEADER.test(host)) || isCrossSite(req)) {
    throw new HttpError(403, 'cross-site or non-local request refused; send an API key');
  }
}

/**
 * Read the Authorization header in a case-insensitive way and pull the
 * bearer token out. Returns:
 *   - { kind: 'absent' } when no Authorization header is present
 *   - { kind: 'malformed' } when the header is set but not 'Bearer <token>'
 *   - { kind: 'bearer', token } when a non-empty bearer token is present
 *
 * The header NAME is case-insensitive (Node lowercases all header names on
 * IncomingMessage.headers); the SCHEME ('Bearer') is also matched
 * case-insensitively per RFC 6750.
 */
type AuthHeader =
  | { kind: 'absent' }
  | { kind: 'malformed' }
  | { kind: 'bearer'; token: string };

export function readAuthHeader(req: IncomingMessage): AuthHeader {
  const raw = req.headers['authorization'];
  if (raw === undefined) return { kind: 'absent' };
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!isHeaderString(value) || value.length === 0) {
    return { kind: 'malformed' };
  }
  const space = value.indexOf(' ');
  if (space < 0) return { kind: 'malformed' };
  const scheme = value.slice(0, space);
  const token = value.slice(space + 1).trim();
  if (scheme.toLowerCase() !== 'bearer') return { kind: 'malformed' };
  if (token.length === 0) return { kind: 'malformed' };
  return { kind: 'bearer', token };
}

type AuthOpts = Pick<ServeOpts, 'hippoRoot' | 'authResolver' | 'authResolverTimeoutMs'>;

// Built-in actors are the bare names below or `<name>:<detail>`; a plain prefix would also reject `clinton@corp`.
const RESERVED_ACTOR_NAMES = [
  'api_key', 'localhost', 'cli', 'system', 'mcp', 'connector', 'sleep', 'post-compact', 'recall', 'agent-memories',
] as const;

/** Add-ons call this to refuse a subject that would collide with a built-in actor. */
export function isReservedActor(subject: string): boolean {
  const lower = subject.toLowerCase();
  return RESERVED_ACTOR_NAMES.some((n) => lower === n || lower.startsWith(`${n}:`));
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Core owns the checks so a resolver cannot mint an actor that collides with a built-in one. */
function sanitiseResolved(r: ResolvedBearer): ResolvedBearer | null {
  // Each field is read once: a getter on plugin code could answer differently the second time.
  const { tenantId, subject, role, scopes } = r;
  // A resolver is plugin code, so the runtime checks hold even though the static types say string.
  if (!isJsonString(tenantId) || tenantId.trim().length === 0) return null;
  // Core reserves `__`-prefixed tenants (`__host__`, `__unroutable__`).
  const tenant = tenantId.trim();
  if (tenant.startsWith('__') || tenant.length > MAX_ID_LEN || hasControlChar(tenant)) return null;
  if (!isJsonString(subject) || subject.length < 1 || subject.length > MAX_ID_LEN) return null;
  // Padding would let "system " pass the reserved-name check yet read as `system` in an audit log.
  if (hasControlChar(subject) || subject !== subject.trim()) return null;
  if (isReservedActor(subject)) return null;
  const clean: ResolvedBearer = { tenantId: tenant, subject, role: role === 'admin' ? 'admin' : 'member' };
  if (Array.isArray(scopes)) clean.scopes = scopes.filter((s) => isJsonString(s));
  return clean;
}

function logResolverFailure(what: string, raw: string, token: string): void {
  // The plugin's message is logged, but never the token, even if the plugin echoed it.
  log.error(`auth resolver ${what}: ${raw.split(token).join('[token]')}`);
}

/** 503 when upstream throws or misses the deadline, so a stream heartbeat can tell an outage from a revocation. */
async function askResolver(resolver: AuthResolver, token: string, deadlineMs: number): Promise<ResolvedBearer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${deadlineMs} ms`)), deadlineMs);
  });
  let resolved: ResolvedBearer | null;
  try {
    resolved = await Promise.race([(async () => resolver(token))(), deadline]);
  } catch (err) {
    logResolverFailure('threw', err instanceof Error ? err.message : 'unknown error', token);
    throw new HttpError(503, 'auth provider unavailable');
  } finally {
    clearTimeout(timer);
  }
  let clean: ResolvedBearer | null = null;
  try {
    clean = resolved ? sanitiseResolved(resolved) : null;
  } catch (err) {
    // A throwing getter is a resolver bug, not an outage, so it is a 401 like any malformed answer.
    logResolverFailure('threw', err instanceof Error ? err.message : 'unknown error', token);
  }
  if (!clean) throw new HttpError(401, 'invalid api key');
  return clean;
}

/** Set by the core only: sanitiseResolved builds a fresh object, so a resolver cannot claim the tag. */
interface BearerIdentity extends ResolvedBearer {
  viaAuthResolver?: true;
}

const DEFAULT_RESOLVER_DEADLINE_MS = 5000;

/** Shared by buildContextWithAuth and requireAuth so the two cannot drift. */
async function resolveBearer(token: string, opts: AuthOpts): Promise<BearerIdentity> {
  // Routing by shape keeps key plaintext out of plugin code and stops a resolver overriding a key's identity.
  if (opts.authResolver && !token.startsWith(API_KEY_PREFIX)) {
    const t = opts.authResolverTimeoutMs;
    const deadlineMs = t !== undefined && Number.isFinite(t) && t > 0 ? t : DEFAULT_RESOLVER_DEADLINE_MS;
    return { ...(await askResolver(opts.authResolver, token, deadlineMs)), viaAuthResolver: true };
  }
  const key = verifyApiKeyCached(opts.hippoRoot, token);
  if (!key) throw new HttpError(401, 'invalid api key');
  return { tenantId: key.tenantId, subject: `api_key:${key.keyId}`, role: key.role, scopes: key.scopes };
}

/**
 * Build a per-request Context from the Authorization header and remote
 * address. Throws HttpError(401) for invalid / missing credentials. Opens
 * the DB only for an API-key-shaped Bearer token (or any Bearer token when no
 * auth resolver is registered), so loopback no-auth requests stay cheap.
 */
export async function buildContextWithAuth(req: IncomingMessage, opts: AuthOpts): Promise<Context> {
  const auth = readAuthHeader(req);

  if (auth.kind === 'malformed') {
    throw new HttpError(401, 'invalid api key');
  }

  if (auth.kind === 'bearer') {
    const id = await resolveBearer(auth.token, opts);
    const actor: Actor = { subject: id.subject, role: id.role, scopes: id.scopes };
    if (id.viaAuthResolver) actor.viaAuthResolver = true;
    // Only the server's own tenant owns the host; any other tenant's admin key is a tenant admin.
    else if (id.role === 'admin' && id.tenantId === resolveTenantId({})) actor.hostAdmin = true;
    return { hippoRoot: opts.hippoRoot, tenantId: id.tenantId, actor };
  }

  // No Authorization header. Loopback-only fallback for a direct local caller (no proxy headers),
  // unless HIPPO_REQUIRE_AUTH=1 forbids the local-CLI escape hatch.
  if (envRequireAuth()) {
    throw new HttpError(401, 'auth required');
  }
  assertLocalCaller(req);

  // v1.12.0: loopback fallback is process-local, treat as admin.
  return {
    hippoRoot: opts.hippoRoot,
    tenantId: resolveTenantId({}),
    actor: { subject: 'localhost:cli', role: 'admin', hostAdmin: true },
  };
}

/**
 * Auth check for routes that do not need a tenant Context (e.g. MCP transport,
 * which builds its own root resolution via findHippoRoot). Throws HttpError
 * 401 the same way buildContextWithAuth does, but skips building the Context
 * envelope. Loopback no-auth still passes.
 */
export async function requireAuth(req: IncomingMessage, opts: AuthOpts): Promise<void> {
  const auth = readAuthHeader(req);
  if (auth.kind === 'malformed') {
    throw new HttpError(401, 'invalid api key');
  }
  if (auth.kind === 'bearer') {
    await resolveBearer(auth.token, opts);
    return;
  }
  if (envRequireAuth()) {
    throw new HttpError(401, 'auth required');
  }
  assertLocalCaller(req);
}

/** Never rejects: an outage (5xx) skips one heartbeat tick, only a definite 4xx denial closes the stream. */
export async function heartbeatVerdict(req: IncomingMessage, opts: AuthOpts): Promise<'ok' | 'revoked' | 'unavailable'> {
  try {
    await requireAuth(req, opts);
    return 'ok';
  } catch (err) {
    return err instanceof HttpError && err.status < 500 ? 'revoked' : 'unavailable';
  }
}

/** Gate for any action beyond the caller's own tenant: a tenant's admin, by key or resolver, is never a host admin. */
export function assertCrossTenantAdmin(ctx: Context, what: string): void {
  if (ctx.actor.role !== 'admin') throw new HttpError(403, `${what} requires admin role`);
  if (!ctx.actor.hostAdmin) throw new HttpError(403, `${what} requires a host admin`);
}
