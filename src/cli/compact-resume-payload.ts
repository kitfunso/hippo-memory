// The payload gate for `hippo compact-resume`.

import { isSubagentPayload } from '../token-ledger.js';

export interface CompactResumePayload { suppressOutput: boolean; payloadSessionId: string | null; boundary: boolean }

/** Fail-closed read of the SessionStart payload: only a manual run or a main-session `source: 'compact'` payload may print. */
export function readCompactResumePayload(stdinText: string | undefined, stdinTimedOut: boolean): CompactResumePayload {
  // An older Claude Code that ignores `matcher: 'compact'` runs this on every SessionStart, so a parsed payload with any other source stays silent.
  const nonEmptyStdin = !!stdinText && stdinText.trim() !== '';
  // Without a payload session_id the cross-restore guard can never fire, so a timed-out empty read must not reach the print path.
  let suppressOutput = stdinTimedOut && !nonEmptyStdin;
  let payloadSessionId: string | null = null;
  // A boundary is a manual run or a payload that says it follows a compaction; anything else is not one.
  let boundary = !nonEmptyStdin && !stdinTimedOut;

  if (nonEmptyStdin) {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(stdinText!.trim()) as Record<string, unknown>;
    } catch {
      // Malformed JSON is handled as a null payload by the fail-closed check below.
      payload = null;
    }
    if (!payload || typeof payload !== 'object') {
      // Fail closed on malformed non-empty stdin; only a TTY/no-stdin manual run, which never reaches here, prints.
      suppressOutput = true;
    } else {
      // Fail closed on structurally incomplete payloads too ({}, [], source missing/non-string): a real SessionStart payload always carries source.
      // A sub-agent's payload carries its parent's session id, so the mismatch guard would pass and restore the parent's snapshot into it.
      boundary = payload.source === 'compact';
      if (payload.source !== 'compact' || isSubagentPayload(stdinText)) {
        suppressOutput = true;
      }
      if (typeof payload.session_id === 'string') {
        payloadSessionId = payload.session_id;
      }
    }
  }
  return { suppressOutput, payloadSessionId, boundary };
}
