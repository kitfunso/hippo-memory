import type { QuarantineRow, QuarantineStatus } from '../quarantine.js';
import type { KeysetPosition } from '../../util/keyset.js';

/** Which of a tenant's quarantine records a list reads; `limit` is 100 when unset. */
export interface QuarantineListQuery {
  readonly status: QuarantineStatus | 'all';
  readonly limit?: number;
  readonly after?: KeysetPosition;
}

/** A quarantine record and the whole content of the memory it holds; null once the tenant has no such memory row. */
export interface QuarantinedMemory extends QuarantineRow {
  readonly content: string | null;
}

/** Why a decision wrote nothing: the tenant holds no record for the id (another tenant's id reads the same), or the
 * record was decided before. */
export type QuarantineRefusal =
  | { readonly outcome: 'not_quarantined' }
  | { readonly outcome: 'already_decided'; readonly status: Exclude<QuarantineStatus, 'pending'> };

/** 'scope_moved': the memory row is gone from the tenant or no longer under the scope its quarantine gave it. */
export type QuarantineApproval =
  { readonly outcome: 'approved' } | QuarantineRefusal | { readonly outcome: 'scope_moved' };

export type QuarantineRejection = { readonly outcome: 'rejected' } | QuarantineRefusal;

/** The review queue behind the quarantine routes. A refusal is
 * a resolved value, never a rejection, and writes nothing. */
export interface Quarantine {
  /** At most `limit` of the tenant's records, newest first (quarantinedAt as text in byte order, then memoryId, both
   * descending); `after` keeps only records below its pair. 'pending' leaves out a record whose memory row is gone;
   * every other status keeps it, with null content. No audit row. */
  listQuarantined(tenantId: string, query: QuarantineListQuery): Promise<QuarantinedMemory[]>;
  /** In one transaction, all or none: restores the memory's originalScope if it is in the tenant and still under
   * `quarantine:private:...`; marks the record approved (decidedAt from the store's clock, decidedBy `actor`); appends
   * one quarantine_approve row ({originalScope}). */
  approveQuarantined(tenantId: string, id: string, actor: string): Promise<QuarantineApproval>;
  /** In one transaction, both or neither: marks the record rejected (decidedAt/decidedBy as approve) and appends one
   * quarantine_reject row. The memory row is not touched, so it stays under its quarantine scope and a record with no
   * memory row can still be rejected. */
  rejectQuarantined(tenantId: string, id: string, actor: string): Promise<QuarantineRejection>;
}
