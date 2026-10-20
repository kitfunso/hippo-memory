// Which Codex sessions a run started, read from the lines Codex appended to history.jsonl during it.
import { isJsonObjectLiteral, isJsonString, parseJson } from '../../base/util/json.js';
import { errorMessage, log, errorFields } from '../../base/util/log.js';

/** Each session id in `delta` once, in first-seen order; `historyPath` only names the file in a warning. */
export function codexSessionIds(delta: string, historyPath: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const line of delta.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = parseJson(line);
      const sessionId = isJsonObjectLiteral(parsed) ? parsed.session_id : undefined;
      if (isJsonString(sessionId) && sessionId && !seen.has(sessionId)) {
        seen.add(sessionId);
        ordered.push(sessionId);
      }
    } catch (err) {
      log.warn(`codex history ${historyPath}: skipped a malformed JSONL line (${errorMessage(err)})`, errorFields(err));
    }
  }
  return ordered;
}
