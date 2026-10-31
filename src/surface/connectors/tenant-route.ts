// The tenant a webhook lands in, by one rule for every connector: its routing rows, else the host's
// on an install that registered none.
import type { ConnectorStore } from './ingest.js';
import type { RouteQuery } from '../../base/records/connectors.js';

/** The host's tenant, which the root resolved, and the root's allow-unknown escape for the
 * connector. */
export interface RouteFallback {
  readonly hostTenant: string;
  readonly allowUnknown: boolean;
}

/** The tenant the routing rows name; with no match, the host's when no row could have matched (a
 * single-tenant install) or `allowUnknown` escapes, else null (fail closed). */
export async function resolveTenant(
  store: ConnectorStore,
  query: RouteQuery,
  { hostTenant, allowUnknown }: RouteFallback,
): Promise<string | null> {
  const route = await store.hippoDb.connectorEvents.route(query);
  if (route.tenantId !== null) return route.tenantId;
  return route.routes === 0 || allowUnknown ? hostTenant : null;
}
