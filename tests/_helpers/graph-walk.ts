// A hippo.db store as the graph walks take it: its rows by id, and the graph its local tier keeps.
import type { HippoDbStore } from '../../src/base/ports/hippo-db.js';

export function walkable<S extends HippoDbStore>(store: S): S & { readonly graphReads: S['hippoDb']['graphReads'] } {
  return { ...store, graphReads: store.hippoDb.graphReads };
}
