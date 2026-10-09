/** Quarantine tier (CD5, AT3): pending/approved/rejected record for a memory `remember` flagged as untrusted. */

import type { DatabaseSyncLike } from './db.js';
import { appendAuditEvent } from './audit.js';
import { QUARANTINE_SCOPE_PREFIX } from './store/quarantine.js';

// The scope a held memory is stored under is the table's own rule, so the store module owns it.
export { quarantineScopeFor } from './store/quarantine.js';

export function isQuarantineScope(scope: string | null | undefined): boolean {
  return scope != null && scope.startsWith(QUARANTINE_SCOPE_PREFIX);
}

export interface RecordQuarantineOpts {
  tenantId: string;
  memoryId: string;
  originalScope: string | null;
  reason: string;
  actor: string;
}

/** Insert the quarantine row + its audit event; caller runs this inside the memory's own write transaction. */
export function recordQuarantine(db: DatabaseSyncLike, opts: RecordQuarantineOpts): void {
  db.prepare(
    `INSERT INTO memory_quarantine (tenant_id, memory_id, original_scope, reason, status, quarantined_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).run(opts.tenantId, opts.memoryId, opts.originalScope, opts.reason, new Date().toISOString());
  appendAuditEvent(db, {
    tenantId: opts.tenantId,
    actor: opts.actor,
    op: 'quarantine',
    targetId: opts.memoryId,
    metadata: { reason: opts.reason, originalScope: opts.originalScope },
  });
}
