// API key management: create, list, revoke, and grant or ungrant restricted scopes.

import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../db.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../api-errors.js';
import { appendAuditEvent, reportAuditWriteFailure } from '../audit.js';
import {
  createApiKey, forgetVerifiedKey, listApiKeyRows, listLiveOwnedKeyIds, revokeApiKey, grantScope, ungrantScope,
  type ApiKeyListItem, type ApiKeyListRow, type ApiKeyRecord, type CreateApiKeyResult, type ListApiKeysOpts,
} from '../auth.js';
import { DAY_MS } from '../dashboard-snapshot.js';
import type { KeysetPosition } from '../keyset.js';
import { isRestrictedScope } from '../recall-scope.js';
import { requireGroup, type HippoStore } from '../store-port.js';
import { selectApiKeyOwner, type ApiKeyOwner } from '../store/tenant-lookup.js';
import type { Context, StoreReply } from './types.js';

const API_KEY_SUBJECT = 'api_key:';

/** The key id an API-key actor's subject names, or null for any other actor. */
function keyIdOfSubject(subject: string): string | null {
  return subject.startsWith(API_KEY_SUBJECT) ? subject.slice(API_KEY_SUBJECT.length) : null;
}

function inTransaction<T>(db: DatabaseSyncLike, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* keep the original error */ }
    throw err;
  }
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
export function authCreate(ctx: Context, opts: AuthCreateOpts): AuthCreateResult {
  if (ctx.actor.role !== 'admin') {
    throw new ForbiddenError('Only an admin key can create API keys');
  }
  if (ctx.actor.viaAuthResolver && opts.role === 'admin') {
    throw new ForbiddenError('A key minted through the auth resolver can only be a member key');
  }
  const db = openHippoDb(ctx.hippoRoot);
  try {
    const role = opts.role ?? (ctx.actor.viaAuthResolver ? 'member' : 'admin');
    const mint = (): CreateApiKeyResult => createApiKey(db, { tenantId: ctx.tenantId, label: opts.label, role });
    // The plaintext is NEVER logged; metadata carries label + role, keyId is non-secret.
    const audit = (keyId: string): void => appendAuditEvent(db, {
      tenantId: ctx.tenantId, actor: ctx.actor.subject, op: 'auth_create', targetId: keyId, metadata: { label: opts.label ?? null, role },
    });
    // A resolver admin's keys are found again only through their audit rows, so the key and its row commit together.
    if (ctx.actor.viaAuthResolver) {
      const result = inTransaction(db, () => {
        const minted = mint();
        audit(minted.keyId);
        return minted;
      });
      return { keyId: result.keyId, plaintext: result.plaintext, tenantId: ctx.tenantId, role };
    }
    const result = mint();
    try {
      audit(result.keyId);
    } catch (error) {
      // Audit must not crash a successful mint.
      reportAuditWriteFailure('auth_create', String(error), result.keyId);
    }
    return { keyId: result.keyId, plaintext: result.plaintext, tenantId: ctx.tenantId, role };
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

/** Mint a member key for the caller an auth resolver vouched for, whatever its role; the binary floor, the cap's revokes, the mint and its audit rows commit or fail together. */
export function authCreateSelf(ctx: Context, opts: AuthCreateSelfOpts): AuthCreateSelfResult {
  if (!ctx.actor.viaAuthResolver) {
    throw new ForbiddenError('Only a caller signed in through the auth resolver can mint its own key');
  }
  assertSelfMintOpts(opts);
  const { tenantId, actor: { subject } } = ctx;
  const now = Date.now();
  const expiresAt = new Date(now + opts.ttlDays * DAY_MS).toISOString();
  const db = openHippoDb(ctx.hippoRoot);
  try {
    // IMMEDIATE takes the write lock before the count, so two mints for one subject cannot both see room under the cap.
    const result = inTransaction(db, () => {
      const live = listLiveOwnedKeyIds(db, tenantId, subject, now);
      const replaced = live.slice(0, Math.max(0, live.length - opts.perSubject + 1));
      const minted = createApiKey(db, { tenantId, label: opts.label, role: 'member', ownerSubject: subject, expiresAt });
      for (const keyId of replaced) {
        revokeApiKey(db, keyId);
        appendAuditEvent(db, { tenantId, actor: subject, op: 'auth_revoke', targetId: keyId, metadata: { replacedBy: minted.keyId } });
      }
      // Same op and actor as an admin mint, so a lookup by audit row finds this key too.
      appendAuditEvent(db, {
        tenantId, actor: subject, op: 'auth_create', targetId: minted.keyId,
        metadata: { label: opts.label ?? null, role: 'member', self: true, expiresAt },
      });
      return minted;
    });
    return { keyId: result.keyId, plaintext: result.plaintext, tenantId, role: 'member', expiresAt };
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
export function authList(
  ctx: Context,
  opts: { active: boolean },
): ApiKeyListItem[] {
  return authListRows(ctx, opts).map((r) => r.key);
}

/** One page of the caller's tenant's keys, newest first, with the row ids a next-page cursor is built from. */
export function authListRows(
  ctx: Context,
  opts: { active: boolean; limit?: number; after?: KeysetPosition },
): ApiKeyListRow[] {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    const filter = memberListFilter(db, ctx);
    return filter === null ? [] : listApiKeyRows(db, { ...opts, tenantId: ctx.tenantId, ...filter });
  } finally {
    closeHippoDb(db);
  }
}

/** A member sees only the keys its person minted, or just its own key when that has no owner; an admin sees the whole tenant; null means no keys. */
function memberListFilter(db: DatabaseSyncLike, ctx: Context): Pick<ListApiKeysOpts, 'ownerSubject' | 'keyId'> | null {
  const { actor } = ctx;
  if (actor.role === 'admin') return {};
  if (actor.viaAuthResolver) return { ownerSubject: actor.subject };
  const keyId = keyIdOfSubject(actor.subject);
  if (keyId === null) return null;
  const owner = selectApiKeyOwner(db, keyId)?.ownerSubject;
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

/** A promise when `ctx` carries a store; today's plain result when it carries none. */
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
