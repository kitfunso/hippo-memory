// The records of hippo.db's quarantine queue: a held memory's review record, a list query and what a
// decision answers.
import type { KeysetPosition } from '../util/keyset.js';

/** How many records a quarantine list reads when its query sets no `limit`. */
export const QUARANTINE_LIST_LIMIT = 100;

/** Which of a tenant's quarantine records a list reads; `limit` is QUARANTINE_LIST_LIMIT when
 * unset. */
export interface QuarantineListQuery {
  readonly status: QuarantineStatus | 'all';
  readonly limit?: number;
  readonly after?: KeysetPosition;
}

/** A quarantine record and the whole content of the memory it holds; null once the tenant has no
 * such memory row. */
export interface QuarantinedMemory extends QuarantineRow {
  readonly content: string | null;
}

/** Why a decision wrote nothing: the tenant holds no record for the id (another tenant's id
 * reads the same), or the record was decided before. */
export type QuarantineRefusal =
  | { readonly outcome: 'not_quarantined' }
  | { readonly outcome: 'already_decided'; readonly status: Exclude<QuarantineStatus, 'pending'> };

/** 'scope_moved': the memory row is gone from the tenant or no longer under the scope its
 * quarantine gave it. */
export type QuarantineApproval =
  | { readonly outcome: 'approved' }
  | QuarantineRefusal
  | { readonly outcome: 'scope_moved' };

export type QuarantineRejection = { readonly outcome: 'rejected' } | QuarantineRefusal;

/** hippo.db's quarantine queue; a refusal resolves, never rejects, and writes nothing. */
export interface Quarantine {
  /** At most `limit` of the tenant's records, newest first (quarantinedAt as text in byte order,
   * then memoryId, both descending); `after` keeps only records below its pair. 'pending' leaves
   * out a record whose memory row is gone; every other status keeps it, with null content. No
   * audit row. */
  list(tenantId: string, query: QuarantineListQuery): Promise<QuarantinedMemory[]>;
  /** In one transaction, all or none: restores the memory's originalScope if it is in the tenant
   * and still under `quarantine:private:...`; marks the record approved (decidedAt from the
   * store's clock, decidedBy `actor`); appends one quarantine_approve row ({originalScope}). */
  approve(tenantId: string, id: string, actor: string): Promise<QuarantineApproval>;
  /** In one transaction, both or neither: marks the record rejected (decidedAt and decidedBy as
   * approve) and appends one quarantine_reject row. The memory row is not touched, so it stays
   * under its quarantine scope, and a record with no memory row can still be rejected. */
  reject(tenantId: string, id: string, actor: string): Promise<QuarantineRejection>;
}

export interface QuarantineRow {
  tenantId: string;
  memoryId: string;
  originalScope: string | null;
  reason: string;
  status: QuarantineStatus;
  quarantinedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export type QuarantineStatus = 'pending' | 'approved' | 'rejected';
