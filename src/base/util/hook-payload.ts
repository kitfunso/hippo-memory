import { type JsonValue, isJsonObjectLiteral, isJsonString, tryParseJson } from './json.js';

/** A Claude Code hook payload on stdin as a JSON object; null when empty, malformed or not an object. */
function parseHookPayload(stdinText: string | undefined): { [key: string]: JsonValue } | null {
  if (!stdinText || stdinText.trim() === '') return null;
  const payload = tryParseJson(stdinText.trim());
  return isJsonObjectLiteral(payload) ? payload : null;
}

/** A hook payload's non-empty `session_id`, or null; with `requiredSource`, also null when its `source` differs. */
export function hookPayloadSessionId(
  stdinText: string | undefined,
  requiredSource: string | null = null,
): string | null {
  const payload = parseHookPayload(stdinText);
  const sessionId = payload?.session_id;
  if (!payload || !isJsonString(sessionId) || sessionId.trim() === '') return null;
  if (requiredSource !== null && payload.source !== requiredSource) return null;
  return sessionId;
}

/** A hook payload's string `field` as sent, or null when the payload or the field is missing or not a string. */
export function hookPayloadString(stdinText: string | undefined, field: string): string | null {
  const value = parseHookPayload(stdinText)?.[field];
  return isJsonString(value) ? value : null;
}

/**
 * Whether a hook fired inside a sub-agent, the only payload with `agent_id`
 * (https://code.claude.com/docs/en/hooks#common-input-fields).
 * Its `session_id` is the parent's, so a sub-agent's blocks and compactions must not count as the parent's. */
export function isSubagentPayload(stdinText: string | undefined): boolean {
  const agentId = parseHookPayload(stdinText)?.agent_id;
  return isJsonString(agentId) && agentId.trim() !== '';
}
