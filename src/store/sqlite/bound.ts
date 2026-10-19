// A group is one object of SQL bodies that take the handle first, bound to the store's handles here once, so no group
// method forwards to its body by hand.
import type { DatabaseSyncLike } from '../../db/index.js';
import type { Sync } from '../port.js';
import type { HandleOpener, OnHandle, StoreFiles } from './open.js';

type BodyOf<M, Lead extends unknown[]> = M extends (...args: infer A) => infer R
  ? (...args: [...Lead, ...A]) => Awaited<R>
  : never;

/** Group `G` as SQL bodies, each taking the handle before its method's own arguments. */
export type Bodies<G> = { readonly [K in keyof G]: BodyOf<G[K], [db: DatabaseSyncLike]> };

/** `Bodies` for methods whose bodies also write the mirror files beside hippo.db. */
export type FileBodies<G> = { readonly [K in keyof G]: BodyOf<G[K], [db: DatabaseSyncLike, files: StoreFiles]> };

function bind<G>(
  on: OnHandle,
  bodies: Bodies<G> | FileBodies<G>,
  open: HandleOpener | undefined,
  withFiles: boolean,
): Sync<G> {
  const group: Partial<Sync<G>> = {};
  // SAFETY: Object.keys lists the own keys of the bodies, which are the keys of G by the Bodies mapping.
  for (const key of Object.keys(bodies) as (keyof G & keyof Sync<G>)[]) {
    // Widened for apply: the lead arguments differ between the two kinds of body.
    const body: Function = bodies[key];
    const method = (...args: never[]) =>
      on((db, files) => body.apply(undefined, withFiles ? [db, files, ...args] : [db, ...args]), open);
    // SAFETY: the body takes the handle (and the files) before the method's own arguments, so this call is G's method.
    group[key] = method as Sync<G>[typeof key];
  }
  // SAFETY: every key of the bodies was bound above, so the group holds all of G.
  return group as Sync<G>;
}

/** `bodies` as group `G`: each call runs its body on a handle `open` makes, closed after. */
export function bound<G>(on: OnHandle, bodies: Bodies<G>, open?: HandleOpener): Sync<G> {
  return bind<G>(on, bodies, open, false);
}

/** `bound` for bodies that also take the mirror files. */
export function boundWithFiles<G>(on: OnHandle, bodies: FileBodies<G>, open?: HandleOpener): Sync<G> {
  return bind<G>(on, bodies, open, true);
}
