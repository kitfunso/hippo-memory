// Owner lookups by id: the tenant and scope checks in src/api and the CLI's key-tenant lookup share these queries.

import type { DatabaseSyncLike } from '../db/index.js';

/** The api_keys fields a tenant, revocation, rank or self-service ownership check reads. */
export interface ApiKeyOwner {
  tenantId: string;
  revokedAt: string | null;
  role: string;
  ownerSubject: string | null;
}

/** The owner row of `keyId`, or undefined when no such key exists. */
export function selectApiKeyOwner(db: DatabaseSyncLike, keyId: string): ApiKeyOwner | undefined {
  // SAFETY: row's shape matches the four columns named in the SELECT.
  const row = db
    .prepare(`SELECT tenant_id, revoked_at, role, owner_subject FROM api_keys WHERE key_id = ?`)
    .get(keyId) as { tenant_id: string; revoked_at: string | null; role: string; owner_subject: string | null } | undefined;
  return row && { tenantId: row.tenant_id, revokedAt: row.revoked_at, role: row.role, ownerSubject: row.owner_subject };
}

/** Who may reach memory `id`: its tenant and scope, or undefined when no such memory exists. */
export function selectMemoryReach(db: DatabaseSyncLike, id: string): { tenantId: string; scope: string | null } | undefined {
  // SAFETY: row's shape matches the tenant_id and scope columns named in the SELECT.
  const row = db.prepare(`SELECT tenant_id, scope FROM memories WHERE id = ?`).get(id) as { tenant_id: string; scope: string | null } | undefined;
  return row && { tenantId: row.tenant_id, scope: row.scope };
}
