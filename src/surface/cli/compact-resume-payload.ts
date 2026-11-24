import { isSubagentPayload } from '../../base/util/hook-payload.js';
import { isJsonObject, isJsonString, tryParseJson } from '../../base/util/json.js';

export interface CompactResumePayload {
  suppressOutput: boolean;
  payloadSessionId: string | null;
  boundary: boolean;
}

/**
 * Fail-closed read of the SessionStart payload: only a manual run or a main-session `source:
 * 'compact'` payload may print.
 */
export function readCompactResumePayload(
  stdinText: string | undefined,
  stdinTimedOut: boolean,
): CompactResumePayload {
  // An older Claude Code that ignores `matcher: 'compact'` runs this on every SessionStart, so a
  // parsed payload with any other source stays silent.
  const nonEmptyStdin = !!stdinText && stdinText.trim() !== '';
  let suppressOutput = stdinTimedOut && !nonEmptyStdin;
  let payloadSessionId: string | null = null;
  let boundary = !nonEmptyStdin && !stdinTimedOut;

  if (nonEmptyStdin) {
    const payload = tryParseJson(stdinText!.trim());
    if (!isJsonObject(payload)) {
      suppressOutput = true;
    } else {
      // Fail closed on structurally incomplete payloads too ({}, [], source missing/non-string): a
      // real SessionStart payload always carries source. A sub-agent's payload carries its parent's
      // session id, so the mismatch guard would pass and restore the parent's snapshot into it.
      boundary = payload.source === 'compact';
      if (payload.source !== 'compact' || isSubagentPayload(stdinText)) {
        suppressOutput = true;
      }
      if (isJsonString(payload.session_id)) {
        payloadSessionId = payload.session_id;
      }
    }
  }
  return { suppressOutput, payloadSessionId, boundary };
}
