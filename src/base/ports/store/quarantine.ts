import type { KeysetPosition } from '../../util/keyset.js';
import type { MethodEffects } from './effects.js';

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
  /** The held memory's lead-in; absent when it has none, so a review sees text the flag may sit in. */
  readonly leadIn?: string;
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

/** An edit's text, already screened, the lead-in and tags it was screened with, and the half-life a
 * new row starts from. */
export interface QuarantineEditInput {
  readonly content: string;
  readonly leadIn: string | null;
  readonly tags: readonly string[];
  readonly baseHalfLifeDays: number;
}

/** 'edited': the successor `newId` is live under the record's originalScope. 'deleted': the held
 * memory row is gone. 'superseded': a memory row `supersededBy` already replaced it. 'scope_moved':
 * it is no longer under its quarantine scope. */
export type QuarantineEditOutcome =
  | { readonly outcome: 'edited'; readonly newId: string }
  | QuarantineRefusal
  | { readonly outcome: 'deleted' }
  | { readonly outcome: 'superseded'; readonly supersededBy: string }
  | { readonly outcome: 'scope_moved' };

/**
 * The review queue behind the quarantine routes. A refusal is a resolved value, never a rejection,
 * and writes nothing; the one exception is editQuarantined, which rejects with RejectedValueError
 * on a tombstoned text and writes a reject_refusal row.
 */
export interface Quarantine {
  /** At most `limit` of the tenant's records, newest first (quarantinedAt as text in byte order,
   * then memoryId, both descending); `after` keeps only records below its pair. 'pending' leaves
   * out a record whose memory row is gone; every other status keeps it, with null content. No
   * audit row. */
  listQuarantined(tenantId: string, query: QuarantineListQuery): Promise<QuarantinedMemory[]>;
  /** In one transaction, all or none: restores the memory's originalScope if it is in the tenant
   * and still under `quarantine:private:...`; marks the record approved (decidedAt from the
   * store's clock, decidedBy `actor`); appends one quarantine_approve row ({originalScope}). */
  decideQuarantined(
    tenantId: string,
    id: string,
    decision: 'approve',
    actor: string,
  ): Promise<QuarantineApproval>;
  /** In one transaction, both or neither: marks the record rejected (decidedAt/decidedBy as
   * approve) and appends one quarantine_reject row. The memory row is not touched, so it stays
   * under its quarantine scope and a record with no memory row can still be rejected. */
  decideQuarantined(
    tenantId: string,
    id: string,
    decision: 'reject',
    actor: string,
  ): Promise<QuarantineRejection>;
  /** Optional: a store without it answers 501 for an edit. In one transaction, all or none, on a
   * pending record whose memory is in the tenant, under its quarantine scope and not superseded:
   * writes a successor under originalScope (parents [id], the held row's artifactRef) carrying
   * `edit.content`, and the `edit.leadIn` and `edit.tags` passed, not the held row's; supersedes the
   * held row by it; marks the record approved; appends the supersede, remember and one
   * quarantine_edit row ({originalScope, newId}), in that order. Refuses with 'deleted',
   * 'superseded' (carrying supersededBy) or 'scope_moved' in that case. A tombstoned text rejects
   * with RejectedValueError, rolls back and leaves one reject_refusal row. */
  editQuarantined?(
    tenantId: string,
    id: string,
    edit: QuarantineEditInput,
    actor: string,
  ): Promise<QuarantineEditOutcome>;
}

/** What each Quarantine method does to the store; every adapter honours it. */
export const QUARANTINE_EFFECTS = {
  listQuarantined: 'read',
  decideQuarantined: 'write',
  editQuarantined: 'write',
} as const satisfies MethodEffects<Quarantine>;

/** `Quarantine` as an adapter writes it; the port's overloads pair each decision with its
 * answer. */
export interface QuarantineCalls {
  listQuarantined: Quarantine['listQuarantined'];
  decideQuarantined(
    tenantId: string,
    id: string,
    decision: 'approve' | 'reject',
    actor: string,
  ): Promise<QuarantineApproval | QuarantineRejection>;
  editQuarantined: NonNullable<Quarantine['editQuarantined']>;
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
