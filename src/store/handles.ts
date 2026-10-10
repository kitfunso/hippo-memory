// Handles for callers outside the data layer that run their own reads and writes on a store's SQLite file.

import { closeHippoDb, type DatabaseSyncLike, openHippoDb, openHippoDbReadOnly, outsideRequestStores } from '../db/index.js';

/** A read-write handle; the caller closes it and decides how long a busy file is waited on. */
export function openWriteHandle(hippoRoot: string, opts?: { busyWaitMs?: number }): DatabaseSyncLike {
  return openHippoDb(hippoRoot, opts);
}

/** One call on a read-write handle of its own, closed after, for a caller that only runs its own reads and writes. */
export function withWriteHandle<T>(hippoRoot: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(hippoRoot);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** A read-only handle for a check that must never create or change the file. */
export function openReadHandle(hippoRoot: string): DatabaseSyncLike {
  return openHippoDbReadOnly(hippoRoot);
}

/** A handle on a throwaway store, kept out of any request scope so deleting its folder never meets an open file. */
export function openScratchHandle(hippoRoot: string): DatabaseSyncLike {
  return outsideRequestStores(() => openHippoDb(hippoRoot));
}
