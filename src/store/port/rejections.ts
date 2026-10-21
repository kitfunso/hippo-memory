// What a store refuses or fails to keep: the rejection tombstones every write guard reads, and the failure log.

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

// The FailureLog group, kept apart from port.ts: the row each tool failure writes, read back by request id so a retried
// send gets the first answer.
export interface FailureLog {
  /** Appends one row and answers its id. */
  record(event: FailureEvent): Promise<number>;
  /** The outcome logged under the request id, or null; an id another session logged rejects with ConflictError. */
  requestOutcome(tenantId: string, requestId: string, sessionId: string): Promise<FailureOutcome | null>;
  settleOutcome(tenantId: string, requestId: string, outcome: FailureOutcome): Promise<void>;
}

/** One failed tool call, for `recordFailure`. Never the failure text: it can carry paths and secrets. */
export interface FailureEvent {
  tenantId: string;
  /** Host session id from the hook payload; null when it had none. */
  sessionId?: string | null;
  tool?: string | null;
  outcome: FailureOutcome;
  /** The routine check that skipped it, for `skipped-routine`. */
  rule?: RoutineRule | null;
  /** Hash of the lesson text's signature, the key dedupe uses; null when the payload had no readable error. */
  sigHash?: string | null;
  /** Hash of the untruncated error plus the command's first two words, finer than `sigHash`. */
  detailHash?: string | null;
  /** A shared-store caller's owner and project; null on a local store. */
  ownerSubject?: string | null;
  originProject?: string | null;
  /** The client's queue record id, so a retried send finds the earlier row. */
  requestId?: string | null;
  /** Override the timestamp (tests). ISO string. */
  now?: string;
}

/** A capture-error outcome, or `store-failed` when storing the lesson threw. */
export type FailureOutcome = CaptureErrorOutcome | 'store-failed';

/** Why a failure was not stored, or `stored`. */
export type CaptureErrorOutcome = 'stored' | 'duplicate' | 'skipped-interrupt' | 'skipped-routine' | 'skipped-invalid';

/** Which routine check skipped a failure; the log keeps it so declines can be told apart from empty searches. */
export type RoutineRule = 'declined' | 'os-permission' | 'no-match' | 'search-tool' | 'quiet-exit';

/** Failure log totals over a window, for `summarizeFailures`. Counts only: a rate needs a holdout arm. */
export interface FailureSummary {
  /** ISO start of the window (inclusive). */
  since: string;
  outcomes: Record<FailureOutcome, number>;
  total: number;
  /** Rated failures from sessions with an id: the failures a repeat is counted among. */
  rated: number;
  repeats: number;
  sessions: number;
}
