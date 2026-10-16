// A served hippo.db keeps one connection open for the life of the server, beside the worker that checkpoints its WAL.
import { existsSync } from 'node:fs';
import {
  closeHippoDb,
  type DatabaseSyncLike,
  getHippoDbPath,
  openHippoDb,
  outsideRequestStores,
  outsideSqliteOffLoop,
  SERVER_DB_WAIT_MS,
  withSqliteBlocked,
  withSqliteOffLoop,
} from '../../db/index.js';
import { hasGroup, type HippoStore } from '../port.js';
import { runSqliteRequest } from './request-scope.js';
import { runsOffLoop } from './worker-store.js';
import { startWalCheckpointer, type WalCheckpointer } from '../../db/wal-checkpointer.js';
import { errorMessage, log, errorFields } from '../../util/log.js';

/** What the server calls around its responses to keep its store connection. */
export interface StoreHolder {
  hold: () => void;
  afterResponse: () => void;
  release: () => Promise<void>;
  /** Runs one request in the server's scope, inside the fence that keeps hippo.db shut when the store is not it. */
  runRequest: (run: () => Promise<void>) => Promise<void>;
}

/** Holds a connection to the hippo.db under `hippoRoot` once it exists, so serving never creates one. */
export function holdSqliteConnection(hippoRoot: string): StoreHolder {
  // Handlers open and close their own connections; while this one is held, none of those closes is SQLite's last,
  // which checkpoints and deletes the WAL.
  let heldDb: DatabaseSyncLike | undefined;
  let checkpointer: WalCheckpointer | undefined;
  let stopHolding = false;
  const hold = (): void => {
    if (heldDb || stopHolding || !existsSync(getHippoDbPath(hippoRoot))) return;
    try {
      // The 'finish' listener can fire inside a request scope (closing this connection with the request) and inside a
      // `loop: 'off'` block (refusing the open). The server's lock wait: this open runs on the event loop, where
      // SQLite's 5 s default and the 30 s journal-mode retry would stall every request.
      heldDb = outsideSqliteOffLoop(() =>
        outsideRequestStores(() => openHippoDb(hippoRoot, { busyWaitMs: SERVER_DB_WAIT_MS })),
      );
      checkpointer = startWalCheckpointer(getHippoDbPath(hippoRoot));
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
    // The worker's connection closes first, so the held one is SQLite's last and its close checkpoints and deletes the
    // WAL.
    await checkpointer?.stop();
    if (heldDb) closeHippoDb(heldDb);
    heldDb = undefined;
  };
  return { hold, afterResponse, release, runRequest: (run) => runSqliteRequest(run, 'server') };
}

/** The holder for the store a server serves: hippo.db's held connection, else a fence that keeps hippo.db shut. */
export function createStoreHolder(hippoRoot: string, store: HippoStore): StoreHolder {
  if (hasGroup(store, 'localFiles')) return holdSqliteConnection(hippoRoot);
  log.info(`serve: the '${store.kind}' store serves ${hippoRoot}, so no hippo.db connection is held`);
  // A missed port under another store would otherwise create and write a hippo.db that store never reads.
  return {
    hold: () => {},
    afterResponse: () => {},
    release: async () => {},
    runRequest: (run) => runSqliteRequest(() => withSqliteBlocked(store.kind, run), 'server'),
  };
}

/** Runs a route's store work off the event loop when the store has a worker, else in place. */
export function offLoopFor(store: HippoStore): <T>(run: () => T) => T {
  return runsOffLoop(store) ? withSqliteOffLoop : (run) => run();
}

// A plugin's resolver may read hippo.db through this package's synchronous functions, so it runs outside the block of a
// `loop: 'off'` route.
export function outsideRouteBlock<A extends readonly unknown[], R>(
  resolver: ((...args: A) => R) | undefined,
): ((...args: A) => R) | undefined {
  return resolver && ((...args) => outsideSqliteOffLoop(() => resolver(...args)));
}
