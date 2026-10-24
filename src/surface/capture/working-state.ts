// A session's working state read from its transcript tail, with no store in the imports, so a hook with no store can
// derive it.
import * as fs from 'fs';
import { isObjectLike, isStringValue } from '../../base/session/capture-contract.js';
import { errorMessage } from '../../base/util/log.js';
import { tryParseJson } from '../../base/util/json.js';
import { workingStateOf, type WorkingState } from '../../domain/capture/working-state.js';
import { PRE_COMPACT_TAIL_BYTES, readTranscriptTail } from '../../infra/transcript-tail.js';
import { humanUserText, summariseTranscript } from './transcript.js';
import { copilotTurn } from './copilot-transcript.js';

type LineFlags = Parameters<typeof humanUserText>[0];
type LineMessage = Parameters<typeof humanUserText>[1];

/**
 * Newest main-agent `role` turn in a JSONL tail, from a Claude Code or a Copilot transcript; `textOf` reads a Claude
 * Code line, '' when it has no text.
 */
function lastTurnText(
  jsonl: string,
  role: 'user' | 'assistant',
  textOf: (entry: LineFlags, message: LineMessage) => string,
): string {
  const lines = jsonl.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    // The tail read can start mid-line; a torn fragment parses to nothing.
    const entry: unknown = tryParseJson(lines[i]);
    if (!isObjectLike(entry)) continue;
    if (!('type' in entry)) continue;
    const copilot = copilotTurn(entry);
    if (copilot?.role === role) return copilot.text;
    if (entry.type !== role) continue;
    // An isMeta line holds an earlier compact summary and an isSidechain one is a sub-agent turn; neither is this
    // session's own.
    if (('isMeta' in entry && entry.isMeta === true) || ('isSidechain' in entry && entry.isSidechain === true)) {
      continue;
    }
    const message = 'message' in entry && isObjectLike(entry.message) ? entry.message : undefined;
    if (!message) continue;
    const text = textOf(entry, message);
    if (text) return text;
  }
  return '';
}

/** The last text block of an assistant message, skipping thinking and tool_use blocks (as summariseTranscript does). */
function lastTextBlock(_entry: LineFlags, message: LineMessage): string {
  const content = message.content;
  if (!Array.isArray(content)) return '';
  for (let j = content.length - 1; j >= 0; j--) {
    const block = content[j];
    if (!isObjectLike(block)) continue;
    const blockText = 'type' in block && block.type === 'text' && 'text' in block ? block.text : undefined;
    if (isStringValue(blockText) && blockText.trim()) return blockText.trim();
  }
  return '';
}

/**
 * A session's task, summary and next step from its transcript tail, secrets scrubbed and capped, '' where none; null
 * with a logged reason when nothing is derivable. */
export function transcriptWorkingState(transcriptPath: string, log: (message: string) => void): WorkingState | null {
  let tail = '';
  let rawTask = '';
  let rawNextStep = '';
  try {
    // Compaction fires when a big tool_result lands, so the last human and assistant turns can sit megabytes back: grow
    // the window a bounded number of times until both turns are in it.
    const size = fs.statSync(transcriptPath).size;
    for (const cap of [PRE_COMPACT_TAIL_BYTES, PRE_COMPACT_TAIL_BYTES * 4, PRE_COMPACT_TAIL_BYTES * 16]) {
      if (cap > PRE_COMPACT_TAIL_BYTES) {
        log(`tail window grown to ${cap} bytes (last ${rawTask ? 'assistant' : 'user'} turn is further back)`);
      }
      tail = readTranscriptTail(transcriptPath, cap);
      rawTask = lastTurnText(tail, 'user', humanUserText);
      rawNextStep = lastTurnText(tail, 'assistant', lastTextBlock);
      if ((rawTask && rawNextStep) || size <= cap) break;
    }
  } catch (err) {
    log(`skip: could not read transcript tail: ${errorMessage(err)}`);
    return null;
  }

  const state = workingStateOf(rawTask, summariseTranscript(tail), rawNextStep);
  if (state === null) log('skip: empty summary');
  return state;
}
