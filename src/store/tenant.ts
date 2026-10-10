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
  // L1: empty / whitespace-only HIPPO_TENANT must fall through to 'default'.
  // `??` only catches undefined, so HIPPO_TENANT="" leaked through as the
  // literal empty string and broke every downstream tenant filter.
  return envTenant();
}

/**
 * Defensive runtime guard for tenant id arguments.
 *
 * The continuity helpers (saveActiveTaskSnapshot, listSessionEvents, etc.)
 * gained a required `tenantId` parameter (schema v22) to close a
 * cross-tenant data leak. TypeScript catches misbinding at compile time, but
 * JavaScript callers from older versions can silently pass a `sessionId`
 * where `tenantId` is now expected, e.g.
 *   loadLatestHandoff(root, 'sess-abc')   // WRONG: 'sess-abc' becomes the tenant
 * which would silently filter to a non-existent tenant and return null with
 * no error. This guard rejects the most common shape of that mistake (any
 * value beginning with the conventional `sess-` / `sess_` session prefix).
 *
 * False-positive cost: a tenant literally named `sess-...` will be rejected.
 * Acceptable tradeoff for catching the silent-leak class.
 */
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
