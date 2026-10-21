// The tenant clause of a hippo.db read, and the tenant an API key names.
import type { DatabaseSyncLike } from '../../db/index.js';
import { ALL_TENANTS, type TenantId } from '../../base/util/tenant.js';
import { validateApiKey } from './auth.js';
import type { SqlFragment } from '../../db/sql.js';

/** ` AND <condition>` and its argument for one tenant; both empty for ALL_TENANTS. */
export function tenantAnd(tenantId: TenantId, condition: string = 'tenant_id = ?'): SqlFragment {
  return tenantId === ALL_TENANTS ? { sql: '', params: [] } : { sql: ` AND ${condition}`, params: [tenantId] };
}

export interface ResolveOptions {
  db?: DatabaseSyncLike;
  apiKey?: string;
}

/** The tenant `opts.apiKey` names; throws when the key is invalid or no handle is given to check it on. */
export function tenantOfApiKey(opts: ResolveOptions & { apiKey: string }): string {
  if (!opts.db) throw new Error('resolveTenantId: db required when apiKey is set');
  const ctx = validateApiKey(opts.db, opts.apiKey);
  if (!ctx.valid || !ctx.tenantId) throw new Error('invalid api key');
  return ctx.tenantId;
}
