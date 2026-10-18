// The ./testing kit's tenant resolver: a benchmark that opens hippo.db itself names its tenant as the server root does.
import { envTenant } from '../util/env.js';
import { tenantOfApiKey, type ResolveOptions } from '../store/sqlite/tenant.js';

/** The tenant `opts.apiKey` names, else HIPPO_TENANT's (the default tenant when unset or blank). */
export function resolveTenantId(opts: ResolveOptions): string {
  return opts.apiKey ? tenantOfApiKey({ ...opts, apiKey: opts.apiKey }) : envTenant();
}
