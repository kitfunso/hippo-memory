import type { JsonValue } from '../util/json.js';

/** Runtime guard for tenant id args: an older JS caller can pass a `sessionId` as the tenant (`loadLatestHandoff(root,
 * 'sess-abc')`) and silently get null. Rejects values starting `sess-` / `sess_`; a tenant literally named `sess-...`
 * is refused, an accepted tradeoff. */
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
