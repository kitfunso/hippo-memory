// API key management: create, list, revoke, and grant or ungrant restricted scopes.

import { openHippoDb, closeHippoDb } from '../db.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../api-errors.js';
import { appendAuditEvent, reportAuditWriteFailure } from '../audit.js';
import { createApiKey, listApiKeyRows, revokeApiKey, grantScope, ungrantScope, type ApiKeyListItem, type ApiKeyListRow } from '../auth.js';
import type { KeysetPosition } from '../keyset.js';
import { isRestrictedScope } from '../recall-scope.js';
import { selectApiKeyOwner } from '../store/tenant-lookup.js';
import type { Context } from './types.js';

// ---------------------------------------------------------------------------
// auth: create / list / revoke
// ---------------------------------------------------------------------------

export interface AuthCreateOpts {
  label?: string;
  /**
   * v1.12.3: authorization role for the new key. Defaults to `'admin'` for
   * back-compat with v1.12.0-v1.12.2 (the api_keys.role column DEFAULT also
   * resolves to 'admin' if omitted from the INSERT). Member keys are
   * 403-blocked from admin-gated routes (e.g. `POST /v1/sleep`).
   */
  role?: 'admin' | 'member';
}

export interface AuthCreateResult {
  keyId: string;
  plaintext: string;
  tenantId: string;
  /** v1.12.3: the role bound to the new key (admin | member). */
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
    const result = createApiKey(db, { tenantId: ctx.tenantId, label: opts.label, role });
    // v1.12.4: audit emit (closes the gap v1.12.3 CHANGELOG flagged as deferred).
    // Mirrors the auth_revoke pattern at authRevoke — same try/catch so audit
    // failure can't crash a successful mint. The plaintext is NEVER logged;
    // metadata carries label + role + the keyId (which is non-secret).
    try {
      appendAuditEvent(db, {
        tenantId: ctx.tenantId,
        actor: ctx.actor.subject,
        op: 'auth_create',
        targetId: result.keyId,
        metadata: {
          label: opts.label ?? null,
          role,
        },
      });
    } catch (error) {
      // Audit must not crash a successful mint.
      reportAuditWriteFailure('auth_create', String(error), result.keyId);
    }
    return { keyId: result.keyId, plaintext: result.plaintext, tenantId: ctx.tenantId, role };
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
 * tenant A must not see tenant B's keys. Read-only — no audit emit (matches A5).
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
    return listApiKeyRows(db, { ...opts, tenantId: ctx.tenantId });
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Revoke an API key.
 *
 * Security: the key must belong to `ctx.tenantId`. Cross-tenant revoke is
 * rejected with the "not found" message used for missing keys, and a member may
 * revoke only its own key (checked first), so no caller can probe other key_ids.
 *
 * Audit: emits 'auth_revoke' with `tenantId` set to the KEY ROW's tenant_id
 * (M1 fix from A5 review, mirrors src/cli.ts:cmdAuthRevoke). Skipped on no-op
 * revoke (already revoked) so re-running doesn't pad the audit log.
 */
export interface AuthRevokeResult {
  ok: true;
  revokedAt: string;
}
export function authRevoke(
  ctx: Context,
  keyId: string,
): AuthRevokeResult {
  if (ctx.actor.role !== 'admin' && ctx.actor.subject !== `api_key:${keyId}`) {
    throw new ForbiddenError('A member key can revoke only itself');
  }
  const db = openHippoDb(ctx.hippoRoot);
  try {
    const row = selectApiKeyOwner(db, keyId);
    // Cross-tenant access denied: same message as missing key, no info leak.
    if (!row || row.tenantId !== ctx.tenantId) {
      throw new NotFoundError(`Unknown key_id: ${keyId}`);
    }
    if (ctx.actor.viaAuthResolver && row.role === 'admin') {
      throw new ForbiddenError('An auth resolver admin cannot revoke an admin key, which outranks it');
    }

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
          tenantId: row.tenantId, // M1: KEY's tenant, not ctx.tenantId.
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

/** Grant `keyId` read access to one restricted `scope` (ROADMAP Part VIII EI2). Admin only. */
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
