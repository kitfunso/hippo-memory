// A session's working state read from its transcript tail, with no store in the imports, so a hook with no store can derive it.
import * as fs from 'fs';
import type { TaskSnapshot } from '../store/rows.js';
import { maskEmails, redactSecretsStrict } from '../secret-detect.js';
import { isObjectLike, isStringValue } from '../capture-contract.js';
import { errorMessage } from '../log.js';
import { PRE_COMPACT_TAIL_BYTES, readTranscriptTail, truncateCodePointSafe } from '../transcript-tail.js';
import { humanUserText, summariseTranscript } from './transcript.js';
import { copilotTurn } from './copilot-transcript.js';

export const PRE_COMPACT_TASK_CAP = 200;
export const PRE_COMPACT_SUMMARY_CAP = 2000;
export const PRE_COMPACT_NEXT_STEP_CAP = 500;
const TRIM_MARKER = '[...earlier turns trimmed]\n';

/** The longest each field of {@link transcriptWorkingState} can be, so a check of a sent working state imports these instead of copying them. */
export const WORKING_STATE_CAPS = {
  task: PRE_COMPACT_TASK_CAP,
  summary: PRE_COMPACT_SUMMARY_CAP + TRIM_MARKER.length,
  next_step: PRE_COMPACT_NEXT_STEP_CAP,
} as const;

export type WorkingState = Pick<TaskSnapshot, 'task' | 'summary' | 'next_step'>;

/** Cuts each field to {@link WORKING_STATE_CAPS}, for after a scrub, as a mask can run longer than what it hides. */
export function fitWorkingState(state: WorkingState): WorkingState {
  return {
    task: truncateCodePointSafe(state.task, WORKING_STATE_CAPS.task),
    // Only past the cap, since re-trimming a summary that fits would drop its head again; the cut keeps the newest turns.
    summary: state.summary.length > WORKING_STATE_CAPS.summary ? truncateKeepNewest(state.summary, PRE_COMPACT_SUMMARY_CAP) : state.summary,
    next_step: truncateCodePointSafe(state.next_step, WORKING_STATE_CAPS.next_step),
  };
}

/** Each empty field falls back to `existing`'s, since a tool-heavy tail derives no task; null when all are empty, so blanks never replace a snapshot.
 *  Never across sessions: another session's task saved under this id would pass compact-resume's session check. */
export function mergeWorkingState(derived: WorkingState, existing: TaskSnapshot | null, sessionId: string | null): WorkingState | null {
  const fallback = existing !== null && (existing.session_id === null || sessionId === null || existing.session_id === sessionId) ? existing : null;
  const merged = {
    task: derived.task || (fallback?.task ?? ''),
    summary: derived.summary || (fallback?.summary ?? ''),
    next_step: derived.next_step || (fallback?.next_step ?? ''),
  };
  return merged.task || merged.summary || merged.next_step ? merged : null;
}

/** Keeps the LAST maxChars behind a trim marker, aligned to a nearby line start: the summary runs oldest first, so a head cap would drop the newest working state. */
export function truncateKeepNewest(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let start = text.length - maxChars;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1; // never start on a low surrogate
  const nl = text.indexOf('\n', start);
  if (nl !== -1 && nl + 1 < text.length && nl - start < 200) start = nl + 1;
  return TRIM_MARKER + text.slice(start);
}

/** Most recent plain-text user message in a JSONL tail, from a Claude Code or a Copilot transcript. */
function lastPlainUserMessage(jsonl: string): string {
  const lines = jsonl.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // the tail read can start mid-line; skip the torn fragment
    }
    if (!isObjectLike(entry)) continue;
    if (!('type' in entry)) continue;
    const copilot = copilotTurn(entry);
    if (copilot?.role === 'user') return copilot.text;
    if (entry.type !== 'user') continue;
    // An isMeta user line holds an earlier compact summary and an isSidechain one is a sub-agent turn; neither is the human's task.
    if (('isMeta' in entry && entry.isMeta === true) || ('isSidechain' in entry && entry.isSidechain === true)) continue;
    const message = 'message' in entry && isObjectLike(entry.message) ? entry.message : undefined;
    if (!message) continue;
    const text = humanUserText(entry, message);
    if (text) return text;
  }
  return '';
}

/** Last assistant text block in a JSONL tail (skips thinking + tool_use, same as summariseTranscript). */
function lastAssistantTextBlock(jsonl: string): string {
  const lines = jsonl.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // the tail read can start mid-line; skip the torn fragment
    }
    if (!isObjectLike(entry)) continue;
    if (!('type' in entry)) continue;
    const copilot = copilotTurn(entry);
    if (copilot?.role === 'assistant') return copilot.text;
    if (entry.type !== 'assistant') continue;
    // Same meta/sidechain guard as lastPlainUserMessage: sub-agent turns
    // (isSidechain) are not this session's next step.
    if (('isMeta' in entry && entry.isMeta === true) || ('isSidechain' in entry && entry.isSidechain === true)) continue;
    const message = 'message' in entry && isObjectLike(entry.message) ? entry.message : undefined;
    if (!message) continue;
    const content = 'content' in message ? message.content : undefined;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (isObjectLike(block)) {
        const blockText = 'type' in block && block.type === 'text' && 'text' in block ? block.text : undefined;
        if (isStringValue(blockText) && blockText.trim()) {
          return blockText.trim();
        }
      }
    }
  }
  return '';
}

/** A session's task, summary and next step from its transcript tail, secrets scrubbed and capped, '' where none; null with a logged reason when nothing is derivable. */
export function transcriptWorkingState(transcriptPath: string, log: (message: string) => void): Pick<TaskSnapshot, 'task' | 'summary' | 'next_step'> | null {
  let tail = '';
  let rawTask = '';
  let rawNextStep = '';
  try {
    // Compaction fires when a big tool_result lands, so the last human and assistant turns can sit
    // megabytes back: grow the window a bounded number of times until both turns are in it.
    const size = fs.statSync(transcriptPath).size;
    for (const cap of [PRE_COMPACT_TAIL_BYTES, PRE_COMPACT_TAIL_BYTES * 4, PRE_COMPACT_TAIL_BYTES * 16]) {
      if (cap > PRE_COMPACT_TAIL_BYTES) log(`tail window grown to ${cap} bytes (last ${rawTask ? 'assistant' : 'user'} turn is further back)`);
      tail = readTranscriptTail(transcriptPath, cap);
      rawTask = lastPlainUserMessage(tail);
      rawNextStep = lastAssistantTextBlock(tail);
      if ((rawTask && rawNextStep) || size <= cap) break;
    }
  } catch (err) {
    log(`skip: could not read transcript tail: ${errorMessage(err)}`);
    return null;
  }

  const rawSummary = summariseTranscript(tail);
  if (!rawTask.trim() && !rawSummary.trim() && !rawNextStep.trim()) {
    log('skip: empty summary');
    return null;
  }

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
