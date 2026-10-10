import { envTenant } from '../util/env.js';
import type { DatabaseSyncLike } from '../db/index.js';
import { validateApiKey } from './auth.js';
import type { JsonValue } from '../util/json.js';

export interface ResolveOpts {
  db?: DatabaseSyncLike;
  apiKey?: string;
}

export function resolveTenantId(opts: ResolveOpts): string {
  if (opts.apiKey) {
    if (!opts.db) throw new Error('resolveTenantId: db required when apiKey is set');
    const ctx = validateApiKey(opts.db, opts.apiKey);
    if (!ctx.valid || !ctx.tenantId) throw new Error('invalid api key');
    return ctx.tenantId;
  }
  // Empty/whitespace-only HIPPO_TENANT must fall through to 'default': `??` only catches undefined, so '' leaked through and broke every downstream tenant
  // filter.
  return envTenant();
}

/** Runtime guard for tenant id args: an older JS caller can pass a `sessionId` as the tenant (`loadLatestHandoff(root, 'sess-abc')`) and silently get null.
 * Rejects values starting `sess-` / `sess_`; a tenant literally named `sess-...` is refused, an accepted tradeoff. */
export function assertTenantId(fnName: string, value: JsonValue): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fnName}: tenantId is required (got ${typeof value})`);
  }
  if (/^sess[-_]/i.test(value)) {
    throw new Error(
      `${fnName}: tenantId looks like a session id ('${value}'). ` +
      `In v0.41+ these helpers take (hippoRoot, tenantId, ...). ` +
      `Pass the tenant id (e.g. 'default') and the session id separately.`,
    );
  }
}
