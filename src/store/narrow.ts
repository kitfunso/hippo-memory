import { StoreNotPortedError } from '../util/sqlite-blocked.js';
import { hasGroup, type HippoStore, type StoreGroup, type StoreGroups } from './port.js';

/** A store a gate proved holds `G`, so a handler reads `store.<group>` with no run-time check. */
export type StoreWith<G extends StoreGroup> = HippoStore & Pick<StoreGroups, Exclude<G, 'base'>>;

/** The one run-time check behind a `StoreWith`: throws StoreNotPortedError for the first missing group. */
export function narrowStore<G extends StoreGroup>(store: HippoStore, ...groups: readonly [G, ...G[]]): StoreWith<G> {
  for (const group of groups) if (!hasGroup(store, group)) throw new StoreNotPortedError(store.kind, group);
  // SAFETY: the loop above proved every group.
  return store as StoreWith<G>;
}
