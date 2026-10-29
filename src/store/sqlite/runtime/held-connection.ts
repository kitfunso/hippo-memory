// A served hippo.db keeps one connection open for the life of the server, beside the worker that
// checkpoints its WAL.
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

/** Holds a connection to the hippo.db under `hippoRoot` once it exists, so serving never creates
 * one. */
function holdSqliteConnection(hippoRoot: string, runtime: StoreRuntime): StoreHolder {
  // Handlers open and close their own connections; while this one is held, none of those closes is
  // SQLite's last, which checkpoints and deletes the WAL.
  let heldDb: DatabaseSyncLike | undefined;
  let checkpointer: WalCheckpointer | undefined;
  let stopHolding = false;
  const hold = (): void => {
    if (heldDb || stopHolding || !existsSync(getHippoDbPath(hippoRoot))) return;
    try {
      // The server's lock wait: this open runs on the event loop, where SQLite's 5 s default and
      // the 30 s journal-mode retry would stall every request.
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
    // The worker's connection closes first, so the held one is SQLite's last and its close
    // checkpoints and deletes the WAL.
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
