// The one place a hippo.db grant is made. Code above the adapter cannot import src/db
// (layers.json), so only a store built here opens hippo.db with a runtime, a request's session or a
// worker-thread fence.
import type { StoreRules } from '../../../base/ports/infra.js';
import type { DbGrant, RequestStores } from '../../../db/index.js';
import { mintDbGrant } from '../../../db/grant.js';
import type { StoreRuntime } from '../../../db/store-runtime.js';

/** How a store opens hippo.db, beside the rules it scores by. */
export interface SqliteStoreOptions extends StoreRules {
  /** The root's runtime, shared by every store it builds: proven schemas, idle handles and held
   * file writes. */
  readonly runtime?: StoreRuntime | undefined;
  /** One request's handles, so each store the request reaches opens once; its runtime wins over
   * `runtime`. */
  readonly session?: RequestStores | undefined;
  /** Lock wait of each open that names none, such as a server thread's, which must not stall the
   * event loop. */
  readonly busyWaitMs?: number | undefined;
}

/** The adapter's own options: a worker store's server-thread part refuses every open it would
 * make. */
export interface HandleOptions extends SqliteStoreOptions {
  readonly workerOnly?: boolean;
}

export function grantFor({ runtime, session, workerOnly }: HandleOptions): DbGrant {
  return mintDbGrant({
    runtime: session?.runtime ?? runtime,
    session,
    workerOnly: workerOnly === true,
  });
}
