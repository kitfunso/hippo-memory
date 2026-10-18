// Sleep's tombstone checks run on one handle for the whole pass, owned here so no stage holds a raw one.
import { closeHippoDb, type DatabaseSyncLike } from '../db/index.js';
import { appendAuditEvent, reportAuditWriteFailure } from './audit.js';
import { findRejectedValue } from './rejection.js';
import { errorMessage } from '../util/log.js';
import type { TombstoneChecks } from './port/consolidation.js';

// Lazy so a sleep that checks nothing never opens the store; make it IMMEDIATELY before the try whose
// finally closes it, so a throw in any phase cannot leak the handle.
export function lazyTombstoneChecks(open: () => DatabaseSyncLike, dryRun: boolean): TombstoneChecks {
  let handle: DatabaseSyncLike | null = null;
  const opened = (): DatabaseSyncLike | null => {
    if (dryRun) return null;
    handle ??= open();
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
    auditOrCount(event) {
      try {
        this.audit(event);
      } catch (error) {
        reportAuditWriteFailure(event.op, errorMessage(error), event.targetId);
      }
    },
    close() {
      if (handle) closeHippoDb(handle);
    },
  };
}
