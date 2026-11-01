// The audit groups: the audit list, and the maintenance that prunes it, deletes automatically and
// repairs quality.

import type { AuditOp } from '../../records/audit-ops.js';
import type { KeysetPosition } from '../../util/keyset.js';
import { DEFAULT_LIST_LIMIT, MAX_AUDIT_LIMIT } from '../../util/limits.js';
import type { AuditEvent, MethodEffects } from './types.js';

/** The rows an audit list reads for `limit`: one past the cap, since GET /v1/audit reads a row
 * ahead to tell whether another page exists. */
export const auditRowsRead = (limit: number | undefined): number =>
  Math.max(1, Math.min(limit ?? DEFAULT_LIST_LIMIT, MAX_AUDIT_LIMIT + 1));

/** The read behind the audit list. It writes no audit row. */
export interface AuditLog {
  /** One tenant's rows newest first, by ts then id descending, narrowed by `op` and by `since`
   * (ts at or after it); `limit` reads auditRowsRead rows, and `after` resumes below the (ts,
   * id) position a page ended on. */
  listAuditEvents(query: QueryAuditOptions): Promise<AuditEvent[]>;
}

/** What each AuditLog method does to the store; every adapter honours it. */
export const AUDIT_LOG_EFFECTS = {
  listAuditEvents: 'read',
} as const satisfies MethodEffects<AuditLog>;

export interface QueryAuditOptions {
  tenantId: string;
  op?: AuditOp;
  since?: string; // ISO timestamp
  limit?: number;
  /** Resume after this row: the (ts, id) position the previous page ended on. */
  after?: KeysetPosition;
}
