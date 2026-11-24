import { envTenant } from '../../base/util/env.js';
import type { IncomingMessage } from 'node:http';
import { errorFields, errorMessage, log, type LogFields } from '../../base/util/log.js';
import { LOCAL_KEY_SUBJECT } from './local-key.js';
import { API_KEY_PREFIX } from '../../base/scope/api-key.js';
import { type Actor, type Context, contextReach, ownerOrSubject } from '../../api/index.js';
import { HttpError } from '../../base/errors/http-errors.js';
import { roleOrViewer } from '../../base/scope/role.js';
import { isCrossSite, isHeaderString, LOOPBACK_HOST_HEADER } from '../http/http-util.js';
import { MAX_ID_LEN } from '../../base/util/limits.js';
import { clientKeyOf, clientLimitKey } from './client-ip.js';
import { askKeyQuota } from './key-quota.js';
import { noteAccess } from './request.js';
import { LIMITER_MAX_KEYS } from './rate-limit.js';
import type { AuthResolver, ResolvedBearer, ResolvedServeOptions } from './types.js';
import { isJsonString } from '../../base/util/json.js';
import { MINUTE_MS } from '../../base/util/time.js';
import { isLoopbackAddress } from '../../base/util/net.js';
import { withDeadline } from '../../base/util/deadline.js';

/** Kept under its old name because src/server.ts publishes it. */
export const isLoopback = isLoopbackAddress;

// A proxy on this host (nginx, Caddy, cloudflared) connects from loopback, so these headers mean
// the caller is not local.
const PROXY_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'fly-client-ip',
] as const;

function proxyHeaderOf(req: IncomingMessage): string | undefined {
  return PROXY_HEADERS.find((name) => req.headers[name] !== undefined);
}

/**
 * A page in a browser on this machine: another site's request, or a hostile name resolved to
 * loopback (DNS rebinding).
 */
export function isForeignPage(req: IncomingMessage): boolean {
  const host = req.headers.host;
  return (host !== undefined && !LOOPBACK_HOST_HEADER.test(host)) || isCrossSite(req);
}

/** True only for a request made on this machine by its own user: a proxy and a browser page are
 * loopback too, so the socket alone proves nothing. Never the auth boundary (a forwarder such as
 * ssh -L adds no header); it only narrows what a caller that is already keyed or public may see. */
export function isLocalCaller(req: IncomingMessage): boolean {
  return (
    isLoopbackAddress(req.socket.remoteAddress) &&
    proxyHeaderOf(req) === undefined &&
    !isForeignPage(req)
  );
}

const KEY_REQUIRED_MESSAGE =
  'auth required: this server takes no request without an API key. Mint one with `hippo auth create` and send it as ' +
  '"Authorization: Bearer <key>"; the hippo CLI reads HIPPO_API_KEY, else the key `hippo serve` wrote to server.key.';

/** Reads the Authorization header case-insensitively (name and RFC 6750 'Bearer' scheme): {
 * kind: 'absent' }, { kind: 'malformed' } (set but not 'Bearer <token>'), or { kind: 'bearer',
 * token } for a non-empty token. */
type AuthHeader = { kind: 'absent' } | { kind: 'malformed' } | { kind: 'bearer'; token: string };

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

function requestClientKey(req: IncomingMessage): string {
  const auth = readAuthHeader(req);
  return clientKeyOf(req, auth.kind === 'bearer' ? auth.token : undefined);
}

type AuthOptions = Pick<
  ResolvedServeOptions,
  | 'hippoRoot'
  | 'authResolver'
  | 'authResolverTimeoutMs'
  | 'store'
  | 'reachOf'
  | 'callerLimiter'
  | 'localKey'
  | 'keyVerifier'
  | 'keyQuota'
> &
  Partial<Pick<ResolvedServeOptions, 'failedAuthLimiter'>>;

type ContextOptions = AuthOptions &
  Pick<
    ResolvedServeOptions,
    | 'configAt'
    | 'onHippoDb'
    | 'infra'
    | 'detached'
    | 'projectWriteGate'
    | 'projectWriteGateTimeoutMs'
  > &
  Partial<Pick<ResolvedServeOptions, 'callers' | 'signal' | 'ledgerStore'>>;

const RESERVED_ACTOR_NAMES = [
  'api_key',
  'localhost',
  'cli',
  'system',
  'mcp',
  'connector',
  'sleep',
  'post-compact',
  'recall',
  'agent-memories',
] as const;

/** Add-ons call this to refuse a subject that would collide with a built-in actor. */
export function isReservedActor(subject: string): boolean {
  const lower = subject.toLowerCase();
  return RESERVED_ACTOR_NAMES.some((n) => lower === n || lower.startsWith(`${n}:`));
}

const HIDDEN_CHAR = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

function hasControlChar(s: string): boolean {
  return HIDDEN_CHAR.test(s);
}

const MAX_RESOLVED_SCOPES = 1024;

// SHORTCUT: one line per process, so a resolver with a typo cannot flood the log; no per-tenant count.
let roleCoercionWarned = false;

function warnRoleCoerced(): void {
  if (roleCoercionWarned) return;
  roleCoercionWarned = true;
  log.warn(
    'auth resolver returned no role or one outside viewer, member and admin; read it as viewer',
  );
}

function sanitiseResolved(r: ResolvedBearer): ResolvedBearer | null {
  const { tenantId, subject, role, scopes } = r;
  if (!isJsonString(tenantId) || tenantId.trim().length === 0) return null;
  const tenant = tenantId.trim();
  if (tenant.startsWith('__') || tenant.length > MAX_ID_LEN || hasControlChar(tenant)) return null;
  if (!isJsonString(subject) || subject.length < 1 || subject.length > MAX_ID_LEN) return null;
  if (hasControlChar(subject) || subject !== subject.trim()) return null;
  if (isReservedActor(subject)) return null;
  const clean: ResolvedBearer = {
    tenantId: tenant,
    subject,
    role: roleOrViewer(role),
  };
  if (clean.role !== role) warnRoleCoerced();
  if (Array.isArray(scopes)) {
    if (scopes.length > MAX_RESOLVED_SCOPES) return null;
    const kept = scopes.filter((s) => isJsonString(s));
    if (kept.some((s) => s.length > MAX_ID_LEN)) return null;
    clean.scopes = kept;
  }
  return clean;
}

function withoutToken(fields: LogFields, token: string): LogFields {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [
      k,
      isJsonString(v) ? v.split(token).join('[token]') : v,
    ]),
  );
}

function logResolverFailure<E>(what: string, err: E, token: string): void {
  const message = errorMessage(err).split(token).join('[token]');
  log.error(`auth resolver ${what}: ${message}`, withoutToken(errorFields(err), token));
}

async function askResolver(
  resolver: AuthResolver,
  token: string,
  deadlineMs: number,
): Promise<ResolvedBearer> {
  let resolved: ResolvedBearer | null;
  try {
    resolved = await withDeadline(deadlineMs, (signal) => resolver(token, signal));
  } catch (err) {
    logResolverFailure('threw', err, token);
    throw new HttpError(503, 'auth provider unavailable');
  }
  let clean: ResolvedBearer | null = null;
  try {
    clean = resolved ? sanitiseResolved(resolved) : null;
  } catch (err) {
    logResolverFailure('threw', err, token);
  }
  if (!clean) throw new HttpError(401, 'invalid api key');
  return clean;
}

interface BearerIdentity extends ResolvedBearer {
  viaAuthResolver?: true;
  localKey?: true;
  owner?: string;
}

const DEFAULT_RESOLVER_DEADLINE_MS = 5000;

function chargeScryptRun(req: IncomingMessage, opts: AuthOptions): void {
  const limiter = opts.failedAuthLimiter;
  if (limiter && !limiter.check(clientLimitKey(req))) {
    throw new HttpError(429, 'too many key checks from this address', limiter.retryAfterSec);
  }
}

async function resolveBearer(
  req: IncomingMessage,
  token: string,
  opts: AuthOptions,
): Promise<BearerIdentity> {
  if (opts.localKey.matches(token)) {
    return {
      tenantId: envTenant(),
      subject: LOCAL_KEY_SUBJECT,
      role: 'member',
      scopes: [],
      localKey: true,
    };
  }
  if (opts.authResolver && !token.startsWith(API_KEY_PREFIX)) {
    const t = opts.authResolverTimeoutMs;
    const deadlineMs =
      t !== undefined && Number.isFinite(t) && t > 0 ? t : DEFAULT_RESOLVER_DEADLINE_MS;
    let clean: ResolvedBearer;
    try {
      clean = await askResolver(opts.authResolver, token, deadlineMs);
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) chargeScryptRun(req, opts);
      throw err;
    }
    return { ...clean, viaAuthResolver: true, owner: clean.subject };
  }
  return resolveApiKey(req, token, opts);
}

async function resolveApiKey(
  req: IncomingMessage,
  token: string,
  opts: AuthOptions,
): Promise<BearerIdentity> {
  const address = clientLimitKey(req);
  const key = await opts.keyVerifier.verify(
    token,
    opts.store,
    opts.keyVerifier.boundFor(address, () => chargeScryptRun(req, opts)),
    () => chargeScryptRun(req, opts),
  );
  if (!key) throw new HttpError(401, 'invalid api key');
  const id: BearerIdentity = {
    tenantId: key.tenantId,
    subject: `api_key:${key.keyId}`,
    role: key.role,
    scopes: key.scopes,
  };
  if (key.ownerSubject) id.owner = key.ownerSubject;
  return id;
}

async function checkAuth(req: IncomingMessage, opts: AuthOptions): Promise<BearerIdentity> {
  const auth = readAuthHeader(req);
  if (auth.kind === 'malformed') {
    throw new HttpError(401, 'invalid api key');
  }
  if (auth.kind === 'bearer') return resolveBearer(req, auth.token, opts);
  throw new HttpError(401, isLocalCaller(req) ? KEY_REQUIRED_MESSAGE : 'auth required');
}

function bearerActor(id: BearerIdentity): Actor {
  const actor: Actor = { subject: id.subject, role: id.role, scopes: id.scopes };
  if (id.owner !== undefined) actor.owner = id.owner;
  if (id.localKey) actor.localKey = true;
  if (id.viaAuthResolver) actor.viaAuthResolver = true;
  else if (id.role === 'admin' && id.tenantId === envTenant()) actor.hostAdmin = true;
  return actor;
}

const CALLER_WARN_EVERY_MS = MINUTE_MS;
const callerWarnedAt = new Map<string, number>();

function warnCallerLimited({
  key,
  tenantId,
  person,
}: {
  key: string;
  tenantId: string;
  person: string;
}): void {
  const now = Date.now();
  const last = callerWarnedAt.get(key);
  if (last !== undefined && now - last < CALLER_WARN_EVERY_MS) return;
  callerWarnedAt.delete(key);
  if (callerWarnedAt.size >= LIMITER_MAX_KEYS) {
    const oldest = callerWarnedAt.keys().next();
    if (!oldest.done) callerWarnedAt.delete(oldest.value);
  }
  callerWarnedAt.set(key, now);
  log.warn('caller over its rate limit; its further 429s this minute are not logged', {
    tenant: tenantId,
    person,
  });
}

function chargeCaller(
  req: IncomingMessage,
  tenantId: string,
  actor: Actor,
  opts: AuthOptions,
): void {
  const limiter = opts.callerLimiter;
  if (limiter) {
    const person = ownerOrSubject(actor);
    const key = `${tenantId}\u0000${person}`;
    if (!limiter.check(key)) {
      warnCallerLimited({ key, tenantId, person });
      throw new HttpError(429, 'rate limit exceeded for this caller', limiter.retryAfterSec);
    }
  }
  askKeyQuota(req, tenantId, actor, opts.keyQuota);
}

/** Builds a per-request Context from the Authorization header and remote address; throws
 * HttpError(401) on bad ones. Reads the store only for an API-key-shaped Bearer (or any Bearer
 * with no resolver), so the local key stays cheap. */
export async function buildContextWithAuth(
  req: IncomingMessage,
  opts: ContextOptions,
): Promise<Context> {
  const id = await checkAuth(req, opts);
  const ctx = contextFor(id, opts, requestClientKey(req));
  noteAccess(req, { role: ctx.actor.role });
  chargeCaller(req, id.tenantId, ctx.actor, opts);
  return ctx;
}

/** The auth check again, uncharged, for a handler that authenticated with requireAuth before a
 * slow body read and must re-check right before it acts. */
export async function recheckContextWithAuth(
  req: IncomingMessage,
  opts: ContextOptions,
): Promise<Context> {
  return contextFor(await checkAuth(req, opts), opts, requestClientKey(req));
}

function contextFor(id: BearerIdentity, opts: ContextOptions, clientKey: string): Context {
  const team = !opts.onHippoDb;
  const config = opts.configAt(opts.hippoRoot);
  const { ledgerStore } = opts;
  const ledger = ledgerStore && {
    ledger: ledgerStore.ledger,
    folderFiles: ledgerStore.folderFiles,
    config,
  };
  const infra = opts.infra();
  const reach = contextReach(opts.reachOf(team), opts.configAt, infra.embedderFor, ledger);
  const callers = opts.callers;
  const actor = bearerActor(id);
  const { store, signal, detached, projectWriteGate, projectWriteGateTimeoutMs } = opts;
  return {
    tenantId: id.tenantId,
    actor,
    store,
    reach,
    config,
    callers,
    clientKey,
    infra,
    signal,
    detached,
    projectWriteGate,
    projectWriteGateTimeoutMs,
  };
}

/** Auth check for routes that need no tenant Context (e.g. the MCP transport, which resolves its
 * own root): throws HttpError 401 like buildContextWithAuth. */
export async function requireAuth(req: IncomingMessage, opts: AuthOptions): Promise<void> {
  const id = await checkAuth(req, opts);
  chargeCaller(req, id.tenantId, bearerActor(id), opts);
}

/** Never rejects or charges a caller bucket: an outage (5xx) or a throttle (429) skips one tick;
 * only a definite 4xx denial closes the stream. */
export async function heartbeatVerdict(
  req: IncomingMessage,
  opts: AuthOptions,
): Promise<'ok' | 'revoked' | 'unavailable'> {
  try {
    await checkAuth(req, opts);
    return 'ok';
  } catch (err) {
    if (!(err instanceof HttpError)) {
      log.error(`heartbeat auth check failed: ${errorMessage(err)}`, errorFields(err));
    }
    return err instanceof HttpError && err.status < 500 && err.status !== 429
      ? 'revoked'
      : 'unavailable';
  }
}

/** Gate for any action beyond the caller's own tenant: a tenant's admin, by key or resolver, is
 * never a host admin. */
export function assertCrossTenantAdmin(ctx: Context, what: string): void {
  if (ctx.actor.role !== 'admin') throw new HttpError(403, `${what} requires admin role`);
  if (!ctx.actor.hostAdmin) throw new HttpError(403, `${what} requires a host admin`);
}
