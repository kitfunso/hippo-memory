import type { StoreRules } from '../../../base/ports/infra.js';
import type { DbGrant, RequestStores } from '../../../db/index.js';
import { mintDbGrant } from '../../../db/grant.js';
import type { StoreRuntime } from '../../../db/store-runtime.js';

/** How a store opens hippo.db, beside the rules it scores by. */
export interface SqliteStoreOptions extends StoreRules {
  readonly runtime?: StoreRuntime | undefined;
  readonly session?: RequestStores | undefined;
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
