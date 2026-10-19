// The shared shape every agent adapter turns a host payload into, so capture code is written once for all runtimes.
// Field meanings, statuses and how to add a runtime: docs/integrations/agent-inventory.md.

import { isJsonObject, isJsonString, tryParseJson, type JsonValue } from '../util/json.js';

type JsonObject = { [key: string]: JsonValue };

/** A host lifecycle moment hippo can capture from. */
export type CaptureEvent =
  | 'prompt'
  | 'tool-failure'
  | 'pre-compact'
  | 'post-compact'
  | 'session-start'
  | 'session-end'
  | 'turn-end'
  | 'reset';

/** What hippo read from one host payload, before anything is written. */
export interface CaptureInput {
  readonly runtime: string;
  readonly event: CaptureEvent;
  /** True when no host payload arrived: a person ran the verb by hand. */
  readonly manual: boolean;
  readonly sessionId: string | null;
  readonly cwd: string | null;
  readonly transcriptPath: string | null;
  /** The host's own reason for the event, such as `auto` or `manual` compaction. */
  readonly trigger: string | null;
}

/** The outcome of reading a payload: usable input, a payload hippo refuses, or no payload at all. */
export type CaptureReceipt<I extends CaptureInput = CaptureInput> =
  | { readonly status: 'received'; readonly input: I }
  | { readonly status: 'skipped' | 'unavailable'; readonly reason: string };

/** What a PostCompact payload adds: it always names a session, and carries the summary Claude Code wrote. */
export interface PostCompactInput extends CaptureInput {
  readonly event: 'post-compact';
  readonly sessionId: string;
  /** null when Claude Code sent none; the transcript fills the record later. */
  readonly compactSummary: string | null;
}

/** Working state saved before the host drops context, so the session can resume; it is not a lesson. */
export interface Checkpoint {
  readonly runtime: string;
  readonly sessionId: string | null;
  readonly task: string;
  readonly summary: string;
  readonly nextStep: string;
  readonly savedAt: string;
}

/** How far capture has read one session's source, so a retry resumes instead of re-reading or skipping. */
export interface ProgressCursor {
  readonly runtime: string;
  readonly sessionId: string;
  readonly source: string;
  /** Opaque position in the source, such as a byte offset or the last turn id read. */
  readonly position: string;
  readonly updatedAt: string;
}

/** A string guard that avoids `typeof`; it matches it for every value `JSON.parse` can produce. */
export function isStringValue<T>(value: T): value is T & string {
  return String(value) === value;
}

/** An object guard that avoids `typeof`; arrays count as objects, as they do for `typeof`. */
export function isObjectLike<T>(value: T): value is T & object {
  return value !== null && value instanceof Object;
}

/** The hook runtimes a `--runtime` flag names; absent means Claude Code. */
export type HookRuntime = 'claude-code' | 'copilot';

/** True for no stdin or whitespace only. */
function isBlank(stdinText: string | undefined): boolean {
  return !stdinText || stdinText.trim() === '';
}

/** The JSON object in stdin, or null for blank, non-JSON, array and scalar text. */
function parseObject(stdinText: string | undefined): JsonObject | null {
  const payload = tryParseJson((stdinText ?? '').trim());
  return isJsonObject(payload) ? payload : null;
}

/** A string field of a parsed payload; null when there is no payload, the key is absent or the value is no string. */
function stringField(payload: JsonObject | null, key: string): string | null {
  const value = payload?.[key];
  return isJsonString(value) ? value : null;
}

function noPayloadInTime(label: string): CaptureReceipt<never> {
  return { status: 'unavailable', reason: `no ${label} payload arrived before the stdin wait window closed` };
}

function manualRun(runtime: string, event: CaptureEvent): CaptureReceipt {
  const input = { runtime, event, manual: true, sessionId: null, cwd: null, transcriptPath: null, trigger: null };
  return { status: 'received', input };
}

/** Reads a Claude Code PreCompact payload, or a Copilot one after stdin.ts mapped
 * it to the same snake_case keys; only an empty stdin counts as a manual run. */
export function readClaudeCodePreCompact(
  stdinText: string | undefined,
  timedOut: boolean,
  runtime: HookRuntime = 'claude-code',
): CaptureReceipt {
  const empty = isBlank(stdinText);
  if (timedOut && empty) return noPayloadInTime('PreCompact');
  if (empty) return manualRun(runtime, 'pre-compact');
  const payload = parseObject(stdinText);
  const transcriptPath = stringField(payload, 'transcript_path');
  // A bad payload is skipped, never treated as manual: discovery could pick up another session's transcript.
  if (transcriptPath === null) {
    return { status: 'skipped', reason: 'malformed or incomplete PreCompact payload (missing string transcript_path)' };
  }
  // Path shape only: CLAUDE_CONFIG_DIR can move the transcript root, and a same-user process can already read every
  // transcript.
  if (!/\.jsonl$/i.test(transcriptPath)) {
    return { status: 'skipped', reason: `payload transcript_path is not a .jsonl file: ${transcriptPath}` };
  }
  return {
    status: 'received',
    input: {
      runtime,
      event: 'pre-compact',
      manual: false,
      sessionId: stringField(payload, 'session_id'),
      cwd: stringField(payload, 'cwd'),
      transcriptPath,
      trigger: stringField(payload, 'trigger'),
    },
  };
}

/**
 * Reads VS Code's per-reply Stop payload. Pass the raw stdin: stdin.ts would give a Copilot CLI agentStop the same
 * snake_case keys.
 */
export function readVscodeStop(stdinText: string | undefined, timedOut: boolean): CaptureReceipt {
  if (isBlank(stdinText)) {
    return timedOut
      ? noPayloadInTime('Stop')
      : { status: 'skipped', reason: 'no payload: turn capture runs only from a VS Code Stop hook' };
  }
  const payload = parseObject(stdinText);
  if (stringField(payload, 'hook_event_name') !== 'Stop') {
    return { status: 'skipped', reason: 'not a VS Code Stop payload (no snake_case hook_event_name "Stop")' };
  }
  const transcriptPath = stringField(payload, 'transcript_path');
  if (transcriptPath === null || !/\.jsonl$/i.test(transcriptPath)) {
    return { status: 'skipped', reason: 'Stop payload names no .jsonl transcript_path' };
  }
  const sessionId = stringField(payload, 'session_id');
  if (!sessionId) return { status: 'skipped', reason: 'Stop payload has no session_id' };
  return {
    status: 'received',
    input: {
      runtime: 'vscode',
      event: 'turn-end',
      manual: false,
      sessionId,
      cwd: stringField(payload, 'cwd'),
      transcriptPath,
      trigger: null,
    },
  };
}

/** Reads a Claude Code PostCompact payload; it must name a session, but needs no transcript_path. */
export function readClaudeCodePostCompact(
  stdinText: string | undefined,
  timedOut: boolean,
): CaptureReceipt<PostCompactInput> {
  if (timedOut && isBlank(stdinText)) return noPayloadInTime('PostCompact');
  const payload = parseObject(stdinText);
  const sessionId = stringField(payload, 'session_id');
  if (!sessionId) return { status: 'skipped', reason: 'no PostCompact payload naming a session' };
  return {
    status: 'received',
    input: {
      runtime: 'claude-code',
      event: 'post-compact',
      manual: false,
      sessionId,
      cwd: stringField(payload, 'cwd'),
      transcriptPath: stringField(payload, 'transcript_path'),
      trigger: stringField(payload, 'trigger'),
      compactSummary: stringField(payload, 'compact_summary'),
    },
  };
}

/** Reads a Claude Code SessionEnd payload, or a Copilot one after stdin.ts mapped
 * it to the same snake_case keys; only an empty stdin counts as a manual run. */
export function readSessionEnd(
  stdinText: string | undefined,
  timedOut: boolean,
  runtime: HookRuntime = 'claude-code',
): CaptureReceipt {
  const empty = isBlank(stdinText);
  if (timedOut && empty) return noPayloadInTime('SessionEnd');
  if (empty) return manualRun(runtime, 'session-end');
  const payload = parseObject(stdinText);
  if (!payload) {
    return { status: 'skipped', reason: 'malformed SessionEnd payload (not a JSON object)' };
  }
  return {
    status: 'received',
    input: {
      runtime,
      event: 'session-end',
      manual: false,
      sessionId: stringField(payload, 'session_id') || null,
      cwd: stringField(payload, 'cwd'),
      transcriptPath: stringField(payload, 'transcript_path') || null,
      // Both hosts name a session end's trigger `reason`.
      trigger: stringField(payload, 'reason'),
    },
  };
}
