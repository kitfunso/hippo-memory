import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  END_CHECK_LEAD,
  bashWritePaths,
  isBashWrite,
  type EndCheckScan,
} from '../../api/end-check.js';
import type { ScanPrompt, ValidityScan } from '../../api/validity.js';
import { isObjectLike, isStringValue } from '../../base/session/capture-contract.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { readSessionTranscript } from './session-digest.js';
import {
  collectSessionTurns,
  humanUserText,
  type TranscriptReadOptions,
  type TranscriptRecord,
} from './transcript.js';

const LAG_STEP_MS = 100;
const LAG_WAIT_MS = 500;
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SUBAGENT_FILE = /^agent-.+\.jsonl$/;

interface ToolCall {
  readonly id: string;
  readonly bash: string | null;
  readonly edit: string | null;
  readonly seq: number;
  readonly at: number;
}

interface FileRead {
  readonly calls: ToolCall[];
  readonly landed: Set<string>;
  readonly checks: string[];
  readonly prompts: ScanPrompt[];
  seq: number;
  promptSeq: number;
  promptAt: number | null;
  finalText: string;
}

interface ContentBlock {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
  readonly tool_use_id?: unknown;
  readonly is_error?: unknown;
}

interface ToolInput {
  readonly command?: unknown;
  readonly file_path?: unknown;
  readonly notebook_path?: unknown;
}

function blocksOf(record: TranscriptRecord): ContentBlock[] {
  const message = record.message;
  const content = isObjectLike(message) && 'content' in message ? message.content : undefined;
  return Array.isArray(content)
    ? content.filter((b): b is ContentBlock => isObjectLike(b) && 'type' in b)
    : [];
}

function timeOf(record: TranscriptRecord): number {
  return 'timestamp' in record && isStringValue(record.timestamp)
    ? Date.parse(record.timestamp)
    : NaN;
}

function editPath(name: string, input: ToolInput): string | null {
  const target = name === 'NotebookEdit' ? input.notebook_path : input.file_path;
  return isStringValue(target) ? target : null;
}

function toolCall(block: ContentBlock, seq: number, at: number): ToolCall | null {
  if (block.type !== 'tool_use' || !isStringValue(block.id)) return null;
  const name = isStringValue(block.name) ? block.name : '';
  const input: ToolInput = isObjectLike(block.input) ? block.input : {};
  if (name === 'Bash') {
    return isStringValue(input.command)
      ? { id: block.id, bash: input.command, edit: null, seq, at }
      : null;
  }
  const edit = EDIT_TOOLS.has(name) ? editPath(name, input) : null;
  return edit === null ? null : { id: block.id, bash: null, edit, seq, at };
}

function readResults(record: TranscriptRecord, read: FileRead): void {
  for (const block of blocksOf(record)) {
    if (
      block.type === 'tool_result' &&
      isStringValue(block.tool_use_id) &&
      block.is_error !== true
    ) {
      read.landed.add(block.tool_use_id);
    }
  }
}

function stopCheckText(record: TranscriptRecord): string | null {
  const hook = 'attachment' in record ? record.attachment : undefined;
  if (!isObjectLike(hook) || !('type' in hook) || hook.type !== 'hook_additional_context') {
    return null;
  }
  if (!('hookEvent' in hook) || hook.hookEvent !== 'Stop' || !('content' in hook)) return null;
  const parts = Array.isArray(hook.content) ? hook.content : [hook.content];
  const text = parts.filter((part) => isStringValue(part)).join('\n');
  return text.includes(END_CHECK_LEAD) ? text : null;
}

function visit(record: TranscriptRecord, read: FileRead, opts: TranscriptReadOptions): void {
  read.seq += 1;
  const at = timeOf(record);
  if (record.type === 'assistant') {
    for (const block of blocksOf(record)) {
      const call = toolCall(block, read.seq, at);
      if (call !== null) read.calls.push(call);
    }
    return;
  }
  if (record.type === 'attachment') {
    const check = stopCheckText(record);
    if (check !== null) read.checks.push(check);
    return;
  }
  if (record.type !== 'user') return;
  readResults(record, read);
  const message = record.message;
  const text = isObjectLike(message) ? humanUserText(record, message, opts) : '';
  if (text !== '') {
    read.promptSeq = read.seq;
    read.promptAt = at;
    read.prompts.push({ seq: read.seq, at, text });
  }
}

function readFile(file: string, opts: TranscriptReadOptions): FileRead {
  const read: FileRead = {
    calls: [],
    landed: new Set(),
    checks: [],
    prompts: [],
    seq: 0,
    promptSeq: 0,
    promptAt: null,
    finalText: '',
  };
  const jsonl = readSessionTranscript(file, (line) => log.debug(`end-check: ${line}`));
  const turns = collectSessionTurns(jsonl, (record) => visit(record, read, opts), opts);
  read.finalText = turns.filter((t) => t.role === 'assistant').at(-1)?.text ?? '';
  return read;
}

async function caughtUpRead(
  file: string,
  lastText: string,
  opts: TranscriptReadOptions,
): Promise<FileRead | null> {
  for (let waited = 0; ; waited += LAG_STEP_MS) {
    const read = readFile(file, opts);
    if (lastText === '' || read.finalText === lastText) return read;
    if (waited >= LAG_WAIT_MS) {
      log.debug(`end-check: ${file} still lacks the final message after ${LAG_WAIT_MS} ms`);
      return null;
    }
    await delay(LAG_STEP_MS);
  }
}

function subagentFiles(transcriptPath: string): string[] {
  const session = path.basename(transcriptPath, '.jsonl');
  const dir = path.join(path.dirname(transcriptPath), session, 'subagents');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => SUBAGENT_FILE.test(path.basename(name)))
    .sort()
    .map((name) => path.join(dir, name));
}

function editKey(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

function scanOf(main: FileRead, subagents: readonly FileRead[]): EndCheckScan {
  const sincePrompt = (read: FileRead, call: ToolCall): boolean =>
    read === main ? call.seq > main.promptSeq : main.promptAt === null || call.at > main.promptAt;
  const landed = [main, ...subagents].flatMap((read) =>
    read.calls
      .filter((call) => read.landed.has(call.id))
      .map((call) => ({ call, fresh: sincePrompt(read, call) })),
  );
  const commands = landed.flatMap(({ call }) => (call.bash === null ? [] : [call.bash]));
  const editsSincePrompt = landed.flatMap(({ call, fresh }) => {
    if (!fresh) return [];
    if (call.edit !== null) return [editKey(call.edit)];
    return call.bash === null ? [] : bashWritePaths(call.bash).map(editKey);
  });
  const bashWrite = landed.some(
    ({ call, fresh }) => fresh && call.bash !== null && isBashWrite(call.bash),
  );
  return {
    editsSincePrompt,
    editedSincePrompt: editsSincePrompt.length > 0 || bashWrite,
    commands,
    earlierChecks: main.checks.join('\n'),
  };
}

function commandsBefore(
  main: FileRead,
  subagents: readonly FileRead[],
  prompt: ScanPrompt,
): string[] {
  const calls = [main, ...subagents].flatMap((read) =>
    read.calls.filter(
      (call) =>
        call.bash !== null &&
        read.landed.has(call.id) &&
        (read === main ? call.seq < prompt.seq : call.at < prompt.at),
    ),
  );
  const timed = calls.every((call) => Number.isFinite(call.at));
  const ordered = timed ? [...calls].sort((a, b) => a.at - b.at) : calls;
  return ordered.flatMap((call) => (call.bash === null ? [] : [call.bash]));
}

export function scanForValidity(
  transcriptPath: string,
  opts: TranscriptReadOptions = {},
): ValidityScan {
  const main = readFile(transcriptPath, opts);
  const subagents = subagentFiles(transcriptPath).map((file) => readFile(file, opts));
  return {
    prompts: main.prompts,
    before: (prompt) => ({
      editsSincePrompt: [],
      editedSincePrompt: false,
      commands: commandsBefore(main, subagents, prompt),
      earlierChecks: '',
    }),
  };
}

export async function scanForEndCheck(
  transcriptPath: string,
  lastAssistantMessage: string | null,
  opts: TranscriptReadOptions = {},
): Promise<EndCheckScan | null> {
  try {
    const main = await caughtUpRead(transcriptPath, (lastAssistantMessage ?? '').trim(), opts);
    if (main === null) return null;
    const subagents = subagentFiles(transcriptPath).map((file) => readFile(file, opts));
    return scanOf(main, subagents);
  } catch (err) {
    log.warn(
      `end-check: ${transcriptPath} could not be read: ${errorMessage(err)}`,
      errorFields(err),
    );
    return null;
  }
}
