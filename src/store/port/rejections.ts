// The Rejections group, kept apart from port.ts: the tombstones `hippo reject` writes and every write guard reads.

export interface RejectionCheck {
  readonly tenantId: string;
  readonly entryId: string;
  readonly content: string;
}

export interface Rejections {
  /** The tombstone commits first; then one short transaction removes every row in reach holding the text, with one
   * reject_value row. */
  apply(rejection: Rejection): Promise<AppliedRejection>;
  /** Lifts the tenant's one tombstone `digestPrefix` names, with its unreject_value row; none or two write nothing. */
  lift(tenantId: string, digestPrefix: string, actor: string): Promise<LiftedRejection>;
  list(tenantId: string): Promise<RejectedValueRow[]>;
  /** Whether a write guard would refuse each check, in order; writes nothing, so a dry run counts what a run skips. */
  refusedAmong(checks: readonly RejectionCheck[]): Promise<boolean[]>;
}

export interface RejectedValueRow {
  tenantId: string;
  digest: string;
  reason: string | null;
  rejectedBy: string | null;
  rejectedAt: string;
  sourceMemoryId: string | null;
  normalizedChars: number | null;
}

/** The text, tenant and scope of the memory a rejection names. */
export interface RejectionSource {
  content: string;
  tenant_id: string;
  scope: string | null;
}

/** One rejection as the store applies it, all data. A sleep-merged row holding the text gives way to the successor
 * hippo.db's merged-row rule builds from its other texts. */
export interface Rejection {
  readonly tenantId: string;
  readonly actor: string;
  readonly reason: string;
  /** Reject this memory's current text: a row outside `tenantId` refuses as not found, a personal one as a bad request,
   * both before any write. Unset, `value` is the text. */
  readonly memoryId?: string;
  readonly value?: string;
  /** The caller's personal scope, the only personal rows the sweep removes; null leaves every personal row. */
  readonly ownScope: string | null;
}

export interface AppliedRejection {
  digest: string;
  /** The rejected text: the stored row keeps only its digest, so no later read can return it. */
  content: string;
  /** Every row removed, live or dormant: each whose digest matched, duplicates included, and each sleep-merged row
   * holding the text. */
  removedIds: string[];
  /** The removedIds of kind 'raw', archived instead of deleted. */
  removedRawIds: string[];
  /** The rows that carry a live merged row's other texts; dormantSuccessorIds is the same for a dormant one. */
  successorIds: string[];
  dormantSuccessorIds: string[];
}

export type LiftedRejection =
  | { status: 'ok'; digest: string; reason: string | null }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: RejectedValueRow[] };
