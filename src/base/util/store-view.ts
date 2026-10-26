import type { HippoStore } from '../ports/store.js';

// A request's view of a store is a new object, so a note kept once per store keys on the store the view reads.
const viewed = new WeakMap<HippoStore, HippoStore>();

/** `view`, recorded as one request's view of `store`. */
export function asViewOf<V extends HippoStore>(view: V, store: HippoStore): V {
  if (view !== store) viewed.set(view, storeBehind(store));
  return view;
}

/** The store `store` is a request's view of; `store` itself when it is no view. */
export function storeBehind(store: HippoStore): HippoStore {
  return viewed.get(store) ?? store;
}
