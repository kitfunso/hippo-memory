// One memory per ended session, built without a model call from the agent's final message and the files it changed.
import * as fs from 'fs';
import * as path from 'path';
import { collectSessionTurns, type SessionTurn, type TranscriptRecord } from './transcript.js';
import { isObjectLike, isStringValue } from '../../base/session/capture-contract.js';
import { PATCH_SUCCESS_LINE, patchPaths, shellPatch } from './codex-patch.js';
import type { HippoConfig } from '../../base/config/config.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import { adminActor } from '../../api/types.js';
import {
  writeSessionDigest,
  type DigestOutcome,
  type DigestRepo,
  type DigestStore,
} from '../../api/memories/session-digest.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { tryParseJson } from '../../base/util/json.js';
import { isInitialized } from '../../base/scope/project-identity.js';
import { isSyntheticMessage } from '../../base/session/transcript-calls.js';
import { readOpenTranscriptTail } from '../../infra/transcript-tail.js';

/** Bounds a detached worker's memory; the final message sits at the end, so a tail read loses nothing. */
export const READ_CAP_BYTES = 64 * 1024 * 1024;

export interface DigestEdit {
  filePath: string;
  /** Working directory in effect at the call, for relative paths. */
  base: string | null;
}

export interface SessionScan {
  turns: SessionTurn[];
  finalText: string;
  /** The first working directory the transcript names: where the session ran. */
  cwd: string | null;
  /** Edits that landed, in call order. */
  edits: DigestEdit[];
}

/** Claude Code content blocks and Codex response items share these optional fields. */
interface TranscriptItem {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  phase?: unknown;
  name?: unknown;
  id?: unknown;
  text?: unknown;
  input?: unknown;
  arguments?: unknown;
  call_id?: unknown;
  output?: unknown;
  action?: unknown;
  cwd?: unknown;
  success?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
}

interface PendingEdit extends DigestEdit {
  callId: string;
}

interface ScanState {
  cwd: string | null;
  firstCwd: string | null;
  pending: PendingEdit[];
  landed: Set<string>;
  claudeFinal: string;
  codexFinal: string;
  codexUnphased: string;
}

const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function transcriptItem<T>(value: T): TranscriptItem | null {
  return isObjectLike(value) && 'type' in value ? value : null;
}

function itemsOf<T>(content: T): TranscriptItem[] {
  return Array.isArray(content) ? content.map(transcriptItem).filter((b): b is TranscriptItem => b !== null) : [];
}

function messageItems(record: TranscriptRecord): TranscriptItem[] {
  const message = record.message;
  return isObjectLike(message) && 'content' in message ? itemsOf(message.content) : [];
}

function noteCwd(state: ScanState, cwd: string): void {
  state.cwd = cwd;
  state.firstCwd ??= cwd;
}

function editTarget(block: TranscriptItem): string | null {
  const input = block.input;
  if (!isObjectLike(input)) return null;
  if (block.name === 'NotebookEdit') {
    return 'notebook_path' in input && isStringValue(input.notebook_path) ? input.notebook_path : null;
  }
  return 'file_path' in input && isStringValue(input.file_path) ? input.file_path : null;
}

function readClaudeAssistant(record: TranscriptRecord, state: ScanState): void {
  const blocks = messageItems(record);
  for (const block of blocks) {
    if (
      block.type !== 'tool_use' ||
      !isStringValue(block.name) ||
      !CLAUDE_EDIT_TOOLS.has(block.name) ||
      !isStringValue(block.id)
    ) {
      continue;
    }
    const target = editTarget(block);
    if (target) state.pending.push({ callId: block.id, filePath: target, base: state.cwd });
  }
  // Sidechain edits changed files, but a sub-agent's reply is not this session's closing message, nor is Claude Code's
  // own notice.
  if (record.isMeta === true || record.isSidechain === true || isSynthetic(record)) return;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const text = blocks[i].type === 'text' ? blocks[i].text : undefined;
    if (isStringValue(text) && text.trim()) {
      state.claudeFinal = text.trim();
      return;
    }
  }
}

function isSynthetic(record: TranscriptRecord): boolean {
  const message = record.message;
  return isObjectLike(message) && isSyntheticMessage(message);
}

function readClaudeResults(record: TranscriptRecord, state: ScanState): void {
  for (const block of messageItems(record)) {
    if (block.type === 'tool_result' && isStringValue(block.tool_use_id) && block.is_error !== true) {
      state.landed.add(block.tool_use_id);
    }
  }
}

function readCodexMessage(item: TranscriptItem, state: ScanState): void {
  if (item.role !== 'assistant') return;
  const text = itemsOf(item.content)
    .map((b) => (b.type === 'output_text' && isStringValue(b.text) ? b.text.trim() : ''))
    .filter(Boolean)
    .join('\n');
  if (!text) return;
  if (item.phase === 'final_answer') state.codexFinal = text;
  else if (item.phase === undefined || item.phase === null) state.codexUnphased = text;
}

function isAbsoluteAnywhere(p: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(p);
}

/** Absolute native form: drops a \\?\ prefix and maps Git Bash /c/... to C:\... on Windows. */
function nativePath(p: string): string {
  let s = p.replace(/^\\\\\?\\/, '');
  if (process.platform === 'win32') {
    const drive = /^\/([A-Za-z])(?=\/|$)/.exec(s);
    if (drive) s = `${drive[1].toUpperCase()}:${s.slice(2) || '/'}`;
  }
  return path.resolve(s);
}

/** p resolved against base; null for a relative path with no base to resolve it against. */
function resolveFrom(base: string | null, p: string): string | null {
  if (isNetworkPath(p)) return null;
  if (isAbsoluteAnywhere(p)) return nativePath(p);
  return base === null || isNetworkPath(base) ? null : path.resolve(nativePath(base), p);
}

function addPatch(state: ScanState, callId: string, body: string, base: string | null): void {
  for (const filePath of patchPaths(body)) state.pending.push({ callId, filePath, base });
}

function commandOf<T>(value: T): string[] | string | null {
  if (isStringValue(value)) return value;
  return Array.isArray(value) && value.every((a) => isStringValue(a)) ? value : null;
}

function addShellPatch<T>(state: ScanState, callId: string, command: T, workdir: string | null): void {
  const argv = commandOf(command);
  const patch = argv === null ? null : shellPatch(argv);
  if (!patch) return;
  const callDir = workdir === null ? state.cwd : resolveFrom(state.cwd, workdir);
  addPatch(state, callId, patch.body, patch.cd === null ? callDir : resolveFrom(callDir, patch.cd));
}

function readCodexFunctionCall(item: TranscriptItem, state: ScanState): void {
  if (!isStringValue(item.call_id) || !isStringValue(item.arguments)) return;
  // Codex stores the model's raw arguments; a malformed call ran nothing.
  const args: unknown = tryParseJson(item.arguments);
  if (!isObjectLike(args)) return;
  if (item.name === 'apply_patch') {
    if ('input' in args && isStringValue(args.input)) addPatch(state, item.call_id, args.input, state.cwd);
    return;
  }
  const command = 'command' in args ? args.command : 'cmd' in args ? args.cmd : undefined;
  const workdir = 'workdir' in args && isStringValue(args.workdir) ? args.workdir : null;
  addShellPatch(state, item.call_id, command, workdir);
}

function outputText<T>(output: T): string {
  return isStringValue(output) ? output : (JSON.stringify(output) ?? '');
}

function readCodexItem(item: TranscriptItem, state: ScanState): void {
  switch (item.type) {
    case 'message':
      readCodexMessage(item, state);
      return;
    case 'custom_tool_call':
      if (item.name === 'apply_patch' && isStringValue(item.call_id) && isStringValue(item.input)) {
        addPatch(state, item.call_id, item.input, state.cwd);
      }
      return;
    case 'function_call':
      readCodexFunctionCall(item, state);
      return;
    case 'local_shell_call': {
      const action = item.action;
      if (!isStringValue(item.call_id) || !isObjectLike(action) || !('command' in action)) return;
      const workdir =
        'working_directory' in action && isStringValue(action.working_directory) ? action.working_directory : null;
      addShellPatch(state, item.call_id, action.command, workdir);
      return;
    }
    case 'function_call_output':
    case 'custom_tool_call_output':
      if (isStringValue(item.call_id) && outputText(item.output).includes(PATCH_SUCCESS_LINE)) {
        state.landed.add(item.call_id);
      }
      return;
  }
}

function visitRecord(record: TranscriptRecord, state: ScanState): void {
  if (isStringValue(record.cwd)) noteCwd(state, record.cwd);
  if (record.type === 'assistant') return readClaudeAssistant(record, state);
  if (record.type === 'user') return readClaudeResults(record, state);
  const meta = record.payload;
  // Codex's session_meta and turn_context payloads carry no type of their own.
  if (record.type === 'session_meta' || record.type === 'turn_context') {
    if (isObjectLike(meta) && 'cwd' in meta && isStringValue(meta.cwd)) noteCwd(state, meta.cwd);
    return;
  }
  const payload = transcriptItem(meta);
  if (!payload) return;
  if (record.type === 'response_item') {
    readCodexItem(payload, state);
  } else if (
    record.type === 'event_msg' &&
    payload.type === 'patch_apply_end' &&
    payload.success === true &&
    isStringValue(payload.call_id)
  ) {
    state.landed.add(payload.call_id);
  }
}

/**
 * One pass over a Claude Code or Codex transcript: the turns capture reads, the closing message, and the edits that
 * landed.
 */
export function scanSessionTranscript(jsonl: string): SessionScan {
  const state: ScanState = {
    cwd: null,
    firstCwd: null,
    pending: [],
    landed: new Set(),
    claudeFinal: '',
    codexFinal: '',
    codexUnphased: '',
  };
  const turns = collectSessionTurns(jsonl, (record) => visitRecord(record, state));
  return {
    turns,
    finalText: state.claudeFinal || state.codexFinal || state.codexUnphased,
    cwd: state.firstCwd,
    // An unanswered call may never have run, so an edit counts only once its result says it applied.
    edits: state.pending.filter((e) => state.landed.has(e.callId)).map(({ filePath, base }) => ({ filePath, base })),
  };
}

export function readSessionTranscript(transcriptPath: string, log: (message: string) => void): string {
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= READ_CAP_BYTES) return fs.readFileSync(fd, 'utf8');
    log(`digest: transcript is ${size} bytes, reading its last ${READ_CAP_BYTES}`);
    return readOpenTranscriptTail(fd, size, READ_CAP_BYTES);
  } finally {
    fs.closeSync(fd);
  }
}

/** The transcript, read once and scanned, or null with the reason logged. */
export function readSessionScan(transcriptPath: string, log: (message: string) => void): SessionScan | null {
  try {
    return scanSessionTranscript(readSessionTranscript(transcriptPath, log));
  } catch (err) {
    log(`digest: could not read the transcript: ${errorMessage(err)}`);
    return null;
  }
}

/** A \\host or //host path would make existsSync open an SMB connection to a host named in transcript text. */
function isNetworkPath(p: string): boolean {
  return /^[\\/]{2}(?:(?![?.][\\/])|[?.][\\/]UNC[\\/])/i.test(p);
}

/**
 * The store root is realpath'd; transcript paths are not, and a deleted file has no realpath of its own. Null for a
 * network path.
 */
function realFsPath(p: string): string | null {
  if (isNetworkPath(p)) return null;
  const abs = nativePath(p);
  if (isNetworkPath(abs)) return null;
  const rest: string[] = [];
  let head = abs;
  while (!fs.existsSync(head)) {
    const parent = path.dirname(head);
    if (parent === head) return abs;
    rest.unshift(path.basename(head));
    head = parent;
  }
  return path.join(fs.realpathSync.native(head), ...rest);
}

/**
 * Repo-relative with forward slashes, '' for the root itself, null outside the repo or when the path cannot be
 * resolved.
 */
function repoRelative(p: string, repoRoot: string): string | null {
  let real: string | null;
  try {
    real = realFsPath(p);
  } catch (err) {
    // An unresolvable path counts as outside the repo: only that path is lost, never the digest.
    log.warnThenDebug('digest:realpath', 'digest: a changed path could not be resolved', errorFields(err));
    return null;
  }
  if (real === null) return null;
  const rel = path.relative(repoRoot, real);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function changedFiles(edits: readonly DigestEdit[], repoRoot: string): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const edit of edits) {
    const abs = resolveFrom(edit.base, edit.filePath);
    const rel = abs === null ? null : repoRelative(abs, repoRoot);
    if (!rel) continue;
    const key = process.platform === 'win32' ? rel.toLowerCase() : rel;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(rel);
  }
  return files;
}

export interface SessionDigestOptions {
  /** Session id, or the transcript's basename when the host gives none. */
  key: string;
  tenantId: string;
  /** The repo store's config, as the caller's Context holds it. */
  config: Pick<HippoConfig, 'defaultHalfLifeDays'>;
}

/** The repo under the store, read from disk for the digest's path checks. */
function diskRepo(hippoRoot: string, edits: readonly DigestEdit[]): DigestRepo {
  return {
    root: () => realFsPath(path.dirname(hippoRoot)),
    relative: repoRelative,
    changedFiles: (root) => changedFiles(edits, root),
  };
}

function writeScanDigest(
  hippoRoot: string,
  store: DigestStore,
  scan: SessionScan,
  opts: SessionDigestOptions,
): Promise<DigestOutcome> {
  return writeSessionDigest(
    { store, tenantId: opts.tenantId, config: opts.config, actor: adminActor(CLI_ACTOR) },
    {
      key: opts.key,
      prompts: scan.turns.filter((t) => t.role === 'user').map((t) => t.text),
      finalText: scan.finalText,
      cwd: scan.cwd,
      editCount: scan.edits.length,
      repo: diskRepo(hippoRoot, scan.edits),
    },
  );
}

export interface DigestRunOptions extends SessionDigestOptions {
  log: (message: string) => void;
}

/** Never throws: a digest failure must not block the handoff or the snapshot close. Logs carry no digest text. */
export async function recordSessionDigest(
  hippoRoot: string,
  store: DigestStore,
  scan: SessionScan | null,
  opts: DigestRunOptions,
): Promise<void> {
  // The digest names this repo's files, so it goes only to the repo's own store, never the global one.
  if (!isInitialized(hippoRoot)) {
    opts.log('digest: skip: this folder has no store of its own');
    return;
  }
  if (!scan) {
    opts.log('digest: skip: no transcript to read');
    return;
  }
  try {
    const outcome = await writeScanDigest(hippoRoot, store, scan, opts);
    opts.log(
      outcome.written
        ? `digest: wrote ${outcome.sentences} sentence(s), ${outcome.files} file(s) for ${opts.key}`
        : `digest: skip: ${outcome.reason}`,
    );
  } catch (err) {
    opts.log(`digest failed: ${errorMessage(err)}`);
  }
}
