import { envHomeDir } from '../env.js';
import * as fs from 'fs';
import * as path from 'path';
import { isObjectLike, isStringValue } from '../capture-contract.js';

/**
 * Build a compact text summary from a Claude Code / OpenCode JSONL transcript.
 * Keeps plain user messages and the final chunk of assistant text, drops
 * thinking blocks, tool_use, and tool_result noise. Capture reads the same
 * turns through `sessionTail`, one text per turn.
 *
 * Exported for tests.
 */

/** Leading markers of the command lines Claude Code writes with type 'user'. */
const CLAUDE_CODE_COMMAND_PREFIXES = ['<local-command-', '<command-name>', '<command-message>', '<command-args>'];

/** Transcript-line flags isNonHumanUserLine reads (any may be absent); `promptSource: 'system'` marks Claude Code's own notices. */
interface TranscriptLineFlags {
  type?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  isCompactSummary?: unknown;
  promptSource?: unknown;
}

function isNonHumanUserLine(entry: TranscriptLineFlags, content: string): boolean {
  if (entry.isMeta === true || entry.isSidechain === true || entry.isCompactSummary === true || entry.promptSource === 'system') return true;
  const head = content.trimStart();
  return CLAUDE_CODE_COMMAND_PREFIXES.some((p) => head.startsWith(p));
}

interface TranscriptMessage {
  content?: unknown;
}

const NON_HUMAN_BLOCK_PREFIXES = ['<ide_', '[Request interrupted by user'];

/** The human's words on a Claude Code user line, '' when none; VS Code stores prompts as text blocks, beside its own open-file, selection and interrupt blocks. */
export function humanUserText(entry: TranscriptLineFlags, message: TranscriptMessage): string {
  const content = message.content;
  let text = '';
  if (isStringValue(content)) {
    text = content;
  } else if (Array.isArray(content) && !content.some((b) => isObjectLike(b) && 'type' in b && b.type === 'tool_result')) {
    const parts: string[] = [];
    for (const block of content) {
      const blockText = isObjectLike(block) && 'type' in block && block.type === 'text' && 'text' in block ? block.text : undefined;
      if (isStringValue(blockText) && !NON_HUMAN_BLOCK_PREFIXES.some((p) => blockText.trimStart().startsWith(p))) parts.push(blockText);
    }
    text = parts.join('\n');
  }
  text = text.trim();
  return text && !isNonHumanUserLine(entry, text) ? text : '';
}

export interface SessionTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface TranscriptRecord extends TranscriptLineFlags {
  message?: unknown;
  payload?: unknown;
  cwd?: unknown;
}

export function collectSessionTurns(jsonl: string, visit?: (record: TranscriptRecord) => void): SessionTurn[] {
  const lines = jsonl.split('\n').filter((l) => l.trim());
  const turns: SessionTurn[] = [];

  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn or partial transcript line carries no turn
    }
    if (!isObjectLike(entry) || !('type' in entry)) continue;
    visit?.(entry);

    if (entry.type === 'user' || entry.type === 'assistant') {
      const message = 'message' in entry && isObjectLike(entry.message) ? entry.message : undefined;
      if (!message) continue;
      const content = 'content' in message ? message.content : undefined;

      if (entry.type === 'user') {
        const text = humanUserText(entry, message);
        if (text) turns.push({ role: 'user', text });
      } else if (Array.isArray(content)) {
        // Keep assistant text blocks; drop thinking + tool_use
        const chunks: string[] = [];
        for (const block of content) {
          if (isObjectLike(block)) {
            const blockText = 'type' in block && block.type === 'text' && 'text' in block ? block.text : undefined;
            if (isStringValue(blockText) && blockText.trim()) {
              chunks.push(blockText.trim());
            }
          }
        }
        if (chunks.length > 0) {
          turns.push({ role: 'assistant', text: chunks.join('\n') });
        }
      }
      continue;
    }

    // Codex rollout transcript shape: response_item -> payload.message
    if (entry.type === 'response_item') {
      const payload = 'payload' in entry && isObjectLike(entry.payload) ? entry.payload : undefined;
      if (!payload || !('type' in payload) || payload.type !== 'message') continue;
      const role = 'role' in payload ? payload.role : undefined;
      const content = 'content' in payload ? payload.content : undefined;
      if (!Array.isArray(content)) continue;

      const chunks: string[] = [];
      for (const block of content) {
        if (!isObjectLike(block)) continue;
        const blockType = 'type' in block ? block.type : undefined;
        const blockText = 'text' in block ? block.text : undefined;
        if (role === 'user' && blockType === 'input_text' && isStringValue(blockText) && blockText.trim()) {
          chunks.push(blockText.trim());
        }
        if (role === 'assistant' && blockType === 'output_text' && isStringValue(blockText) && blockText.trim()) {
          chunks.push(blockText.trim());
        }
      }

      if (chunks.length === 0) continue;
      if (role === 'user') turns.push({ role: 'user', text: chunks.join('\n') });
      if (role === 'assistant') turns.push({ role: 'assistant', text: chunks.join('\n') });
    }
  }

  return turns;
}

export function summariseTranscript(jsonl: string): string {
  return summariseSessionTurns(collectSessionTurns(jsonl));
}

/** The last 20 user turns and last 10 replies: session-end is about what was decided near the end, not at the start. */
export function sessionTail(turns: readonly SessionTurn[]) {
  return {
    users: turns.filter((t) => t.role === 'user').map((t) => t.text).slice(-20),
    assistants: turns.filter((t) => t.role === 'assistant').map((t) => t.text).slice(-10),
  };
}

export function summariseSessionTurns(turns: readonly SessionTurn[]): string {
  const { users: tailUsers, assistants: tailAssistants } = sessionTail(turns);
  if (tailUsers.length === 0 && tailAssistants.length === 0) return '';

  return [
    '# Session Summary',
    '',
    '## User Messages',
    ...tailUsers.map((m) => `- ${m}`),
    '',
    '## Assistant Responses',
    // A blank line between replies keeps capture from joining two of them; each user turn opens its own list item.
    tailAssistants.join('\n\n'),
  ].join('\n');
}

/**
 * Resolve a transcript path for `--last-session`.
 *
 * Priority, where the first source present is the only one tried:
 *   1. Explicit `transcriptPath` option (from `--transcript <path>`)
 *   2. Stdin JSON payload (Claude Code / OpenCode SessionEnd hook shape)
 *   3. Most recent `.jsonl` under `~/.claude/projects/<any>/`, only when the caller passes `mayScan` (only the caller knows it is not a hook) and there is no path and no stdin text, because this scan spans every project on the box
 *
 * Returns null when nothing resolves, a named transcript or payload whose file is missing included. Never throws.
 */
export function resolveLastSessionTranscript(
  explicit: string | undefined,
  stdinText: string | undefined,
  opts: { mayScan: boolean }
): string | null {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;

  if (stdinText && stdinText.trim() !== '') {
    try {
      const payload: unknown = JSON.parse(stdinText);
      if (isObjectLike(payload) && 'transcript_path' in payload) {
        const tp = payload.transcript_path;
        if (isStringValue(tp) && fs.existsSync(tp)) return tp;
      }
    } catch {
      // not JSON, but still a payload, so no scan
    }
    return null;
  }

  if (!opts.mayScan) return null;

  const home = envHomeDir();
  if (!home) return null;
  const projectsDir = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  let newest: { path: string; mtime: number } | null = null;
  try {
    for (const entry of fs.readdirSync(projectsDir)) {
      const subDir = path.join(projectsDir, entry);
      const stat = fs.statSync(subDir);
      if (!stat.isDirectory()) continue;
      for (const file of fs.readdirSync(subDir)) {
        if (!file.endsWith('.jsonl')) continue;
        const full = path.join(subDir, file);
        const m = fs.statSync(full).mtimeMs;
        if (!newest || m > newest.mtime) newest = { path: full, mtime: m };
      }
    }
  } catch {
    return null; // an unlistable projects dir means no transcript to find; the caller prints that
  }
  return newest?.path ?? null;
}
