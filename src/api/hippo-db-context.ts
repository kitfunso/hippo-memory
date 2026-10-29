// The context a local feature's api module takes: hippo.db's local tier beside the core store.
// Only a surface that proved the tier at composition builds one, so no core path reaches it.
import type { HippoDbRepos } from '../store/sqlite/hippo-db.js';
import type { Context } from './types.js';

export interface HippoDbContext extends Context {
  /** hippo.db's local repositories, bound to the same request as `store`. */
  readonly hippoDb: HippoDbRepos;
}

/** Whether `store` carries hippo.db's local tier; a surface asks once, as it binds a local route
 * or tool. */
export function hasHippoDb<S extends Context['store']>(
  store: S,
): store is S & Pick<HippoDbContext, 'hippoDb'> {
  return 'hippoDb' in store;
}
