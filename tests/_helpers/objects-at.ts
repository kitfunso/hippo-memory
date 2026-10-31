import type { Objects } from '../../src/base/records/objects.js';
import type { RequestStores } from '../../src/db/request-stores.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';

/** The typed-object group of the store on hippo.db under `hippoRoot`, as the CLI's edge builds it; a seed loop passes
 * a session so its writes share one handle. */
export function objectsAt(hippoRoot: string, session?: RequestStores): Objects {
  return sqliteStore(hippoRoot, { session }).hippoDb.objects;
}
