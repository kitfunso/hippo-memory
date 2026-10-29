// Each /v1 row bound to the store boot proved: a row whose store lacks what it needs is marked
// 501 once here, so no request checks a group or the local tier.
import { CONNECTOR_GROUPS } from '../connectors/ingest.js';
import {
  hasGroup,
  hasGroups,
  type HippoStore,
  type OptionalGroup,
  type StoreWith,
} from '../../base/ports/store.js';
import { HttpError, STORE_NOT_PORTED_MESSAGE } from '../../base/errors/http-errors.js';
import { hasHippoDb } from '../../api/hippo-db-context.js';
import { closeIfBodyUnread } from '../http/http-util.js';
import type {
  AuthedRouteRequest,
  BoundRoute,
  GroupRequest,
  GroupRouteOf,
  HippoDbRequest,
  HippoDbRoute,
  PathEndpoint,
  Route,
  RouteRequest,
  WebhookRoute,
} from './types.js';

/** The one 501 of a route whose store lacks what it needs, thrown by the gate before the role
 * check. */
export async function notPorted(): Promise<void> {
  throw new HttpError(501, STORE_NOT_PORTED_MESSAGE);
}

/** A row whose store lacks what it needs is marked at boot, so its gate answers 501 and no
 * request checks a group. */
export function boundRoute(route: Route, store: HippoStore): BoundRoute {
  if (route.auth === 'webhook-signature') return boundWebhook(route, store);
  if (route.storeReady !== undefined) return boundGroupRoute(route, store);
  if (route.hippoDb === true) return boundHippoDbRoute(route, store);
  return route;
}

/** A group row's handler gets the request's context on the store boot proved, bound to the
 * request's session and deadline; without the group it answers 501. */
function boundGroupRoute<G extends OptionalGroup>(
  route: GroupRouteOf<G>,
  store: HippoStore,
): BoundRoute {
  const { method, auth } = route;
  if (!hasGroup(store, route.storeReady)) {
    return { method, auth, ...endpointOf(route), unported: true, handler: notPorted };
  }
  const proved: StoreWith<G> = store;
  return boundOn(route, (r): GroupRequest<G> => ({
    ...r,
    ctx: { ...r.ctx, store: r.opts.storeFor(proved) },
  }));
}

/** A local row's handler gets the request's context on the store with hippo.db's local tier,
 * bound to the request's session and deadline; on a store without the tier it answers 501. */
function boundHippoDbRoute(route: HippoDbRoute, store: HippoStore): BoundRoute {
  const { method, auth } = route;
  if (!hasHippoDb(store)) {
    return { method, auth, ...endpointOf(route), unported: true, handler: notPorted };
  }
  return boundOn(route, (r): HippoDbRequest => ({
    ...r,
    ctx: { ...r.ctx, store: r.opts.storeFor(store) },
  }));
}

/** `route` with its handler run on the request `toRequest` makes of the gate's. */
function boundOn<R>(
  route: {
    method: string;
    auth: Exclude<BoundRoute['auth'], 'webhook-signature'>;
  } & PathEndpoint<R>,
  toRequest: (r: AuthedRouteRequest) => R,
): BoundRoute {
  const { method, auth } = route;
  if ('path' in route) {
    const { path, handler } = route;
    return { method, auth, path, handler: (r: AuthedRouteRequest) => handler(toRequest(r)) };
  }
  const { pattern, handler } = route;
  return { method, auth, pattern, handler: (r, params) => handler(toRequest(r), params) };
}

/** A webhook is handed the connector store; it skips the gate, so without the groups its handler
 * is the 501 itself. */
function boundWebhook(route: WebhookRoute, store: HippoStore): BoundRoute {
  const { method, auth } = route;
  if (!hasGroups(store, CONNECTOR_GROUPS)) {
    return { method, auth, ...endpointOf(route), handler: webhookNotPorted };
  }
  if ('path' in route) {
    const { path, handler } = route;
    return {
      method,
      auth,
      path,
      handler: (r: RouteRequest) => handler({ ...r, store: r.opts.storeFor(store) }),
    };
  }
  const { pattern, handler } = route;
  return {
    method,
    auth,
    pattern,
    handler: (r, params) => handler({ ...r, store: r.opts.storeFor(store) }, params),
  };
}

/** A webhook's 501 drops the body it never reads, as its 404 and 401 do, so no caller holds the
 * socket open. */
async function webhookNotPorted(request: RouteRequest): Promise<void> {
  closeIfBodyUnread(request);
  await notPorted();
}

/** The row's path or pattern alone, for a row whose handler is replaced. */
function endpointOf(route: PathEndpoint<never>): { path: string } | { pattern: string } {
  return 'path' in route ? { path: route.path } : { pattern: route.pattern };
}
