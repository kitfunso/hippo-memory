import type { DatabaseSyncLike } from './db.js';
import { validateApiKey } from './auth.js';

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
  const t = process.env.HIPPO_TENANT?.trim();
  return t ? t : 'default';
}
