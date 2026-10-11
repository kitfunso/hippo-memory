// Bearer and loopback auth for the HTTP server.
import { envAllowKeylessLocal, envRequireAuth } from '../util/env.js';
import type { IncomingMessage } from 'node:http';
import { resolveTenantId } from '../store/tenant.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import { API_KEY_PREFIX, verifyApiKeyCached } from '../store/auth.js';
import { type Actor, type Context, ownerOrSubject } from '../api/index.js';
import { HttpError, isCrossSite, isHeaderString, LOOPBACK_HOST_HEADER } from '../util/http-util.js';
import { MAX_ID_LEN } from '../util/limits.js';
import { clientLimitKey } from './client-ip.js';
import { keyCheckBounds } from './key-check-bounds.js';
import type { AuthResolver, ResolvedBearer, ResolvedServeOpts } from './types.js';
import { isJsonString } from '../util/json.js';

/** Recognises loopback remote addresses, including the IPv6-mapped '::ffff:127.0.0.1' Node reports on dual-stack sockets; anything else is remote. */
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
  'fly-client-ip',
] as const;

function proxyHeaderOf(req: IncomingMessage): string | undefined {
  return PROXY_HEADERS.find((name) => req.headers[name] !== undefined);
}

/** A page in a browser on this machine: another site's request, or a hostile name resolved to loopback (DNS rebinding). */
function isForeignPage(req: IncomingMessage): boolean {
  const host = req.headers.host;
  return (host !== undefined && !LOOPBACK_HOST_HEADER.test(host)) || isCrossSite(req);
}

/** True only for a request made on this machine by its own user: a proxy and a browser page are loopback too, so the socket alone proves nothing. */
export function isLocalCaller(req: IncomingMessage): boolean {
  return isLoopback(req.socket.remoteAddress) && proxyHeaderOf(req) === undefined && !isForeignPage(req);
}

// The throwing twin of isLocalCaller, for the no-key fallback: each refusal has its own status, and a proxied one is logged.
function assertLocalCaller(req: IncomingMessage): void {
  if (!isLoopback(req.socket.remoteAddress)) throw new HttpError(401, 'auth required');
  const proxyHeader = proxyHeaderOf(req);
  if (proxyHeader !== undefined) {
    log.warn(
      `proxied loopback request refused: it carries ${proxyHeader}, so the no-key local fallback does not apply. ` +
        'Send an API key (hippo auth create, then Authorization: Bearer hk_...).',
    );
    throw new HttpError(401, 'auth required');
  }
  if (isForeignPage(req)) {
    throw new HttpError(403, 'cross-site or non-local request refused; send an API key');
  }
}

/** The 401 a keyless request from this machine gets by default; it names both fixes, since an upgrade is where most people meet it. */
const KEY_REQUIRED_MESSAGE =
  'auth required: this server takes no request without an API key. Mint one with `hippo auth create` and send it as ' +
  '"Authorization: Bearer <key>" (the hippo CLI reads HIPPO_API_KEY), or start the server with HIPPO_ALLOW_KEYLESS_LOCAL=1 ' +
  'to let requests from this machine in without a key.';

/** Reads the Authorization header case-insensitively (name and RFC 6750 'Bearer' scheme): { kind: 'absent' }, { kind: 'malformed' } (set but not 'Bearer
 * <token>'), or { kind: 'bearer', token } for a non-empty token. */
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

type AuthOpts = Pick<ResolvedServeOpts, 'hippoRoot' | 'authResolver' | 'authResolverTimeoutMs' | 'store' | 'callerLimiter'>
  & Partial<Pick<ResolvedServeOpts, 'failedAuthLimiter'>>;

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
  owner?: string;
}

const DEFAULT_RESOLVER_DEADLINE_MS = 5000;

/** Runs only before scrypt, so junk, unknown, revoked and expired tokens and a proven key's re-check never spend a colleague's budget. */
function chargeScryptRun(req: IncomingMessage, opts: AuthOpts): void {
  const limiter = opts.failedAuthLimiter;
  // Reserving rather than peeking bounds scrypt runs exactly, even when concurrent misses await a slow store.
  if (limiter && !limiter.check(clientLimitKey(req))) {
    throw new HttpError(429, 'too many key checks from this address', limiter.retryAfterSec);
  }
}

/** Shared by buildContextWithAuth and requireAuth so the two cannot drift. */
async function resolveBearer(req: IncomingMessage, token: string, opts: AuthOpts): Promise<BearerIdentity> {
  // Routing by shape keeps key plaintext out of plugin code and stops a resolver overriding a key's identity.
  if (opts.authResolver && !token.startsWith(API_KEY_PREFIX)) {
    const t = opts.authResolverTimeoutMs;
    const deadlineMs = t !== undefined && Number.isFinite(t) && t > 0 ? t : DEFAULT_RESOLVER_DEADLINE_MS;
    const clean = await askResolver(opts.authResolver, token, deadlineMs);
    return { ...clean, viaAuthResolver: true, owner: clean.subject }; // a resolver vouches for a person, never names one
  }
  const key = await verifyApiKeyCached(token, opts.store, (keyId, derive) => {
    // The key's own bucket first, so a flood on one key id ends at its five tries and leaves the address's budget to the callers who share it.
    keyChecks.admit(keyId, clientLimitKey(req));
    chargeScryptRun(req, opts);
    return keyChecks.run(derive);
  });
  if (!key) throw new HttpError(401, 'invalid api key');
  const id: BearerIdentity = { tenantId: key.tenantId, subject: `api_key:${key.keyId}`, role: key.role, scopes: key.scopes };
  if (key.ownerSubject) id.owner = key.ownerSubject;
  return id;
}

/** The auth check without a charge: the bearer's identity, or null for the keyless local fallback. */
async function checkAuth(req: IncomingMessage, opts: AuthOpts): Promise<BearerIdentity | null> {
  const auth = readAuthHeader(req);
  if (auth.kind === 'malformed') {
    throw new HttpError(401, 'invalid api key');
  }
  if (auth.kind === 'bearer') return resolveBearer(req, auth.token, opts);
  // No Authorization header. HIPPO_REQUIRE_AUTH=1 is checked first, so a deployment that sets both stays closed.
  if (envRequireAuth()) {
    throw new HttpError(401, 'auth required');
  }
  if (!envAllowKeylessLocal()) {
    // Only this machine's own user is told how to switch the key off; a proxied caller or a page learns nothing.
    throw new HttpError(401, isLocalCaller(req) ? KEY_REQUIRED_MESSAGE : 'auth required');
  }
  assertLocalCaller(req);
  return null;
}

function bearerActor(id: BearerIdentity): Actor {
  const actor: Actor = { subject: id.subject, role: id.role, scopes: id.scopes };
  if (id.owner !== undefined) actor.owner = id.owner;
  if (id.viaAuthResolver) actor.viaAuthResolver = true;
  // Only the server's own tenant owns the host; any other tenant's admin key is a tenant admin.
  else if (id.role === 'admin' && id.tenantId === resolveTenantId({})) actor.hostAdmin = true;
  return actor;
}

/** Key cap for every serve() bucket, shared by the warn map so it never tracks more callers than the buckets do. */
export const LIMITER_MAX_KEYS = 10_000;
// One for the process, as the thread pool its derivations run on is.
const keyChecks = keyCheckBounds(LIMITER_MAX_KEYS);
const CALLER_WARN_EVERY_MS = 60_000;
const callerWarnedAt = new Map<string, number>();

function warnCallerLimited(key: string, tenantId: string, person: string): void {
  const now = Date.now();
  const last = callerWarnedAt.get(key);
  if (last !== undefined && now - last < CALLER_WARN_EVERY_MS) return;
  callerWarnedAt.delete(key);
  if (callerWarnedAt.size >= LIMITER_MAX_KEYS) {
    const oldest = callerWarnedAt.keys().next();
    if (!oldest.done) callerWarnedAt.delete(oldest.value);
  }
  callerWarnedAt.set(key, now);
  log.warn('caller over its rate limit; its further 429s this minute are not logged', { tenant: tenantId, person });
}

function chargeCaller(tenantId: string, actor: Actor, opts: AuthOpts): void {
  const limiter = opts.callerLimiter;
  if (!limiter) return;
  const person = ownerOrSubject(actor);
  const key = `${tenantId}\u0000${person}`;
  if (limiter.check(key)) return;
  warnCallerLimited(key, tenantId, person);
  throw new HttpError(429, 'rate limit exceeded for this caller', limiter.retryAfterSec);
}

/** Builds a per-request Context from the Authorization header and remote address; throws HttpError(401) for invalid or missing credentials.
 * Reads the store only for an API-key-shaped Bearer (or any Bearer when no auth resolver is registered), so keyless local requests stay cheap. */
export async function buildContextWithAuth(req: IncomingMessage, opts: AuthOpts): Promise<Context> {
  const id = await checkAuth(req, opts);
  const ctx = contextFor(id, opts);
  if (id !== null) chargeCaller(id.tenantId, ctx.actor, opts);
  return ctx;
}

/** The auth check again, uncharged, for a handler that authenticated with requireAuth before a slow body read and must re-check right before it acts. */
export async function recheckContextWithAuth(req: IncomingMessage, opts: AuthOpts): Promise<Context> {
  return contextFor(await checkAuth(req, opts), opts);
}

function contextFor(id: BearerIdentity | null, opts: AuthOpts): Context {
  if (id !== null) return { hippoRoot: opts.hippoRoot, tenantId: id.tenantId, actor: bearerActor(id), store: opts.store };
  // The keyless local fallback (HIPPO_ALLOW_KEYLESS_LOCAL=1) is this machine's own user, so it is host admin.
  return {
    hippoRoot: opts.hippoRoot,
    tenantId: resolveTenantId({}),
    actor: { subject: 'localhost:cli', role: 'admin', hostAdmin: true },
    store: opts.store,
  };
}

/** Auth check for routes that need no tenant Context (e.g. the MCP transport, which resolves its own root): throws HttpError 401 like buildContextWithAuth.
 * A keyless local request passes only under HIPPO_ALLOW_KEYLESS_LOCAL=1. */
export async function requireAuth(req: IncomingMessage, opts: AuthOpts): Promise<void> {
  const id = await checkAuth(req, opts);
  if (id !== null) chargeCaller(id.tenantId, bearerActor(id), opts);
}

/** Never rejects or charges a caller bucket: an outage (5xx) or a throttle (429) skips one tick; only a definite 4xx denial closes the stream. */
export async function heartbeatVerdict(req: IncomingMessage, opts: AuthOpts): Promise<'ok' | 'revoked' | 'unavailable'> {
  try {
    await checkAuth(req, opts);
    return 'ok';
  } catch (err) {
    if (!(err instanceof HttpError)) log.error(`heartbeat auth check failed: ${errorMessage(err)}`, errorFields(err));
    return err instanceof HttpError && err.status < 500 && err.status !== 429 ? 'revoked' : 'unavailable';
  }
}

/** Gate for any action beyond the caller's own tenant: a tenant's admin, by key or resolver, is never a host admin. */
export function assertCrossTenantAdmin(ctx: Context, what: string): void {
  if (ctx.actor.role !== 'admin') throw new HttpError(403, `${what} requires admin role`);
  if (!ctx.actor.hostAdmin) throw new HttpError(403, `${what} requires a host admin`);
}
