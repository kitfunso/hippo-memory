// Owner lookups by id: the tenant checks in src/api and the CLI's key-tenant lookup share these queries.

import type { DatabaseSyncLike } from '../db.js';

/** The api_keys fields a tenant, revocation or rank check reads. */
export interface ApiKeyOwner {
  tenantId: string;
  revokedAt: string | null;
  role: string;
}

/** The owner row of `keyId`, or undefined when no such key exists. */
export function selectApiKeyOwner(db: DatabaseSyncLike, keyId: string): ApiKeyOwner | undefined {
  // SAFETY: row's shape matches the three columns named in the SELECT.
  const row = db
    .prepare(`SELECT tenant_id, revoked_at, role FROM api_keys WHERE key_id = ?`)
    .get(keyId) as { tenant_id: string; revoked_at: string | null; role: string } | undefined;
  return row && { tenantId: row.tenant_id, revokedAt: row.revoked_at, role: row.role };
}

/** The tenant that owns memory `id`, or undefined when no such memory exists. */
export function selectMemoryTenant(db: DatabaseSyncLike, id: string): string | undefined {
  // SAFETY: row's shape matches the single tenant_id column named in the SELECT.
  const row = db.prepare(`SELECT tenant_id FROM memories WHERE id = ?`).get(id) as { tenant_id?: string } | undefined;
  return row?.tenant_id;
}
