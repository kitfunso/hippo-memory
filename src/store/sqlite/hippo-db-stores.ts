// Which stores are hippo.db. The mark is an own enumerable symbol, so a caller's copy that spreads sqliteStore and
// swaps a method stays hippo.db, as it did when the copy carried localFiles.
import type { HippoStore } from '../port.js';

/** Kept off the store's type, so the published store shape is unchanged. */
const HIPPO_DB_MARK: unique symbol = Symbol('hippo.db');

/** `store`, marked as hippo.db's own. */
export function asHippoDb<S extends object>(store: S): S {
  return Object.defineProperty(store, HIPPO_DB_MARK, { value: true, enumerable: true });
}

/** True when `sqliteStore` or `workerSqliteStore` built `store`, or a copy spread from one: a call on it may open
 * hippo.db by its folder. */
export function isHippoDbStore(store: HippoStore): boolean {
  return HIPPO_DB_MARK in store;
}
