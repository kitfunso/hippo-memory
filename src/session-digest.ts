// One memory per ended session, built without a model call from the agent's final message and the files it changed.
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { collectSessionTurns, type SessionTurn, type TranscriptRecord } from './capture/transcript.js';
import { splitSentences } from './capture/extract.js';
import { isObjectLike, isStringValue } from './capture-contract.js';
import { PATCH_SUCCESS_LINE, patchPaths, shellPatch } from './codex-patch.js';
import { loadConfig } from './config.js';
import { errorMessage } from './log.js';
import { createMemory, Layer, type MemoryEntry } from './memory.js';
import { RejectedValueError } from './rejection.js';
import { maskEmails, redactSecretsStrict } from './secret-detect.js';
import { isInitialized } from './store/open.js';
import { writeEntry } from './store/entry-writes.js';
import { loadAllEntries } from './store/entry-reads.js';
import { SNAPSHOT_AMBIENT_MAX_AGE_MS } from './store/sessions.js';
import { loadLatestHandoff } from './store/handoffs.js';
import { isSyntheticMessage } from './token-ledger.js';
import { readTranscriptTail } from './transcript-tail.js';

export const SESSION_DIGEST_TAG = 'session-digest';

/** Five-word runs are stock phrases; six in a row is a copied clause. */
export const ECHO_WINDOW = 6;
/** Five sentences of about 150 chars leave room for the Changed line inside the total cap. */
export const MAX_SENTENCES = 5;
/** A longer "sentence" in agent text is an unsplit list or pasted output. */
export const MAX_SENTENCE_CHARS = 300;
/** At about 20 chars per repo path this keeps the Changed line near 50 tokens. */
export const MAX_FILES = 10;
/** 300 tokens at 4 chars each: 20% of the 1500-token default budget of both context surfaces. */
export const MAX_DIGEST_CHARS = 1200;
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
  if (block.name === 'NotebookEdit') return 'notebook_path' in input && isStringValue(input.notebook_path) ? input.notebook_path : null;
  return 'file_path' in input && isStringValue(input.file_path) ? input.file_path : null;
}

function readClaudeAssistant(record: TranscriptRecord, state: ScanState): void {
  const blocks = messageItems(record);
  for (const block of blocks) {
    if (block.type !== 'tool_use' || !isStringValue(block.name) || !CLAUDE_EDIT_TOOLS.has(block.name) || !isStringValue(block.id)) continue;
    const target = editTarget(block);
    if (target) state.pending.push({ callId: block.id, filePath: target, base: state.cwd });
  }
  // Sidechain edits changed files, but a sub-agent's reply is not this session's closing message, nor is Claude Code's own notice.
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
    if (block.type === 'tool_result' && isStringValue(block.tool_use_id) && block.is_error !== true) state.landed.add(block.tool_use_id);
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
  let args: unknown;
  try {
    args = JSON.parse(item.arguments);
  } catch {
    return; // Codex stores the model's raw arguments; a malformed call ran nothing.
  }
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
      if (item.name === 'apply_patch' && isStringValue(item.call_id) && isStringValue(item.input)) addPatch(state, item.call_id, item.input, state.cwd);
      return;
    case 'function_call':
      readCodexFunctionCall(item, state);
      return;
    case 'local_shell_call': {
      const action = item.action;
      if (!isStringValue(item.call_id) || !isObjectLike(action) || !('command' in action)) return;
      const workdir = 'working_directory' in action && isStringValue(action.working_directory) ? action.working_directory : null;
      addShellPatch(state, item.call_id, action.command, workdir);
      return;
    }
    case 'function_call_output':
    case 'custom_tool_call_output':
      if (isStringValue(item.call_id) && outputText(item.output).includes(PATCH_SUCCESS_LINE)) state.landed.add(item.call_id);
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
  } else if (record.type === 'event_msg' && payload.type === 'patch_apply_end' && payload.success === true && isStringValue(payload.call_id)) {
    state.landed.add(payload.call_id);
  }
}

/** One pass over a Claude Code or Codex transcript: the turns capture reads, the closing message, and the edits that landed. */
export function scanSessionTranscript(jsonl: string): SessionScan {
  const state: ScanState = {
    cwd: null, firstCwd: null, pending: [], landed: new Set(), claudeFinal: '', codexFinal: '', codexUnphased: '',
  };
  const turns = collectSessionTurns(jsonl, (record) => visitRecord(record, state));
  return {
    turns,
    finalText: state.claudeFinal || state.codexFinal || state.codexUnphased,
    cwd: state.firstCwd,
    // An unanswered call may never have run, so an edit counts only once its result says it applied.
    edits: state.pending
      .filter((e) => state.landed.has(e.callId))
      .map(({ filePath, base }) => ({ filePath, base })),
  };
}

export function readSessionTranscript(transcriptPath: string, log: (message: string) => void): string {
  const size = fs.statSync(transcriptPath).size;
  if (size <= READ_CAP_BYTES) return fs.readFileSync(transcriptPath, 'utf8');
  log(`digest: transcript is ${size} bytes, reading its last ${READ_CAP_BYTES}`);
  return readTranscriptTail(transcriptPath, READ_CAP_BYTES);
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

let existsProbe: (p: string) => boolean = fs.existsSync;

/** Test-only seam, the scheduler's pattern: lets a test prove a network path never reaches the probe. Null restores it. */
export function __setDigestExistsProbe(probe: ((p: string) => boolean) | null): void {
  existsProbe = probe ?? fs.existsSync;
}

/** A \\host or //host path would make existsSync open an SMB connection to a host named in transcript text. */
function isNetworkPath(p: string): boolean {
  return /^[\\/]{2}(?:(?![?.][\\/])|[?.][\\/]UNC[\\/])/i.test(p);
}

/** The store root is realpath'd; transcript paths are not, and a deleted file has no realpath of its own. Null for a network path. */
export function realFsPath(p: string): string | null {
  if (isNetworkPath(p)) return null;
  const abs = nativePath(p);
  if (isNetworkPath(abs)) return null;
  const rest: string[] = [];
  let head = abs;
  while (!existsProbe(head)) {
    const parent = path.dirname(head);
    if (parent === head) return abs;
    rest.unshift(path.basename(head));
    head = parent;
  }
  return path.join(fs.realpathSync.native(head), ...rest);
}

/** Repo-relative with forward slashes, '' for the root itself, null outside the repo or when the path cannot be resolved. */
export function repoRelative(p: string, repoRoot: string): string | null {
  let rel: string;
  try {
    const real = realFsPath(p);
    if (real === null) return null;
    rel = path.relative(repoRoot, real);
  } catch {
    // SHORTCUT: an unresolvable path counts as outside the repo; only that path is lost, never the digest.
    return null;
  }
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

// A home-directory path names its user and the store may be shared, so such a sentence is dropped.
export const USER_SEGMENT: readonly RegExp[] = [
  /[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s]+/i,
  /(?<![\w.])(?:\/mnt)?\/[A-Za-z]\/Users\/[^/\s]+/i,
  /\\\\\?\\/,
  /(?<![\w.~-])(?:\/var)?\/home\/[^/\s]+/,
  /(?<![\w.~-])(?:\/var)?\/root(?![\w.-])/,
  /(?<![\w.~-])\/Users\/[^/\s]+/,
  /[\\/][A-Z0-9_$]{1,6}~\d{1,6}(?:\.[A-Z0-9]{1,3})?(?![\w~])|\b[A-Z0-9_$]{1,6}~\d{1,6}(?:\.[A-Z0-9]{1,3})?[\\/]/,
];

const ABSOLUTE_PATH = /(?<![\w.~/\\:-])(?:\\\\\?\\)?(?:[A-Za-z]:[\\/]|\/)[^\s`'"<>|*?()[\]{},;]+/g;

function rewriteRepoPaths(sentence: string, repoRoot: string): string {
  return sentence.replace(ABSOLUTE_PATH, (token) => {
    const trail = /[.:!]+$/.exec(token)?.[0] ?? '';
    const rel = repoRelative(token.slice(0, token.length - trail.length), repoRoot);
    return rel === null ? token : (rel || '.') + trail;
  });
}

/** Each opener points back to something named before the sentence; There, I, We and You do not. */
const OPENERS = new Set([
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their', 'he', 'she', 'his', 'her', 'here',
  'both', 'each', 'either', 'neither', 'such', 'which',
]);
const COUNTED_OPENER = /^(?:all|the|these|those|both)\s+\d/i;

/** Each anchor names a place in the code a later task can search for. */
const ANCHORS: readonly RegExp[] = [
  /`[^`]+`/,
  /\S[\\/]\S/,
  /\b[\w-]+\.[A-Za-z][A-Za-z0-9]{0,4}\b/,
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/,
  /\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/,
  /\b[A-Za-z_]\w*\(\)/,
  /(?:^|\s)--[a-z][\w-]*/,
  /(?:^|\s)#\d+\b/,
];
/** Each marker states a cause or a choice, the part of a lesson that transfers. */
const MARKERS =
  /\b(?:because|caused by|due to|root cause|the (?:bug|issue|problem) was|fail(?:s|ed) when|so that|otherwise|instead of|rather than|switched to|decided|chose|must|never|always|do not)\b/i;

const FENCE = /^\s*(`{3,}|~{3,})/;
const STRUCTURE_LINE = /^\s*(?:#{1,6}\s|\||>|([-*_])(?:\s*\1){2,}\s*$)/;
const PROTECTED = /`[^`\n]+`|\b(?:e\.g|i\.e)\./gi;

/** Prose lines of a markdown reply: code, headings, tables, quotes and rules are not sentences. */
function proseText(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const mark = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      continue;
    }
    if (mark) {
      fence = mark;
      continue;
    }
    if (STRUCTURE_LINE.test(line)) continue;
    kept.push(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/\*\*(.+?)\*\*/g, '$1'));
  }
  return kept.join('\n');
}

/** Sentences of the reply; code spans and "e.g." are held out of the split so their dots never end a sentence. */
export function digestSentences(text: string): string[] {
  const held: string[] = [];
  const masked = proseText(text).replace(PROTECTED, (m) => `\uE000${held.push(m) - 1}\uE001`);
  return splitSentences(masked)
    .map((s) => s.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => held[Number(i)]).trim())
    .filter(Boolean);
}

function echoTokens(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function echoWindows(texts: readonly string[]): Set<string> {
  const windows = new Set<string>();
  for (const text of texts) {
    const tokens = echoTokens(text);
    for (let i = 0; i + ECHO_WINDOW <= tokens.length; i++) windows.add(tokens.slice(i, i + ECHO_WINDOW).join(' '));
  }
  return windows;
}

function echoes(sentence: string, windows: ReadonlySet<string>): boolean {
  const tokens = echoTokens(sentence);
  for (let i = 0; i + ECHO_WINDOW <= tokens.length; i++) {
    if (windows.has(tokens.slice(i, i + ECHO_WINDOW).join(' '))) return true;
  }
  return false;
}

function opensOnReferent(sentence: string): boolean {
  const head = sentence.replace(/^[^\p{L}\p{N}]+/u, '');
  const word = /^\p{L}+/u.exec(head)?.[0].toLowerCase() ?? '';
  return OPENERS.has(word) || COUNTED_OPENER.test(head);
}

export function sentenceScore(sentence: string): number {
  const plain = sentence.replace(/\b(?:e\.g|i\.e)\./gi, '');
  return (ANCHORS.some((re) => re.test(plain)) ? 1 : 0) + (MARKERS.test(plain) ? 1 : 0);
}

interface Candidate {
  index: number;
  text: string;
  score: number;
}

/** Surviving sentences, best first: anchored or reasoned ones rank above the rest, earlier wins a tie. */
function rankedSentences(finalText: string, windows: ReadonlySet<string>, repoRoot: string): Candidate[] {
  const kept: Candidate[] = [];
  // Redact the whole reply before splitting and capping, so a secret is never cut into pieces that no pattern matches.
  digestSentences(maskEmails(redactSecretsStrict(finalText))).forEach((sentence, index) => {
    if (/[?:]$/.test(sentence) || opensOnReferent(sentence) || echoes(sentence, windows)) return;
    const text = rewriteRepoPaths(sentence, repoRoot);
    if (text.length > MAX_SENTENCE_CHARS || USER_SEGMENT.some((re) => re.test(text))) return;
    kept.push({ index, text, score: sentenceScore(text) });
  });
  return kept.sort((a, b) => b.score - a.score || a.index - b.index);
}

function changedLine(files: readonly string[]): string {
  for (let shown = Math.min(files.length, MAX_FILES); shown > 0; shown--) {
    const more = files.length - shown;
    const line = maskEmails(redactSecretsStrict(`Changed: ${files.slice(0, shown).join(', ')}${more > 0 ? ` (+${more} more)` : ''}`));
    if (line.length <= MAX_DIGEST_CHARS) return line;
  }
  return '';
}

export interface DigestSources {
  finalText: string;
  /** Text the session already holds: its own prompts, and what hippo injected into it. */
  echoTexts: readonly string[];
  edits: readonly DigestEdit[];
  repoRoot: string;
}

export interface DigestDraft {
  content: string;
  sentences: number;
  files: number;
}

/** The digest text, or null when nothing survives the filters. Sentences print in reply order. */
export function buildSessionDigest(sources: DigestSources): DigestDraft | null {
  const ranked = rankedSentences(sources.finalText, echoWindows(sources.echoTexts), sources.repoRoot);
  const files = changedFiles(sources.edits, sources.repoRoot);
  const changed = changedLine(files);
  // The cap drops whole sentences, lowest-ranked first, and keeps the Changed line.
  for (let kept = ranked.slice(0, MAX_SENTENCES); ; kept = kept.slice(0, -1)) {
    const lines = [...kept].sort((a, b) => a.index - b.index).map((c) => c.text);
    const content = [...lines, changed].filter(Boolean).join('\n');
    if (content.length > MAX_DIGEST_CHARS && kept.length > 0) continue;
    return content ? { content, sentences: kept.length, files: files.length } : null;
  }
}

/** Facts extracted from a digest and DAG summaries over one inherit its tag, but they are not the digest itself. */
export function isSessionDigestRow(entry: Pick<MemoryEntry, 'source' | 'tags' | 'extracted_from'>): boolean {
  return entry.source === SESSION_DIGEST_TAG && entry.tags.includes(SESSION_DIGEST_TAG) && !entry.extracted_from;
}

/** Same session, same row: a second worker for one session updates the digest instead of adding one. */
export function sessionDigestId(tenantId: string, key: string): string {
  return `mem_${createHash('sha256').update(`${SESSION_DIGEST_TAG}\n${tenantId}\n${key}`).digest('hex').slice(0, 12)}`;
}

export interface SessionDigestOptions {
  /** Session id, or the transcript's basename when the host gives none. */
  key: string;
  tenantId: string;
}

export interface DigestOutcome {
  written: boolean;
  reason: string;
  sentences: number;
  files: number;
}

/** What hippo could have injected into the session: any live digest (prompt recall reaches old ones) and the ambient handoff, never this session's own. */
function injectedTexts(hippoRoot: string, opts: SessionDigestOptions): string[] {
  const digests = loadAllEntries(hippoRoot, opts.tenantId)
    .filter((e) => isSessionDigestRow(e) && !e.superseded_by && e.source_session_id !== opts.key)
    .map((e) => e.content);
  const handoff = loadLatestHandoff(hippoRoot, opts.tenantId, undefined, {
    unfinishedOnly: true,
    maxAgeMs: SNAPSHOT_AMBIENT_MAX_AGE_MS,
    scopeFilter: 'default-deny',
    excludeSessionId: opts.key,
  });
  if (!handoff) return digests;
  return [...digests, [handoff.taskId, handoff.summary, handoff.nextAction].filter(Boolean).join('\n')];
}

function skipped(reason: string): DigestOutcome {
  return { written: false, reason, sentences: 0, files: 0 };
}

export function writeSessionDigest(hippoRoot: string, scan: SessionScan, opts: SessionDigestOptions): DigestOutcome {
  const prompts = scan.turns.filter((t) => t.role === 'user').map((t) => t.text);
  if (prompts.length === 0) return skipped('no human prompt');
  if (!scan.finalText.trim() && scan.edits.length === 0) return skipped('no final message and no edits');
  if (!scan.cwd) return skipped('the transcript names no working directory');
  const repoRoot = realFsPath(path.dirname(hippoRoot));
  if (repoRoot === null) return skipped('the repo is on a network path');
  if (repoRelative(scan.cwd, repoRoot) === null) return skipped('the session ran outside this repo');

  const draft = buildSessionDigest({
    finalText: scan.finalText,
    echoTexts: [...prompts, ...injectedTexts(hippoRoot, opts)],
    edits: scan.edits,
    repoRoot,
  });
  if (!draft) return skipped('nothing left after the filters');

  const entry: MemoryEntry = {
    ...createMemory(draft.content, {
      layer: Layer.Episodic,
      tags: [SESSION_DIGEST_TAG],
      source: SESSION_DIGEST_TAG,
      confidence: 'observed',
      source_session_id: opts.key,
      tenantId: opts.tenantId,
      baseHalfLifeDays: loadConfig(hippoRoot).defaultHalfLifeDays,
    }),
    id: sessionDigestId(opts.tenantId, opts.key),
  };
  try {
    writeEntry(hippoRoot, entry);
  } catch (err) {
    if (err instanceof RejectedValueError) return skipped('it matches a rejected value');
    throw err;
  }
  return { written: true, reason: '', sentences: draft.sentences, files: draft.files };
}

export interface DigestRunOptions extends SessionDigestOptions {
  log: (message: string) => void;
}

/** Never throws: a digest failure must not block the handoff or the snapshot close. Logs carry no digest text. */
export function recordSessionDigest(hippoRoot: string, scan: SessionScan | null, opts: DigestRunOptions): void {
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
    const outcome = writeSessionDigest(hippoRoot, scan, opts);
    opts.log(outcome.written
      ? `digest: wrote ${outcome.sentences} sentence(s), ${outcome.files} file(s) for ${opts.key}`
      : `digest: skip: ${outcome.reason}`);
  } catch (err) {
    opts.log(`digest failed: ${errorMessage(err)}`);
  }
}
