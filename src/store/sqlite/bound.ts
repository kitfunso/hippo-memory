// A group is one object of SQL bodies that take the handle first, bound to the store's handles here once, so no group
// method forwards to its body by hand. A body that writes the mirror files closes over them when its group is built.
import type { DatabaseSyncLike } from '../../db/index.js';
import type { HandleOpener, OnHandle } from './open.js';
import { portError } from './port-errors.js';

// A void method's body returns nothing too: `void` alone would let a value through to callers the port promised none.
type BodyOf<M> = M extends (...args: infer A) => infer R
  ? (db: DatabaseSyncLike, ...args: A) => [Awaited<R>] extends [void] ? void | undefined : Awaited<R>
  : never;

/** Group `G` as SQL bodies, each taking the handle before its method's own arguments. */
export type Bodies<G> = { readonly [K in keyof G]: BodyOf<G[K]> };

/** `bodies` as group `G`: each call runs its body to its end on a handle `open` makes, closed after, so no write scope
 * spans an await, then answers through a Promise that rejects in the port's terms. */
export function bound<G>(on: OnHandle, bodies: Bodies<G>, open?: HandleOpener): G {
  const group: Partial<G> = {};
  // SAFETY: Object.keys lists the own keys of the bodies, which are the keys of G by the Bodies mapping.
  for (const key of Object.keys(bodies) as (keyof G)[]) {
    // Widened for apply: each body has its own argument list.
    const body: Function = bodies[key];
    // Inline, as a helper's frames would push the caller out of a stack's ten.
    const method = (...args: never[]) => {
      try {
        return Promise.resolve(on((db) => body.apply(undefined, [db, ...args]), open));
      } catch (error) {
        return Promise.reject(portError(error));
      }
    };
    // SAFETY: the body takes the handle before the method's own arguments, so this call is G's method.
    group[key] = method as G[typeof key];
  }
  // SAFETY: every key of the bodies was bound above, so the group holds all of G.
  return group as G;
}

/** `run`'s value through a Promise, and its throw as a rejection in the port's terms, for a method no body binds. */
export function answered<T>(run: () => T): Promise<T> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(portError(error));
  }
}

/** `method`, answered by `none` with no handle opened when its list is empty, so an empty batch never creates the
 * store. */
export function skipEmpty<L extends { readonly length: number }, Rest extends unknown[], R>(
  method: (list: L, ...rest: Rest) => Promise<R>,
  none: () => NoInfer<R>,
): (list: L, ...rest: Rest) => Promise<R> {
  return (list, ...rest) => (list.length === 0 ? Promise.resolve(none()) : method(list, ...rest));
}
