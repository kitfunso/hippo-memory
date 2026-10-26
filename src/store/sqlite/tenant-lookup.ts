// Owner lookups by id: the tenant and scope checks in src/api and the CLI's key-tenant lookup share
// these queries.

import { type DatabaseSyncLike } from '../../db/index.js';
import type { ApiKeyOwner } from '../../base/ports/store/types.js';
import { cachedStatement } from '../../db/statement-cache.js';

/** The owner row of `keyId`, or undefined when no such key exists. */
export function readApiKeyOwner(db: DatabaseSyncLike, keyId: string): ApiKeyOwner | undefined {
  const row = cachedStatement(
    db,
    `SELECT tenant_id, revoked_at, role, owner_subject FROM api_keys WHERE key_id = ?`,
  ).get(keyId) as
    | { tenant_id: string; revoked_at: string | null; role: string; owner_subject: string | null }
    | undefined;
  return (
    row && {
      tenantId: row.tenant_id,
      revokedAt: row.revoked_at,
      role: row.role,
      ownerSubject: row.owner_subject,
    }
  );
}

/** Who may reach and change memory `id`: its tenant, scope and owner, or undefined when no such
 * memory exists. */
export function readMemoryReach(
  db: DatabaseSyncLike,
  id: string,
): { tenantId: string; scope: string | null; owner: string | null } | undefined {
  const row = cachedStatement(db, `SELECT tenant_id, scope, owner FROM memories WHERE id = ?`).get(
    id,
  ) as { tenant_id: string; scope: string | null; owner: string | null } | undefined;
  return row && { tenantId: row.tenant_id, scope: row.scope, owner: row.owner };
}
