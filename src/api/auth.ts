// API key management: create, list, revoke, and grant or ungrant restricted scopes.

import { BadRequestError, ForbiddenError, NotFoundError } from '../api-errors.js';
import {
  mintApiKey,
  type ApiKeyListItem, type ApiKeyListRow, type ApiKeyRecord, type ListApiKeysOpts, type NewApiKey,
} from '../store/auth.js';
import type { KeysetPosition } from '../keyset.js';
import type { KeyMint, SelfKeyMint } from '../store-port.js';
import { changeScopeGrant } from '../store/sqlite/local.js';
import { sqliteSyncStore } from '../store/sqlite/store.js';
import type { ApiKeyOwner } from '../store/tenant-lookup.js';
import { DAY_MS } from '../util/time.js';
import { andThen, notPorted, onStore, type Reply, type StorePort } from './on-store.js';
import type { Actor, Context, StoreReply } from './types.js';

const API_KEY_SUBJECT = 'api_key:';

/** The key id an API-key actor's subject names, or null for any other actor. */
function keyIdOfSubject(subject: string): string | null {
  return subject.startsWith(API_KEY_SUBJECT) ? subject.slice(API_KEY_SUBJECT.length) : null;
}

// ---------------------------------------------------------------------------
// auth: create / list / revoke
// ---------------------------------------------------------------------------

export interface AuthCreateOpts {
  label?: string;
  /** Defaults to `'member'`, which admin-gated routes such as `POST /v1/sleep` refuse; an admin key has to be asked for by name. */
  role?: 'admin' | 'member';
  /** Days until the key expires: above 0 and at most 3650. Defaults to 90. */
  ttlDays?: number;
  /** True mints a key that never expires, which has to be asked for by name; refused together with `ttlDays`. */
  noExpiry?: boolean;
}

export interface AuthCreateResult {
  keyId: string;
  plaintext: string;
  tenantId: string;
  /** The role bound to the new key (admin | member). */
  role: 'admin' | 'member';
  /** ISO time the key stops working; null for a key that never expires. */
  expiresAt: string | null;
}

/**
 * Mint a new API key. The new key is ALWAYS bound to `ctx.tenantId`. Callers
 * cannot override the tenant via the opts bag — a previous `tenantId` field
 * was removed because the HTTP layer would happily forward `body.tenantId`,
 * letting tenant A mint a key for tenant B. The HTTP route handler at
 * `src/server.ts` POST /v1/auth/keys mirrors this: it ignores any body
 * `tenantId` and uses the resolved Bearer's tenant exclusively.
 *
 * Only an admin actor can mint (ForbiddenError otherwise), and a key never
 * outranks its minter: a resolver admin is tenant-only, so it mints members.
 */
export function authCreate<C extends Context>(ctx: C, opts: AuthCreateOpts): StoreReply<C, AuthCreateResult> {
  // The key and its auth_create row commit together on either store, so a failed audit write leaves no key.
  return onStore(ctx, (port) => {
    const keyWrites = port.keyWrites ?? notPorted(port, 'keyWrites');
    const { plaintext, mint } = adminKeyMint(ctx, opts);
    return andThen(keyWrites.createApiKey(mint), () => createResult(mint, plaintext));
  });
}

/** What a mint stores, and the plaintext only its caller sees. */
interface KeyMintPlan<M extends KeyMint> {
  readonly plaintext: string;
  readonly mint: M;
}

type KeyFields = Pick<NewApiKey, 'label' | 'role' | 'ownerSubject' | 'expiresAt'>;

interface MintedKeyRow<F extends KeyFields> {
  readonly plaintext: string;
  readonly key: NewApiKey & F;
}

/** A key row in the caller's tenant, made here so only its hash ever reaches a store. */
function newKey<F extends KeyFields>(ctx: Context, fields: F): MintedKeyRow<F> {
  const { keyId, plaintext, keyHash } = mintApiKey();
  return { plaintext, key: { ...fields, keyId, keyHash, tenantId: ctx.tenantId, createdAt: new Date().toISOString() } };
}

/** Days a key lives when its mint names no expiry, so a key nobody remembers stops working by itself. */
const DEFAULT_KEY_TTL_DAYS = 90;

// The ceiling keeps toISOString in range.
const MAX_TTL_DAYS = 3650;

/** A 400, not a RangeError, since the caller of the mint chose these. */
function mintExpiry({ ttlDays, noExpiry }: AuthCreateOpts): string | null {
  if (noExpiry && ttlDays !== undefined) {
    throw new BadRequestError('send ttlDays or noExpiry, not both');
  }
  if (noExpiry) return null;
  const days = ttlDays ?? DEFAULT_KEY_TTL_DAYS;
  if (!Number.isFinite(days) || days <= 0 || days > MAX_TTL_DAYS) {
    throw new BadRequestError(`ttlDays must be above 0 and at most ${MAX_TTL_DAYS}`);
  }
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

function adminKeyMint(ctx: Context, opts: AuthCreateOpts): KeyMintPlan<KeyMint> {
  if (ctx.actor.role !== 'admin') {
    throw new ForbiddenError('Only an admin key can create API keys');
  }
  if (ctx.actor.viaAuthResolver && opts.role === 'admin') {
    throw new ForbiddenError('A key minted through the auth resolver can only be a member key');
  }
  const role = opts.role ?? 'member';
  const label = opts.label ?? null;
  const expiresAt = mintExpiry(opts);
  const { plaintext, key } = newKey(ctx, { label, role, ownerSubject: null, expiresAt });
  // The plaintext is NEVER logged; the audit row carries what the key can do and for how long, keyId is non-secret.
  return { plaintext, mint: { key, actor: ctx.actor.subject, metadata: { label, role, expiresAt } } };
}

function createResult({ key }: KeyMint, plaintext: string): AuthCreateResult {
  return { keyId: key.keyId, plaintext, tenantId: key.tenantId, role: key.role, expiresAt: key.expiresAt };
}

export interface AuthCreateSelfOpts {
  label?: string;
  /** Days until the new key expires. */
  ttlDays: number;
  /** Live self-minted keys one subject may hold; minting past it revokes the oldest. */
  perSubject: number;
}

export interface AuthCreateSelfResult extends AuthCreateResult {
  /** ISO time the key stops working. */
  expiresAt: string;
}

/** A RangeError, not a 4xx, since the operator's config sets these; the ttl ceiling keeps toISOString in range and a departed user's key short-lived. */
function assertSelfMintOpts({ ttlDays, perSubject }: AuthCreateSelfOpts): void {
  if (!Number.isFinite(ttlDays) || ttlDays <= 0 || ttlDays > MAX_TTL_DAYS) {
    throw new RangeError(`authCreateSelf: ttlDays must be above 0 and at most ${MAX_TTL_DAYS}, got ${String(ttlDays)}`);
  }
  if (!Number.isInteger(perSubject) || perSubject < 1) {
    throw new RangeError(`authCreateSelf: perSubject must be a whole number of at least 1, got ${String(perSubject)}`);
  }
}

/** Mint a member key for the caller an auth resolver vouched for, whatever its role; the binary floor, the cap's revokes, the mint and its audit rows commit or fail together. */
export function authCreateSelf<C extends Context>(ctx: C, opts: AuthCreateSelfOpts): StoreReply<C, AuthCreateSelfResult> {
  return onStore(ctx, (port) => {
    const keyWrites = port.keyWrites ?? notPorted(port, 'keyWrites');
    const { plaintext, mint } = selfKeyMint(ctx, opts);
    return andThen(keyWrites.createSelfApiKey(mint), () => selfResult(mint, plaintext));
  });
}

function selfKeyMint(ctx: Context, opts: AuthCreateSelfOpts): KeyMintPlan<SelfKeyMint> {
  if (!ctx.actor.viaAuthResolver) {
    throw new ForbiddenError('Only a caller signed in through the auth resolver can mint its own key');
  }
  assertSelfMintOpts(opts);
  const { subject } = ctx.actor;
  const label = opts.label ?? null;
  const expiresAt = new Date(Date.now() + opts.ttlDays * DAY_MS).toISOString();
  // Not destructured: a binding pattern makes TypeScript infer F as KeyFields and lose ownerSubject's string type.
  const made = newKey(ctx, { label, role: 'member', ownerSubject: subject, expiresAt });
  // Same op and actor as an admin mint, so a lookup by audit row finds this key too.
  return { plaintext: made.plaintext, mint: { key: made.key, actor: subject, metadata: { label, role: 'member', self: true, expiresAt }, perSubject: opts.perSubject } };
}

function selfResult({ key }: SelfKeyMint, plaintext: string): AuthCreateSelfResult {
  return { keyId: key.keyId, plaintext, tenantId: key.tenantId, role: 'member', expiresAt: key.expiresAt };
}

/**
 * List API keys visible to the calling tenant.
 *
 * Divergence from `cmdAuthList` in src/cli.ts: the CLI today returns ALL keys
 * regardless of tenant (single-tenant deployments). The API surface is tenant-
 * scoped because future multi-tenant deployments will share a hippoRoot, and
 * tenant A must not see tenant B's keys. Read-only, so no audit emit.
 */
export function authList<C extends Context>(
  ctx: C,
  opts: { active: boolean },
): StoreReply<C, ApiKeyListItem[]> {
  return onStore(ctx, (port) => andThen(listRows(ctx, port, opts), (rows) => rows.map((r) => r.key)));
}

type KeyListOpts = { active: boolean; limit?: number; after?: KeysetPosition };

/** One page of the caller's tenant's keys, newest first, with the row ids a next-page cursor is built from. */
export function authListRows<C extends Context>(ctx: C, opts: KeyListOpts): StoreReply<C, ApiKeyListRow[]> {
  return onStore(ctx, (port) => listRows(ctx, port, opts));
}

function listRows(ctx: Context, port: StorePort, opts: KeyListOpts): Reply<ApiKeyListRow[]> {
  const keyWrites = port.keyWrites ?? notPorted(port, 'keyWrites');
  const keyId = memberKeyIdOf(ctx.actor);
  return andThen(keyId === null ? undefined : port.findApiKey(keyId), (record) => {
    const filter = memberListFilter(ctx.actor, record?.ownerSubject);
    return filter === null ? [] : keyWrites.listApiKeys({ ...opts, tenantId: ctx.tenantId, ...filter });
  });
}

/** The key id of a member API key caller, whose owner decides what it lists; null for any other caller. */
function memberKeyIdOf(actor: Actor): string | null {
  return actor.role === 'admin' || actor.viaAuthResolver ? null : keyIdOfSubject(actor.subject);
}

/** A member sees only the keys its person minted, or just its own key when that has no owner; an admin sees the whole tenant; null means no keys. */
function memberListFilter(actor: Actor, owner: string | null | undefined): Pick<ListApiKeysOpts, 'ownerSubject' | 'keyId'> | null {
  if (actor.role === 'admin') return {};
  if (actor.viaAuthResolver) return { ownerSubject: actor.subject };
  const keyId = memberKeyIdOf(actor);
  if (keyId === null) return null;
  return owner ? { ownerSubject: owner } : { keyId };
}

/** Throws unless `ctx` may revoke `keyId`; a member gets one answer for a missing, foreign or unowned key, so it cannot probe key ids. */
function assertMayRevoke(ctx: Context, keyId: string, row: ApiKeyOwner | undefined): asserts row is ApiKeyOwner {
  const { actor } = ctx;
  if (actor.role !== 'admin' && actor.viaAuthResolver && (row?.tenantId !== ctx.tenantId || row.ownerSubject !== actor.subject)) {
    throw new ForbiddenError('A member can revoke only the keys it minted');
  }
  // Cross-tenant access denied: same message as missing key, no info leak.
  if (!row || row.tenantId !== ctx.tenantId) {
    throw new NotFoundError(`Unknown key_id: ${keyId}`);
  }
  if (actor.viaAuthResolver && row.role === 'admin') {
    throw new ForbiddenError('An auth resolver admin cannot revoke an admin key, which outranks it');
  }
}

export interface AuthRevokeResult {
  ok: true;
  revokedAt: string;
}

export type AuthRevokeReply<C extends Context> = StoreReply<C, AuthRevokeResult>;

/** Revoke a key in the caller's tenant: a member API key may revoke only itself, a resolver member only the keys it minted.
 *  The revoke and its auth_revoke row commit together on either store, so a failed audit write leaves the key live. */
export function authRevoke<C extends Context>(ctx: C, keyId: string): AuthRevokeReply<C> {
  return onStore(ctx, (port) => {
    const keyAudit = port.keyAudit ?? notPorted(port, 'keyAudit');
    assertMemberKeyRevokesSelf(ctx, keyId);
    return andThen(port.findApiKey(keyId), (record) => {
      assertMayRevoke(ctx, keyId, keyOwnerOf(record));
      const revoke = { tenantId: ctx.tenantId, keyId, actor: ctx.actor.subject, at: new Date().toISOString() };
      return andThen(keyAudit.revokeApiKey(revoke), (revokedAt): AuthRevokeResult => ({ ok: true, revokedAt }));
    });
  });
}

function assertMemberKeyRevokesSelf(ctx: Context, keyId: string): void {
  if (ctx.actor.role !== 'admin' && !ctx.actor.viaAuthResolver && keyIdOfSubject(ctx.actor.subject) !== keyId) {
    throw new ForbiddenError('A member key can revoke only itself');
  }
}

function keyOwnerOf(record: ApiKeyRecord | null): ApiKeyOwner | undefined {
  return record ? { tenantId: record.tenantId, revokedAt: record.revokedAt, role: record.role, ownerSubject: record.ownerSubject ?? null } : undefined;
}

/**
 * The tenant that owns `keyId`, or undefined for an unknown key. Host admin only: it reads across tenants,
 * so the local CLI can run revoke and grant in the key's own tenant.
 */
export function authKeyTenant(ctx: Context, keyId: string): string | undefined {
  if (!ctx.actor.hostAdmin) {
    throw new ForbiddenError('Only the host admin can look up a key across tenants');
  }
  // Synchronous for the CLI, so it reads hippo.db whatever store ctx names.
  return sqliteSyncStore(ctx.hippoRoot).findApiKey(keyId)?.tenantId;
}

/** Shared result shape for authGrant/authUngrant, named per the file's oxlint anti-slop rule. */
export interface AuthGrantResult {
  ok: true;
}

/** Grant `keyId` read access to one restricted `scope`. Admin only. */
export function authGrant(ctx: Context, keyId: string, scope: string): AuthGrantResult {
  return changeGrant(ctx, keyId, scope, 'auth_grant');
}

/** Revoke `keyId`'s grant on `scope`. Same authorization and lookup rules as authGrant. */
export function authUngrant(ctx: Context, keyId: string, scope: string): AuthGrantResult {
  return changeGrant(ctx, keyId, scope, 'auth_ungrant');
}

/** hippo.db only: both callers are synchronous published functions, so no store's Promise can answer them. */
function changeGrant(ctx: Context, keyId: string, scope: string, op: 'auth_grant' | 'auth_ungrant'): AuthGrantResult {
  if (ctx.actor.role !== 'admin') {
    throw new ForbiddenError('Only an admin key can change scope grants');
  }
  changeScopeGrant(ctx.hippoRoot, { tenantId: ctx.tenantId, keyId, scope, op, actor: ctx.actor.subject });
  return { ok: true };
}
