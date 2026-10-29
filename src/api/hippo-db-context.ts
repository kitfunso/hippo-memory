// The context a local feature's api module takes: a store that carries hippo.db's local tier.
// Only a surface that proved the tier at composition builds one, so no core path reaches it.
import type { HippoDbTier } from '../store/sqlite/hippo-db.js';
import type { Context } from './types.js';

export type { HippoDbStore, HippoDbTier } from '../store/sqlite/hippo-db.js';

export interface HippoDbContext extends Context {
  /** The store with the tier on it, so the one rebind a request makes of `store` binds both. */
  readonly store: Context['store'] & HippoDbTier;
}

/** Whether `store` carries hippo.db's local tier; a surface asks once, as it binds a local route
 * or tool. */
export function hasHippoDb<S extends Context['store']>(store: S): store is S & HippoDbTier {
  // An unset tier counts as absent, as hasGroup counts an unset group.
  return 'hippoDb' in store && store.hippoDb !== undefined;
}
