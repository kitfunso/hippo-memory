import { routeLabel, V1_ROUTES } from '../../src/surface/server/route-table.js';

/** Every live V1_ROUTES row as `METHOD label` (a pattern row reads without its param types), in dispatch order. */
export const V1_ROWS = V1_ROUTES.map((route) => ({ key: `${route.method} ${routeLabel(route)}`, route }));

/** A row key under one of the seven typed-object kinds' paths. */
export const OBJECT_ROW =
  /^\S+ \/v1\/(decisions|incidents|processes|policies|skills|project-briefs|customer-notes)(\/|$)/;

/** The rows on hippo.db's local tier, and the webhooks, whose connector writes live there: each answers 501 on a store
 * without the tier. */
const TIER_ROWS = V1_ROWS.filter(({ route }) => route.hippoDb === true || route.auth === 'webhook-signature').map(
  ({ route }) => ({ method: route.method, path: new RegExp(`^${routeLabel(route).replace(/:\w+/g, '[^/]+')}$`) }),
);

/** Whether `method path` reaches a route on hippo.db's local tier; a `:name` segment or an id in `path` matches any
 * id, and a query is ignored. */
export function onLocalTier(method: string, path: string): boolean {
  const bare = path.split('?')[0] ?? path;
  return TIER_ROWS.some((row) => row.method === method && row.path.test(bare));
}
