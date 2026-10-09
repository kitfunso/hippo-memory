// Sleep's tombstone checks run on one handle for the whole pass, owned here so no stage holds a raw one.
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../db/index.js';
import { type AppendAuditOpts, appendAuditEvent } from './audit.js';
import { findRejectedValue, type RejectedValueRow } from './rejection.js';

/** Tombstone lookups and their refusal audit rows on one handle: opened on first use, never under dryRun, closed once. */
export interface TombstoneChecks {
  /** The tenant's tombstone for `digest`; null when there is none, and always under dryRun. */
  find(tenantId: string, digest: string): RejectedValueRow | null;
  /** One audit row on the same handle; nothing under dryRun. */
  audit(event: AppendAuditOpts): void;
  close(): void;
}

// Lazy so a sleep that checks nothing never opens the store; make it IMMEDIATELY before the try whose
// finally closes it, so a throw in any phase cannot leak the handle.
export function lazyTombstoneChecks(hippoRoot: string, dryRun: boolean): TombstoneChecks {
  let handle: DatabaseSyncLike | null = null;
  const opened = (): DatabaseSyncLike | null => {
    if (dryRun) return null;
    handle ??= openHippoDb(hippoRoot);
    return handle;
  };
  return {
    find(tenantId, digest) {
      const db = opened();
      return db ? findRejectedValue(db, tenantId, digest) : null;
    },
    audit(event) {
      const db = opened();
      if (db) appendAuditEvent(db, event);
    },
    close() {
      if (handle) closeHippoDb(handle);
    },
  };
}
