// The FailureLog group, kept apart from port.ts: the row each tool failure writes, read back by request id so a retried
// send gets the first answer.

export interface FailureLog {
  /** Appends one row and answers its id. */
  record(event: FailureEvent): Promise<number>;
  /** The outcome logged under the request id, or null; an id another session logged rejects with ConflictError. */
  requestOutcome(tenantId: string, requestId: string, sessionId: string): Promise<FailureOutcome | null>;
  settleOutcome(tenantId: string, requestId: string, outcome: FailureOutcome): Promise<void>;
}

/** One failed tool call, for {@link recordFailure}. Never the failure text: it can carry paths and secrets. */
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

/** Failure log totals over a window, for {@link summarizeFailures}. Counts only: a rate needs a holdout arm. */
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
