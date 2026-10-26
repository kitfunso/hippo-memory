// The rows a kind of record serves under its collection path, built from one spec so the route table names each kind
// once: create, list, the kind's literal sub-paths, its POST actions on one id, then the id read.
import type { GroupRequest, Route, RouteParams } from '../types.js';

/** A request on a store boot proved holds objects, as every kind's row needs. */
export type ObjectRequest = GroupRequest<'objects'>;

export type KindHandler = (rr: ObjectRequest) => Promise<void>;

/** A handler for one row of the kind, given the id its path carries. */
export type IdHandler = (rr: ObjectRequest, id: number) => Promise<void>;

/** A literal sub-path such as `asof`; listed before the id rows, though `:id(int)` would never take a word anyway. */
export interface NamedRoute {
  readonly method: 'GET' | 'POST';
  readonly sub: string;
  readonly handler: KindHandler;
}

export interface KindRoutes {
  /** The collection path, such as `/v1/policies`. */
  readonly base: string;
  readonly create: KindHandler;
  readonly list: KindHandler;
  readonly named?: readonly NamedRoute[];
  /** `POST <base>/:id/<action>`, in this order. */
  readonly actions: Readonly<Record<string, IdHandler>>;
  readonly get: IdHandler;
}

const ID = ':id(int)';

function byId(handler: IdHandler): (rr: ObjectRequest, params: RouteParams) => Promise<void> {
  return (rr, { id }) => handler(rr, Number.parseInt(id, 10));
}

/** Every row of one kind, each gated as any caller's and on a store with objects. */
export function kindRows(kind: KindRoutes): Route[] {
  const { base } = kind;
  return [
    { method: 'POST', path: base, auth: 'caller', storeReady: 'objects', handler: kind.create },
    { method: 'GET', path: base, auth: 'caller', storeReady: 'objects', handler: kind.list },
    ...(kind.named ?? []).map(({ method, sub, handler }): Route => {
      return { method, path: `${base}/${sub}`, auth: 'caller', storeReady: 'objects', handler };
    }),
    ...Object.entries(kind.actions).map(([action, handler]): Route => {
      return {
        method: 'POST',
        pattern: `${base}/${ID}/${action}`,
        auth: 'caller',
        storeReady: 'objects',
        handler: byId(handler),
      };
    }),
    { method: 'GET', pattern: `${base}/${ID}`, auth: 'caller', storeReady: 'objects', handler: byId(kind.get) },
  ];
}
