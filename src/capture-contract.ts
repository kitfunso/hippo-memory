// The shared shape every agent adapter turns a host payload into, so capture code is written once for all runtimes.
// Field meanings, statuses and how to add a runtime: docs/integrations/agent-inventory.md.

/** A host lifecycle moment hippo can capture from. */
export type CaptureEvent = 'prompt' | 'tool-failure' | 'pre-compact' | 'post-compact' | 'session-start' | 'session-end' | 'reset';

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
export type CaptureReceipt =
  | { readonly status: 'received'; readonly input: CaptureInput }
  | { readonly status: 'skipped' | 'unavailable'; readonly reason: string };

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

/** Reads a Claude Code PreCompact payload; only an empty stdin counts as a manual run. */
export function readClaudeCodePreCompact(stdinText: string | undefined, timedOut: boolean): CaptureReceipt {
  const empty = !stdinText || stdinText.trim() === '';
  if (timedOut && empty) {
    return { status: 'unavailable', reason: 'no PreCompact payload arrived before the stdin wait window closed' };
  }
  const base = { runtime: 'claude-code', event: 'pre-compact' as const };
  if (empty) {
    return { status: 'received', input: { ...base, manual: true, sessionId: null, cwd: null, transcriptPath: null, trigger: null } };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(stdinText.trim());
  } catch {
    // Non-JSON stdin leaves payload undefined, which the shape check rejects like an explicit null.
  }
  // A bad payload is skipped, never treated as manual: discovery could pick up another session's transcript.
  if (!isObjectLike(payload) || !('transcript_path' in payload) || !isStringValue(payload.transcript_path)) {
    return { status: 'skipped', reason: 'malformed or incomplete PreCompact payload (missing string transcript_path)' };
  }
  const transcriptPath = payload.transcript_path;
  // Path shape only: CLAUDE_CONFIG_DIR can move the transcript root, and a same-user process can already read every transcript.
  if (!/\.jsonl$/i.test(transcriptPath)) {
    return { status: 'skipped', reason: `payload transcript_path is not a .jsonl file: ${transcriptPath}` };
  }
  return {
    status: 'received',
    input: {
      ...base,
      manual: false,
      sessionId: 'session_id' in payload && isStringValue(payload.session_id) ? payload.session_id : null,
      cwd: 'cwd' in payload && isStringValue(payload.cwd) ? payload.cwd : null,
      transcriptPath,
      trigger: 'trigger' in payload && isStringValue(payload.trigger) ? payload.trigger : null,
    },
  };
}
