// The repeat-error rule: a rated failure repeats when another session hit its signature first.

/** One rated failure_log row with a session and a signature, read oldest first. */
export interface RatedFailure {
  ts: string;
  sessionId: string;
  sigHash: string;
}

/** Rated failures and repeats in one session. */
export interface SessionFailures {
  sessionId: string;
  /** Failures hippo treats as lessons (stored, duplicate or store-failed) in the window. */
  failures: number;
  /** Of those, failures whose signature another session hit first. */
  repeats: number;
}

/** Rated failures per session since `sinceIso`, the input for repeat-error rate per arm. */
export function failuresPerSession(rows: readonly RatedFailure[], sinceIso: string): SessionFailures[] {
  const firstSession = new Map<string, string>();
  const bySession = new Map<string, SessionFailures>();
  for (const row of rows) {
    if (!firstSession.has(row.sigHash)) firstSession.set(row.sigHash, row.sessionId);
    // Rows before the window are not counted but still decide which session hit a signature first.
    if (row.ts < sinceIso) continue;
    const repeat = firstSession.get(row.sigHash) !== row.sessionId;
    const s = bySession.get(row.sessionId) ?? { sessionId: row.sessionId, failures: 0, repeats: 0 };
    bySession.set(row.sessionId, { ...s, failures: s.failures + 1, repeats: s.repeats + (repeat ? 1 : 0) });
  }
  return [...bySession.values()];
}
