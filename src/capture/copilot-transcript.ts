// The Copilot event log: one `{type, data, id, timestamp, parentId}` object per line, written by the Copilot CLI and VS Code Local alike.
// Matched line by line, since the tail readers start mid-file and never see the session.start line.
import * as fs from 'fs';
import * as path from 'path';
import { copilotHomeDir } from '../hooks/shared.js';
import { isObjectLike, isStringValue } from '../capture-contract.js';

/** The envelope fields a Copilot event-log line is read by; any may be absent. */
export interface CopilotEventLine {
  type?: unknown;
  data?: unknown;
  agentId?: unknown;
}

/** The `data` fields read from a user.message or assistant.message line; any may be absent. */
interface CopilotMessageData {
  content?: unknown;
  source?: unknown;
  isAutopilotContinuation?: unknown;
  parentToolCallId?: unknown;
}

export interface CopilotTurn {
  role: 'user' | 'assistant';
  text: string;
}

// A session id becomes a folder name, so anything beyond word characters and hyphens could climb out of session-state.
export const SESSION_ID_RE = /^[\w-]+$/;

// user.message sources that mark text hippo did not get from the human: a hidden skill injection or another agent's prompt.
const INJECTED_SOURCE_PREFIXES = ['skill-', 'agent-'];

/** The Copilot CLI log for a session, `<copilotHome>/session-state/<id>/events.jsonl`; null for an unsafe id or a missing file. */
export function copilotTranscriptFor(sessionId: string): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const file = path.join(copilotHomeDir(), 'session-state', sessionId, 'events.jsonl');
  return fs.existsSync(file) ? file : null;
}

/** True for VS Code's own chat log, `<workspaceStorage>/<id>/github.copilot-chat/transcripts/<session id>.jsonl`, in either slash and any case. */
export function isVscodeTranscript(file: string | null): boolean {
  if (!file) return false;
  const parts = file.toLowerCase().split(/[\\/]/);
  return parts.length >= 3 && parts[parts.length - 2] === 'transcripts' && parts[parts.length - 3] === 'github.copilot-chat';
}

function isSubagentLine(line: CopilotEventLine, data: CopilotMessageData): boolean {
  if (isStringValue(line.agentId) && line.agentId !== '') return true;
  return isStringValue(data.parentToolCallId) && data.parentToolCallId !== '';
}

function isInjectedUserMessage(data: CopilotMessageData): boolean {
  if (data.isAutopilotContinuation === true) return true;
  const source = data.source;
  return isStringValue(source) && INJECTED_SOURCE_PREFIXES.some((prefix) => source.startsWith(prefix));
}

/** The turn one Copilot event-log line carries: the text of a human user.message or of an assistant.message; null for any other line, a sub-agent's included. */
export function copilotTurn(line: CopilotEventLine): CopilotTurn | null {
  const role = line.type === 'user.message' ? 'user' : line.type === 'assistant.message' ? 'assistant' : null;
  const data: CopilotMessageData | null = isObjectLike(line.data) ? line.data : null;
  if (role === null || data === null || isSubagentLine(line, data)) return null;
  if (role === 'user' && isInjectedUserMessage(data)) return null;
  const text = isStringValue(data.content) ? data.content.trim() : '';
  return text ? { role, text } : null;
}
