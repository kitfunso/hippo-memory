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
  return process.env.HIPPO_TENANT ?? 'default';
}
