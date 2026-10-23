// The rules a session's working state follows once its fields are read: the scrub, the caps, the fit after a mask and
// the merge with a saved snapshot. Its caller reads the transcript.
import type { TaskSnapshot } from '../../store/port/sessions.js';
import { maskEmails, redactSecretsStrict } from '../../base/util/secret-detect.js';
import { truncateCodePointSafe } from '../../base/util/code-point-cut.js';

const PRE_COMPACT_TASK_CAP = 200;
const PRE_COMPACT_SUMMARY_CAP = 2000;
const PRE_COMPACT_NEXT_STEP_CAP = 500;
const TRIM_MARKER = '[...earlier turns trimmed]\n';

/** The longest each field of a derived working state can be, so a check of a sent working state imports these instead
 * of copying them. */
export const WORKING_STATE_CAPS = {
  task: PRE_COMPACT_TASK_CAP,
  summary: PRE_COMPACT_SUMMARY_CAP + TRIM_MARKER.length,
  next_step: PRE_COMPACT_NEXT_STEP_CAP,
} as const;

/** Published in snake_case, as a transcript read and a caller's request carry it; the port spells it camelCase. */
export type WorkingState = { task: string; summary: string; next_step: string };

/** A working state in the store port's field names. */
export type SnapshotFields = Pick<TaskSnapshot, 'task' | 'summary' | 'nextStep'>;

export function snapshotFields(state: WorkingState): SnapshotFields {
  return { task: state.task, summary: state.summary, nextStep: state.next_step };
}

/** Cuts each field to {@link WORKING_STATE_CAPS}, for after a scrub, as a mask can run longer than what it hides. */
export function fitWorkingState(state: WorkingState): WorkingState {
  return {
    task: truncateCodePointSafe(state.task, WORKING_STATE_CAPS.task),
    // Only past the cap, since re-trimming a summary that fits would drop its head again; the cut keeps the newest
    // turns.
    summary:
      state.summary.length > WORKING_STATE_CAPS.summary
        ? truncateKeepNewest(state.summary, PRE_COMPACT_SUMMARY_CAP)
        : state.summary,
    next_step: truncateCodePointSafe(state.next_step, WORKING_STATE_CAPS.next_step),
  };
}

/** Each empty field falls back to `existing`'s, since a tool-heavy tail derives no task, but never another session's,
 * which would pass compact-resume's session check; null when all are empty, so blanks never replace a snapshot. */
export function mergeWorkingState(
  derived: WorkingState,
  existing: TaskSnapshot | null,
  sessionId: string | null,
): SnapshotFields | null {
  const fallback =
    existing !== null && (existing.sessionId === null || sessionId === null || existing.sessionId === sessionId)
      ? existing
      : null;
  const merged = {
    task: derived.task || (fallback?.task ?? ''),
    summary: derived.summary || (fallback?.summary ?? ''),
    nextStep: derived.next_step || (fallback?.nextStep ?? ''),
  };
  return merged.task || merged.summary || merged.nextStep ? merged : null;
}

/**
 * Keeps the LAST maxChars behind a trim marker, aligned to a nearby line start: the summary runs oldest first, so a
 * head cap would drop the newest working state. */
export function truncateKeepNewest(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let start = text.length - maxChars;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1; // never start on a low surrogate
  const nl = text.indexOf('\n', start);
  if (nl !== -1 && nl + 1 < text.length && nl - start < 200) start = nl + 1;
  return TRIM_MARKER + text.slice(start);
}

/**
 * The working state of a session's raw last user turn, summary and last reply: secrets scrubbed and capped, '' where
 * none; null when all three are blank. */
export function workingStateOf(rawTask: string, rawSummary: string, rawNextStep: string): WorkingState | null {
  if (!rawTask.trim() && !rawSummary.trim() && !rawNextStep.trim()) return null;
  // These fields skip the capture content gate and reach a prompt, so the strict scrub runs. The caps protect the
  // re-injection token budget and never split a surrogate pair; `hippo snapshot save` stays uncapped.
  const task = maskEmails(redactSecretsStrict(rawTask));
  const summary = maskEmails(redactSecretsStrict(rawSummary));
  const nextStep = maskEmails(redactSecretsStrict(rawNextStep));
  return {
    task: task.trim() ? truncateCodePointSafe(task, PRE_COMPACT_TASK_CAP) : '',
    summary: summary.trim() ? truncateKeepNewest(summary, PRE_COMPACT_SUMMARY_CAP) : '',
    next_step: nextStep.trim() ? truncateCodePointSafe(nextStep, PRE_COMPACT_NEXT_STEP_CAP) : '',
  };
}
