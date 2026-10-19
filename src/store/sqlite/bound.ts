// A group is one object of SQL bodies that take the handle first, bound to the store's handles here once, so no group
// method forwards to its body by hand.
import type { DatabaseSyncLike } from '../../db/index.js';
import type { Sync } from '../port.js';
import type { HandleOpener, OnHandle, OnHandleAsync, StoreFiles } from './open.js';

type BodyOf<M, Lead extends unknown[]> = M extends (...args: infer A) => infer R
  ? (...args: [...Lead, ...A]) => Awaited<R>
  : never;

type AsyncBodyOf<M, Lead extends unknown[]> = M extends (...args: infer A) => Promise<infer R>
  ? (...args: [...Lead, ...A]) => Promise<R>
  : never;

type Db = [db: DatabaseSyncLike];
type DbAndFiles = [db: DatabaseSyncLike, files: StoreFiles];

/** Group `G` as SQL bodies, each taking the handle before its method's own arguments. */
export type Bodies<G> = { readonly [K in keyof G]: BodyOf<G[K], Db> };

/** `Bodies` for methods whose bodies also write the mirror files beside hippo.db. */
export type FileBodies<G> = { readonly [K in keyof G]: BodyOf<G[K], DbAndFiles> };

/** `Bodies` for methods whose bodies yield to the event loop before they settle. */
export type AsyncBodies<G> = { readonly [K in keyof G]: AsyncBodyOf<G[K], Db> };

/** `AsyncBodies` whose bodies also write the mirror files. */
export type AsyncFileBodies<G> = { readonly [K in keyof G]: AsyncBodyOf<G[K], DbAndFiles> };

// The narrowest body both `on` and `onAsync` accept, so one loop binds either kind; each hands the result back as is.
type Runner = (fn: (db: DatabaseSyncLike, files: StoreFiles) => Promise<never>, open?: HandleOpener) => void;

type AnyBodies<G> = Bodies<G> | FileBodies<G> | AsyncBodies<G> | AsyncFileBodies<G>;

function bind<G, Out>(run: Runner, bodies: AnyBodies<G>, open: HandleOpener | undefined, withFiles: boolean): Out {
  const group: Partial<Out> = {};
  // SAFETY: Object.keys lists the own keys of the bodies, which are the keys of G and so of Out by the Bodies mapping.
  for (const key of Object.keys(bodies) as (keyof G & keyof Out)[]) {
    // Widened for apply: the lead arguments differ between the kinds of body.
    const body: Function = bodies[key];
    const method = (...args: never[]) =>
      run((db, files) => body.apply(undefined, withFiles ? [db, files, ...args] : [db, ...args]), open);
    // SAFETY: the body takes the handle (and the files) before the method's own arguments, so this call is G's method.
    group[key] = method as Out[typeof key];
  }
  // SAFETY: every key of the bodies was bound above, so the group holds all of Out.
  return group as Out;
}

/** `bodies` as group `G`: each call runs its body on a handle `open` makes, closed after. */
export function bound<G>(on: OnHandle, bodies: Bodies<G>, open?: HandleOpener): Sync<G> {
  return bind<G, Sync<G>>(on, bodies, open, false);
}

/** `bound` for bodies that also take the mirror files. */
export function boundWithFiles<G>(on: OnHandle, bodies: FileBodies<G>, open?: HandleOpener): Sync<G> {
  return bind<G, Sync<G>>(on, bodies, open, true);
}

/** `bound` for bodies that yield: each call keeps its handle open until the body's Promise settles. */
export function boundAsync<G>(onAsync: OnHandleAsync, bodies: AsyncBodies<G>, open?: HandleOpener): G {
  return bind<G, G>(onAsync, bodies, open, false);
}

/** `boundAsync` for bodies that also take the mirror files. */
export function boundAsyncWithFiles<G>(onAsync: OnHandleAsync, bodies: AsyncFileBodies<G>, open?: HandleOpener): G {
  return bind<G, G>(onAsync, bodies, open, true);
}

/** `method`, answered by `none` with no handle opened when its list is empty, so an empty batch never creates the
 * store. */
export function skipEmpty<L extends { readonly length: number }, Rest extends unknown[], R>(
  method: (list: L, ...rest: Rest) => R,
  none: () => R,
): (list: L, ...rest: Rest) => R {
  return (list, ...rest) => (list.length === 0 ? none() : method(list, ...rest));
}
