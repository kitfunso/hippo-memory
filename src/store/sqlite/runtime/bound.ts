// A group is one object of SQL bodies that take the handle first, bound to the store's handles here
// once, so no group method forwards to its body by hand. A body that writes the mirror files closes
// over them when its group is built.
import type { DatabaseSyncLike } from '../../../db/index.js';
import type { HandleOpener, OnHandle } from './open.js';
import { portError } from './port-errors.js';

// A void method's body returns nothing too: `void` alone would let a value through to callers the
// port promised none.
type BodyOf<M> = M extends (...args: infer A) => infer R
  ? (
      db: DatabaseSyncLike,
      ...args: A
    ) => [Awaited<R>] extends [void] ? void | undefined : Awaited<R>
  : never;

/** Group `G` as SQL bodies, each taking the handle before its method's own arguments. */
export type Bodies<G> = { readonly [K in keyof G]: BodyOf<G[K]> };

/** A SQL body: the handle, then its method's own arguments. */
type Body = (db: DatabaseSyncLike, ...args: never) => void;

type MethodOf<B> = B extends (db: DatabaseSyncLike, ...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never;

/** The group `bound` makes of `bodies`, typed by the bodies themselves, each one's doc kept. */
export type Bound<B> = { [K in keyof B]: MethodOf<B[K]> };

/** `bodies` as a group: each call runs its body to its end on a handle `open` makes, closed
 * after, so no write scope spans an await, then answers through a Promise that rejects in the
 * port's terms. */
export function bound<B extends { readonly [K in keyof B]: Body }>(
  on: OnHandle,
  bodies: B,
  open?: HandleOpener,
): Bound<B> {
  // Typed as Function so that apply can pass each body its own argument list.
  const methods = Object.entries<Function>(bodies).map(([key, body]) => {
    // Built here, not in a helper: an error stack keeps only 10 frames, and helper frames would
    // push the caller out.
    const method = (...args: never[]) => {
      try {
        return Promise.resolve(on((db) => body.apply(undefined, [db, ...args]), open));
      } catch (error) {
        return Promise.reject(portError(error));
      }
    };
    return [key, method];
  });
  // SAFETY: each entry pairs a body's key with that body run on a handle, its arguments after the
  // handle's, which is that key's method of Bound<B>.
  return Object.fromEntries(methods) as Bound<B>;
}

/** `run`'s value through a Promise, and its throw as a rejection in the port's terms, for a
 * method no body binds. */
export function answered<T>(run: () => T): Promise<T> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(portError(error));
  }
}

/** `method`, answered by `none` with no handle opened when its list is empty, so an empty batch
 * never creates the store. */
export function skipEmpty<L extends { readonly length: number }, Rest extends unknown[], R>(
  method: (list: L, ...rest: Rest) => Promise<R>,
  none: () => NoInfer<R>,
): (list: L, ...rest: Rest) => Promise<R> {
  return (list, ...rest) => (list.length === 0 ? Promise.resolve(none()) : method(list, ...rest));
}
