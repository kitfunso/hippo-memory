import { existsSync } from 'node:fs';
import {
  closeHippoDb,
  type DatabaseSyncLike,
  getHippoDbPath,
  SERVER_DB_WAIT_MS,
} from '../../../db/index.js';
import type { HippoStore } from '../../../base/ports/store.js';
import { isHippoDbStore } from './hippo-db-stores.js';
import { startWalCheckpointer, type WalCheckpointer } from '../../../db/wal-checkpointer.js';
import type { StoreRuntime } from '../../../db/store-runtime.js';
import { errorMessage, log, errorFields } from '../../../base/util/log.js';
import { grantFor } from './grant.js';

/** What the server calls around its responses to keep its store connection. */
export interface StoreHolder {
  hold: () => void;
  afterResponse: () => void;
  release: () => Promise<void>;
}

function holdSqliteConnection(hippoRoot: string, runtime: StoreRuntime): StoreHolder {
  let heldDb: DatabaseSyncLike | undefined;
  let checkpointer: WalCheckpointer | undefined;
  let stopHolding = false;
  const hold = (): void => {
    if (heldDb || stopHolding || !existsSync(getHippoDbPath(hippoRoot))) return;
    try {
      heldDb = grantFor({ runtime }).open(hippoRoot, SERVER_DB_WAIT_MS);
      checkpointer = startWalCheckpointer(getHippoDbPath(hippoRoot), runtime);
    } catch (err) {
      stopHolding = true;
      log.warn(
        `serve: could not hold a store connection; requests still work, only slower: ${errorMessage(err)}`,
        errorFields(err),
      );
    }
  };
  const afterResponse = (): void => {
    hold();
    checkpointer?.noteResponse();
  };
  const release = async (): Promise<void> => {
    stopHolding = true;
    await checkpointer?.stop();
    if (heldDb) closeHippoDb(heldDb);
    heldDb = undefined;
  };
  return { hold, afterResponse, release };
}

const NOTHING_HELD: StoreHolder = {
  hold: () => {},
  afterResponse: () => {},
  release: async () => {},
};

/** The holder for the store a server serves: hippo.db's held connection, else nothing to hold. */
export function createStoreHolder(
  hippoRoot: string,
  store: HippoStore,
  runtime: StoreRuntime,
): StoreHolder {
  if (isHippoDbStore(store)) return holdSqliteConnection(hippoRoot, runtime);
  log.info(
    `serve: the '${store.kind}' store serves ${hippoRoot}, so no hippo.db connection is held`,
  );
  return NOTHING_HELD;
}
