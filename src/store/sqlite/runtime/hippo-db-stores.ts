import type { HippoStore } from '../../../base/ports/store.js';

const HIPPO_DB_MARK: unique symbol = Symbol('hippo.db');

/** `store`, marked as hippo.db's own. */
export function asHippoDb<S extends object>(store: S): S {
  return Object.defineProperty(store, HIPPO_DB_MARK, { value: true, enumerable: true });
}

/** True when `sqliteStore` or `workerSqliteStore` built `store`, or a copy spread from one: a
 * call on it may open hippo.db by its folder. */
export function isHippoDbStore(store: HippoStore): boolean {
  return HIPPO_DB_MARK in store;
}
