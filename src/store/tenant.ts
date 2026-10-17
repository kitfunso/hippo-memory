import { envTenant } from '../util/env.js';
import type { DatabaseSyncLike } from '../db/index.js';
import { validateApiKey } from './auth.js';

export interface ResolveOptions {
  db?: DatabaseSyncLike;
  apiKey?: string;
}

export function resolveTenantId(opts: ResolveOptions): string {
  if (opts.apiKey) {
    if (!opts.db) throw new Error('resolveTenantId: db required when apiKey is set');
    const ctx = validateApiKey(opts.db, opts.apiKey);
    if (!ctx.valid || !ctx.tenantId) throw new Error('invalid api key');
    return ctx.tenantId;
  }
  // Empty/whitespace-only HIPPO_TENANT must fall through to 'default': `??` only catches undefined, so '' leaked
  // through and broke every downstream tenant filter.
  return envTenant();
}
