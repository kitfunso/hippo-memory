import type { AuditEvent, QueryAuditOptions } from '../audit.js';

/** The read behind the audit list. It writes no audit row. */
export interface AuditLog {
  /** One tenant's rows newest first, by ts then id descending, narrowed by `op` and
   * by `since` (ts at or after it); `limit` is clamped to 1..10001 and defaults to
   * 100, and `after` resumes below the (ts, id) position a page ended on. */
  listAuditEvents(query: QueryAuditOptions): Promise<AuditEvent[]>;
}
