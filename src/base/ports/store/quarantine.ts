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
  listQuarantined(tenantId: string, query: QuarantineListQuery): Promise<QuarantinedMemory[]>;
  decideQuarantined(
    tenantId: string,
    id: string,
    decision: 'approve',
    actor: string,
  ): Promise<QuarantineApproval>;
  decideQuarantined(
    tenantId: string,
    id: string,
    decision: 'reject',
    actor: string,
  ): Promise<QuarantineRejection>;
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
