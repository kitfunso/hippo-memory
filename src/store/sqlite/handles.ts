// Opens hippo.db by its folder. Only the SQLite adapter holds a folder; every layer above takes the store it is given.

import { closeHippoDb, currentRequestStores, type DatabaseSyncLike, openHippoDb } from '../../db/index.js';
import { reproveStoreSchema } from '../../db/connect.js';
import { openHippoDbWithFacts } from '../../db/open.js';
import { errorFields, errorMessage, log } from '../../util/log.js';
import { ensureMirrorDirectories, syncMirrorFiles } from './mirrors.js';
import { recoverDueMirrors } from './due-mirrors.js';
import { bootstrapLegacyStore, type Handles, recordHalfLifeBaseForNewStore, type StoreFiles } from './open.js';
import type { LossAversion } from '../../core/memory.js';

export function initStore(hippoRoot: string): void {
  reproveStoreSchema(hippoRoot);
  closeHippoDb(openStore(hippoRoot));
}

/** One open connection with init done on it, for callers who used to pay for `initStore` + a second `openHippoDb`. */
export function openStore(hippoRoot: string, opts?: { busyWaitMs?: number }): DatabaseSyncLike {
  // Open first: a folder marked for another store must refuse before any mirror folder appears.
  const { db, facts } = openHippoDbWithFacts(hippoRoot, opts);
  // A store worker's reader: its writer ran the steps below before this thread was sent a job, and this connection
  // cannot write them.
  if (currentRequestStores()?.setupDoneFor === hippoRoot) return db;
  try {
    ensureMirrorDirectories(hippoRoot);
    recoverDueMirrors(hippoRoot, db);
    // Both steps act only on a store with no memory row, which the open's own probe has just ruled out.
    if (facts?.hasMemories) return db;
    const bootstrapped = bootstrapLegacyStore(db, hippoRoot);
    if (bootstrapped) {
      syncMirrorFiles(hippoRoot, db);
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

/** A connection with no mirror or legacy setup, for a caller that already ran `initStore`. */
export function openBareHandle(hippoRoot: string, opts?: { busyWaitMs?: number }): DatabaseSyncLike {
  return openHippoDb(hippoRoot, opts);
}

/** One call on a handle of its own, closed after (a request scope's handle stays open);
 *  pass openStore where the call also sets up mirror folders and legacy rows. */
export function onHandle<T>(
  hippoRoot: string,
  fn: (db: DatabaseSyncLike) => T,
  open: (hippoRoot: string) => DatabaseSyncLike = openHippoDb,
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
  open: (hippoRoot: string) => DatabaseSyncLike = openHippoDb,
): Promise<T> {
  const db = open(hippoRoot);
  try {
    return await fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** The handles of the store under `hippoRoot`, which only the adapter's composition root builds. */
export function handlesOf(hippoRoot: string, rules: LossAversion = {}): Handles {
  const files: StoreFiles = { hippoRoot, lossAversionRatio: rules.lossAversionRatio };
  return {
    on: (fn, open) => onHandle(hippoRoot, (db) => fn(db, files), open),
    onAsync: (fn, open) => onHandleAsync(hippoRoot, (db) => fn(db, files), open),
    open: () => openHippoDb(hippoRoot),
    files,
  };
}
