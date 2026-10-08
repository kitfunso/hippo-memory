// API key management: create, list, revoke, and grant or ungrant restricted scopes.

import { openHippoDb, closeHippoDb } from '../db.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../api-errors.js';
import { appendAuditEvent, reportAuditWriteFailure } from '../audit.js';
import {
  forgetVerifiedKey, insertApiKey, listApiKeyRows, mintApiKey, revokeApiKey, grantScope, ungrantScope,
  type ApiKeyListItem, type ApiKeyListRow, type ApiKeyRecord, type ListApiKeysOpts, type NewApiKey,
} from '../auth.js';
import { DAY_MS } from '../dashboard-snapshot.js';
import type { KeysetPosition } from '../keyset.js';
import { isRestrictedScope } from '../recall-scope.js';
import { requireGroup, type HippoStore, type KeyMint, type SelfKeyMint } from '../store-port.js';
import { createAuditOf, createKeyAt, createSelfKeyAt } from '../store/key-writes.js';
import { selectApiKeyOwner, type ApiKeyOwner } from '../store/tenant-lookup.js';
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
  /**
   * Authorization role for the new key. Defaults to `'admin'` for
   * back-compat with keys minted before roles existed (the api_keys.role column DEFAULT also
   * resolves to 'admin' if omitted from the INSERT). Member keys are
   * 403-blocked from admin-gated routes (e.g. `POST /v1/sleep`).
   */
  role?: 'admin' | 'member';
}

export interface AuthCreateResult {
  keyId: string;
  plaintext: string;
  tenantId: string;
  /** The role bound to the new key (admin | member). */
  role: 'admin' | 'member';
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
  // With a store, its keyWrites group stores the key and its auth_create row together, and hippo.db is never opened.
  const reply = ctx.store ? createThroughStore(ctx, ctx.store, opts) : createOnHippoDb(ctx, opts);
  // SAFETY: as in authRevoke, a C typed with a store gets the promise its path returns and a C that hides one gets the union.
  return reply as StoreReply<C, AuthCreateResult>;
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

function adminKeyMint(ctx: Context, opts: AuthCreateOpts): KeyMintPlan<KeyMint> {
  if (ctx.actor.role !== 'admin') {
    throw new ForbiddenError('Only an admin key can create API keys');
  }
  if (ctx.actor.viaAuthResolver && opts.role === 'admin') {
    throw new ForbiddenError('A key minted through the auth resolver can only be a member key');
  }
  const role = opts.role ?? (ctx.actor.viaAuthResolver ? 'member' : 'admin');
  const label = opts.label ?? null;
  const { plaintext, key } = newKey(ctx, { label, role, ownerSubject: null, expiresAt: null });
  // The plaintext is NEVER logged; metadata carries label + role, keyId is non-secret.
  return { plaintext, mint: { key, actor: ctx.actor.subject, metadata: { label, role } } };
}

function createResult({ key }: KeyMint, plaintext: string): AuthCreateResult {
  return { keyId: key.keyId, plaintext, tenantId: key.tenantId, role: key.role };
}

async function createThroughStore(ctx: Context, store: HippoStore, opts: AuthCreateOpts): Promise<AuthCreateResult> {
  const keyWrites = requireGroup(store, 'keyWrites');
  const { plaintext, mint } = adminKeyMint(ctx, opts);
  await keyWrites.createApiKey(mint);
  return createResult(mint, plaintext);
}

function createOnHippoDb(ctx: Context, opts: AuthCreateOpts): AuthCreateResult {
  const { plaintext, mint } = adminKeyMint(ctx, opts);
  const db = openHippoDb(ctx.hippoRoot);
  try {
    // A resolver admin's keys are found again only through their audit rows, so the key and its row commit together.
    if (ctx.actor.viaAuthResolver) {
      createKeyAt(db, mint);
      return createResult(mint, plaintext);
    }
    insertApiKey(db, mint.key);
    try {
      appendAuditEvent(db, createAuditOf(mint));
    } catch (error) {
      // Audit must not crash a successful mint.
      reportAuditWriteFailure('auth_create', String(error), mint.key.keyId);
    }
    return createResult(mint, plaintext);
  } finally {
    closeHippoDb(db);
  }
}

const MAX_TTL_DAYS = 3650;

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

/** Mint a member key for the caller an auth resolver vouched for, whatever its role; the binary floor, the cap's revokes, the mint and its audit rows commit or fail together.
 *  With `ctx.store`, its keyWrites group runs that transaction; hippo.db is opened only when there is no store. */
export function authCreateSelf<C extends Context>(ctx: C, opts: AuthCreateSelfOpts): StoreReply<C, AuthCreateSelfResult> {
  const reply = ctx.store ? createSelfThroughStore(ctx, ctx.store, opts) : createSelfOnHippoDb(ctx, opts);
  // SAFETY: as in authRevoke, a C typed with a store gets the promise its path returns and a C that hides one gets the union.
  return reply as StoreReply<C, AuthCreateSelfResult>;
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

/** The store revokes the replaced keys without this process's verified-key cache, so they leave it here once the mint commits. */
async function createSelfThroughStore(ctx: Context, store: HippoStore, opts: AuthCreateSelfOpts): Promise<AuthCreateSelfResult> {
  const keyWrites = requireGroup(store, 'keyWrites');
  const { plaintext, mint } = selfKeyMint(ctx, opts);
  for (const keyId of await keyWrites.createSelfApiKey(mint)) forgetVerifiedKey(keyId);
  return selfResult(mint, plaintext);
}

function createSelfOnHippoDb(ctx: Context, opts: AuthCreateSelfOpts): AuthCreateSelfResult {
  const { plaintext, mint } = selfKeyMint(ctx, opts);
  const db = openHippoDb(ctx.hippoRoot);
  try {
    createSelfKeyAt(db, mint);
    return selfResult(mint, plaintext);
  } finally {
    closeHippoDb(db);
  }
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
  const keysOf = (rows: ApiKeyListRow[]): ApiKeyListItem[] => rows.map((r) => r.key);
  const rows = listRows(ctx, opts);
  // SAFETY: the promise comes back exactly when ctx has a store, as StoreReply says.
  return (rows instanceof Promise ? rows.then(keysOf) : keysOf(rows)) as StoreReply<C, ApiKeyListItem[]>;
}

type KeyListOpts = { active: boolean; limit?: number; after?: KeysetPosition };

/** One page of the caller's tenant's keys, newest first, with the row ids a next-page cursor is built from.
 *  With `ctx.store`, its keyWrites group reads them; hippo.db is opened only when there is no store. */
export function authListRows<C extends Context>(ctx: C, opts: KeyListOpts): StoreReply<C, ApiKeyListRow[]> {
  // SAFETY: the promise comes back exactly when ctx has a store, as StoreReply says.
  return listRows(ctx, opts) as StoreReply<C, ApiKeyListRow[]>;
}

function listRows(ctx: Context, opts: KeyListOpts): ApiKeyListRow[] | Promise<ApiKeyListRow[]> {
  return ctx.store ? listThroughStore(ctx, ctx.store, opts) : listOnHippoDb(ctx, opts);
}

async function listThroughStore(ctx: Context, store: HippoStore, opts: KeyListOpts): Promise<ApiKeyListRow[]> {
  const keyWrites = requireGroup(store, 'keyWrites');
  const keyId = memberKeyIdOf(ctx.actor);
  const filter = memberListFilter(ctx.actor, keyId === null ? undefined : (await store.findApiKey(keyId))?.ownerSubject);
  return filter === null ? [] : keyWrites.listApiKeys({ ...opts, tenantId: ctx.tenantId, ...filter });
}

function listOnHippoDb(ctx: Context, opts: KeyListOpts): ApiKeyListRow[] {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    const keyId = memberKeyIdOf(ctx.actor);
    const filter = memberListFilter(ctx.actor, keyId === null ? undefined : selectApiKeyOwner(db, keyId)?.ownerSubject);
    return filter === null ? [] : listApiKeyRows(db, { ...opts, tenantId: ctx.tenantId, ...filter });
  } finally {
    closeHippoDb(db);
  }
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
 *  With `ctx.store`, its keyAudit group revokes and writes the auth_revoke row; hippo.db is opened only when there is no store. */
export function authRevoke<C extends Context>(ctx: C, keyId: string): AuthRevokeReply<C> {
  const reply = ctx.store ? revokeThroughStore(ctx, ctx.store, keyId) : revokeOnHippoDb(ctx, keyId);
  // SAFETY: a C typed with a store gets the promise its path returns; a C whose type hides a runtime store (a Pick of
  // Context) is typed as the union, which a caller has to await anyway.
  return reply as AuthRevokeReply<C>;
}

function assertMemberKeyRevokesSelf(ctx: Context, keyId: string): void {
  if (ctx.actor.role !== 'admin' && !ctx.actor.viaAuthResolver && keyIdOfSubject(ctx.actor.subject) !== keyId) {
    throw new ForbiddenError('A member key can revoke only itself');
  }
}

function keyOwnerOf(record: ApiKeyRecord | null): ApiKeyOwner | undefined {
  return record ? { tenantId: record.tenantId, revokedAt: record.revokedAt, role: record.role, ownerSubject: record.ownerSubject ?? null } : undefined;
}

/** The store keeps no handle on this process's verified-key cache, so the key leaves it here once the revoke commits. */
async function revokeThroughStore(ctx: Context, store: HippoStore, keyId: string): Promise<AuthRevokeResult> {
  const keyAudit = requireGroup(store, 'keyAudit');
  assertMemberKeyRevokesSelf(ctx, keyId);
  assertMayRevoke(ctx, keyId, keyOwnerOf(await store.findApiKey(keyId)));
  const revokedAt = await keyAudit.revokeApiKey({ tenantId: ctx.tenantId, keyId, actor: ctx.actor.subject, at: new Date().toISOString() });
  forgetVerifiedKey(keyId);
  return { ok: true, revokedAt };
}

/** The auth_revoke row carries the KEY ROW's tenant, as cmdAuthRevoke does, and is skipped for an already-revoked key. */
function revokeOnHippoDb(ctx: Context, keyId: string): AuthRevokeResult {
  assertMemberKeyRevokesSelf(ctx, keyId);
  const db = openHippoDb(ctx.hippoRoot);
  try {
    const row = selectApiKeyOwner(db, keyId);
    assertMayRevoke(ctx, keyId, row);

    let revokedAt: string;
    let alreadyRevoked = false;
    if (row.revokedAt) {
      alreadyRevoked = true;
      revokedAt = row.revokedAt;
    } else {
      revokeApiKey(db, keyId);
      revokedAt = selectApiKeyOwner(db, keyId)?.revokedAt ?? new Date().toISOString();
    }

    if (!alreadyRevoked) {
      try {
        appendAuditEvent(db, {
          tenantId: row.tenantId, // KEY's tenant, not ctx.tenantId.
          actor: ctx.actor.subject,
          op: 'auth_revoke',
          targetId: keyId,
        });
      } catch (error) {
        // Audit must not crash a successful revoke.
        reportAuditWriteFailure('auth_revoke', String(error), keyId);
      }
    }

    return { ok: true, revokedAt };
  } finally {
    closeHippoDb(db);
  }
}

/**
 * The tenant that owns `keyId`, or undefined for an unknown key. Host admin only: it reads across tenants,
 * so the local CLI can run revoke and grant in the key's own tenant.
 */
export function authKeyTenant(ctx: Context, keyId: string): string | undefined {
  if (!ctx.actor.hostAdmin) {
    throw new ForbiddenError('Only the host admin can look up a key across tenants');
  }
  const db = openHippoDb(ctx.hippoRoot);
  try {
    return selectApiKeyOwner(db, keyId)?.tenantId;
  } finally {
    closeHippoDb(db);
  }
}

/** Shared result shape for authGrant/authUngrant, named per the file's oxlint anti-slop rule. */
export interface AuthGrantResult {
  ok: true;
}

/** Grant `keyId` read access to one restricted `scope`. Admin only. */
export function authGrant(ctx: Context, keyId: string, scope: string): AuthGrantResult {
  return changeScopeGrant(ctx, keyId, scope, 'auth_grant');
}

/** Revoke `keyId`'s grant on `scope`. Same authorization and lookup rules as authGrant. */
export function authUngrant(ctx: Context, keyId: string, scope: string): AuthGrantResult {
  return changeScopeGrant(ctx, keyId, scope, 'auth_ungrant');
}

function changeScopeGrant(ctx: Context, keyId: string, scope: string, op: 'auth_grant' | 'auth_ungrant'): AuthGrantResult {
  if (ctx.actor.role !== 'admin') {
    throw new ForbiddenError('Only an admin key can change scope grants');
  }
  const db = openHippoDb(ctx.hippoRoot);
  try {
    const row = selectApiKeyOwner(db, keyId);
    if (!row || row.tenantId !== ctx.tenantId) {
      throw new NotFoundError(`Unknown key_id: ${keyId}`);
    }
    if (op === 'auth_grant' && row.revokedAt) {
      throw new ConflictError(`${keyId} is revoked; a grant on it would never apply`);
    }
    if (op === 'auth_grant' && /^personal:/i.test(scope)) {
      throw new BadRequestError(`${scope} is a personal scope: only its owner reads it, and no grant can change that`);
    }
    if (!isRestrictedScope(scope)) {
      throw new BadRequestError(`${scope} is not a restricted scope; it is already readable by default`);
    }
    if (op === 'auth_grant') grantScope(db, keyId, scope);
    else ungrantScope(db, keyId, scope);
    try {
      appendAuditEvent(db, { tenantId: ctx.tenantId, actor: ctx.actor.subject, op, targetId: keyId, metadata: { scope } });
    } catch (err) {
      // Audit must not undo a grant change that already committed; surface it instead.
      reportAuditWriteFailure(op, String(err), keyId);
    }
    return { ok: true };
  } finally {
    closeHippoDb(db);
  }
}
