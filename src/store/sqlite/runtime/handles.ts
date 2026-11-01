// Opens hippo.db by its folder. Only the SQLite adapter holds a folder; every layer above takes the
// store it is given.

import { closeHippoDb, type DatabaseSyncLike } from '../../../db/index.js';
import { reproveStoreSchema } from '../../../db/connect.js';
import { errorFields, errorMessage, log } from '../../../base/util/log.js';
import { ensureMirrorDirectories, syncMirrorFiles } from '../folder-files/mirrors.js';
import { recoverDueMirrors } from '../folder-files/due-mirrors.js';
import {
  bootstrapLegacyStore,
  type GrantedOpens,
  type HandleOpener,
  type Handles,
  holdsMemory,
  readWrite,
  recordHalfLifeBaseForNewStore,
  type StoreFiles,
} from './open.js';
import { PRODUCTION_STRENGTH, withLossAversion } from '../../../base/memory/strength.js';
import { hostClock } from '../../../host/clock.js';
import { bindHandleClock } from './handle-clock.js';
import { createHost } from '../../../host/host.js';
import { grantFor, type HandleOptions, type SqliteStoreOptions } from './grant.js';

/** Creates the store, or finishes one partly made; `opts` is what the store that asks
 * opens with. */
export function initStore(hippoRoot: string, opts: SqliteStoreOptions = {}): void {
  const grant = grantFor(opts);
  reproveStoreSchema({ hippoRoot, runtime: grant.runtime });
  closeHippoDb(openStore(hippoRoot, { grant, busyWaitMs: opts.busyWaitMs }));
}

/** One open connection with init done on it, for callers who used to pay for `initStore` + a
 * second `openHippoDb`. */
export function openStore(
  hippoRoot: string,
  { grant, busyWaitMs }: GrantedOpens,
): DatabaseSyncLike {
  // Open first: a folder marked for another store must refuse before any mirror folder appears.
  const { db, facts, reused } = grant.openWithFacts(hippoRoot, busyWaitMs);
  const session = grant.session;
  // A store worker's reader: its writer ran the steps below before this thread was sent a job, and
  // this connection cannot write them.
  if (session?.setupDoneFor === hippoRoot) return db;
  const at = { hippoRoot, runtime: grant.runtime };
  try {
    ensureMirrorDirectories(at);
    if (!reused) recoverDueMirrors(at, db, facts?.mirrorsDue);
    // Both steps act only on a store with no memory row. A cached request handle has no probe
    // facts, so it asks once for both; a store emptied on that handle is still set up again.
    if (facts?.hasMemories ?? holdsMemory(db)) return db;
    const bootstrapped = bootstrapLegacyStore(db, hippoRoot);
    if (bootstrapped) {
      syncMirrorFiles(at, db);
    }
    recordHalfLifeBaseForNewStore(db);
    return db;
  } catch (error) {
    try {
      closeHippoDb(db);
    } catch (closeErr) {
      // The init error is the one thrown; the close failure is only logged.
      log.error(
        `openStore: closing the handle after a failed init failed: ${errorMessage(closeErr)}`,
        errorFields(closeErr),
      );
    }
    throw error;
  }
}

/** One call on a handle of its own, closed after (a session's handle stays open); pass openStore where the call
 *  also sets up mirror folders and legacy rows. */
export function onHandle<T>(
  hippoRoot: string,
  fn: (db: DatabaseSyncLike) => T,
  open: (hippoRoot: string) => DatabaseSyncLike,
): T {
  const db = open(hippoRoot);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** `onHandle` for a call that runs to its promise, with the handle open until it settles. */
export async function onHandleAsync<T>(
  hippoRoot: string,
  fn: (db: DatabaseSyncLike) => Promise<T>,
  open: (hippoRoot: string) => DatabaseSyncLike,
): Promise<T> {
  const db = open(hippoRoot);
  try {
    return await fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** The files of the store under `hippoRoot`, with a Host of their own: a store object keeps its
 * folder's walk. */
export function storeFilesOf(hippoRoot: string, opts: HandleOptions = {}): StoreFiles {
  const strength = withLossAversion(opts.strength ?? PRODUCTION_STRENGTH, opts.lossAversionRatio);
  const grant = grantFor(opts);
  return {
    hippoRoot,
    runtime: grant.runtime,
    opens: { grant, busyWaitMs: opts.busyWaitMs },
    strength,
    clock: hostClock(opts.fakeNowMs ?? null),
    host: createHost(),
  };
}

/** The handles of the store under `hippoRoot`, which only the adapter's composition root builds. */
export function handlesOf(hippoRoot: string, opts: HandleOptions = {}): Handles {
  const files = storeFilesOf(hippoRoot, opts);
  const opener = (open: HandleOpener) => (root: string) => open(root, files.opens);
  return {
    on: (fn, open = readWrite) =>
      onHandle(hippoRoot, (db) => fn(bindHandleClock(db, files.clock), files), opener(open)),
    onAsync: (fn, open = readWrite) =>
      onHandleAsync(hippoRoot, (db) => fn(bindHandleClock(db, files.clock), files), opener(open)),
    open: () => bindHandleClock(readWrite(hippoRoot, files.opens), files.clock),
    files,
  };
}
