import * as fs from 'fs';
import * as path from 'path';
import { createMemory, Layer, USER_RULE_TAG, type MemoryEntry } from '../core/memory.js';
import { evalNow } from '../core/ablation.js';
import { duplicateKey, heldTextKeys, longestWord, storedTextKeys } from '../util/same-text.js';
import { ruleReplaces } from '../core/rule-replaces.js';
import { isCertainReason, storedDefect } from '../core/memory-quality.js';
import { writeCapturedItems } from '../store/capture-write.js';
import { embedMemory } from '../search/embed-memories.js';
import { EVERY_SCOPE, loadTextsHoldingWords, type HeldText } from '../store/candidates.js';
import { getGlobalRoot, initGlobal } from '../sharing/global-store.js';
import { maskEmails, redactSecretsStrict } from '../util/secret-detect.js';
import { withRejectionProbe } from '../store/rejection-probe.js';
import { isSharedStore, loadConfig } from '../core/config.js';
import { classifyOriginProject, projectId, projectNames, resolveProjectIdentity, type ProjectRef, isInitialized } from '../core/project-identity.js';
import { errorMessage, log } from '../util/log.js';
import { teeStdStreams } from '../util/stream-tee.js';
import { boldTwins, extractFromTexts, isStatedRule, oncePerText, type BoldTwin, type ExtractedItem } from './extract.js';
import { type SessionTurn, collectSessionTurns, sessionTail, resolveLastSessionTranscript } from './transcript.js';

export interface CaptureOptions {
  source: 'stdin' | 'file' | 'last-session';
  filePath?: string;
  /** Explicit transcript path for `--last-session`. Without one, `stdinText`
   * is used, then auto-discovery under `<claude config dir>/projects/` on a manual run. */
  transcriptPath?: string;
  /** Read from stdin by the caller (cli.ts), which owns the bounded wait.
   * `stdinTimedOut` marks an empty read "unknown", not "no payload". */
  stdinText?: string;
  stdinTimedOut?: boolean;
  sessionTurns?: readonly SessionTurn[];
  /** False when `sessionTurns` is a later slice of the session (a turn capture), so its first user turn answers the agent. */
  fromStart?: boolean;
  /** Tee stdout/stderr to this log file while capture runs, so SessionEnd output (lost in TUI teardown) shows via `hippo last-sleep`.
   *  Appends, because `hippo sleep` writes the same file first. */
  logFile?: string;
  dryRun: boolean;
  global: boolean;
  /** Tenant scope for the dedup read in `cmdCaptureCore`: when set and `global` is false, only this tenant's memories count.
   *  Undefined means host-wide dedup; ignored when `global: true`. */
  tenantId?: string;
  /** The session's project: rows are stamped with its id, and dedup reads its rows under either name. */
  originProject?: ProjectRef;
}

export function cmdCapture(
  hippoRoot: string,
  options: CaptureOptions
): void {
  // Tee to a log file for the SessionEnd hook; APPEND, because `hippo sleep` runs first in that sequence and already wrote its header and body.
  const restoreStdio = options.logFile ? beginLogTee(options.logFile) : null;
  try {
    cmdCaptureCore(hippoRoot, options);
    if (options.logFile) console.log('[hippo] capture complete');
  } catch (err) {
    if (options.logFile) console.log(`[hippo] capture failed: ${errorMessage(err)}`);
    throw err;
  } finally {
    if (restoreStdio) restoreStdio();
  }
}

/** Append-mode tee: mirror every stdout/stderr chunk to `logFile` until the returned restore function is called. */
function beginLogTee(logFile: string): () => void {
  if (!writeLogBanner(logFile)) return () => {};

  return teeStdStreams(logFile);
}

/** Creates the log's folder and appends the banner line; false, after a warning, when the log cannot be written. */
function writeLogBanner(logFile: string): boolean {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(
      logFile,
      `[hippo] ${new Date().toISOString()} capturing session...\n`,
      'utf8'
    );
  } catch (err) {
    log.warn(`could not open log file ${logFile}: ${errorMessage(err)}`);
    return false;
  }
  return true;
}

// Console lines here are the `hippo capture` command's printed result, so they stay off the logger.
function cmdCaptureCore(
  hippoRoot: string,
  options: CaptureOptions
): void {
  const useGlobal = options.global;
  const targetRoot = useGlobal ? getGlobalRoot() : hippoRoot;

  if (useGlobal) {
    initGlobal();
  } else {
    if (!isInitialized(hippoRoot)) {
      console.error(`No hippo store at ${hippoRoot} (searched ${process.cwd()} and its parents up to your home directory). Run \`hippo init\` first.`);
      process.exit(1);
    }
  }

  const read = readCaptureTexts(options);
  if (read === null) return;
  const { texts, userTexts, firstFollowUp } = read;

  if (texts.every((text) => text.trim().length === 0)) {
    console.log('No text to capture from.');
    return;
  }

  // Scrub the texts and again each item: bold removal can rebuild an address or key the first pass could not see (AGENTS.md: no secrets in memories).
  const scrub = (text: string): string => maskEmails(redactSecretsStrict(text));
  const scrubbed = texts.map(scrub);
  const extracted = scrubbedItems(extractFromTexts(scrubbed, userTexts, firstFollowUp), scrub);

  if (extracted.length === 0) {
    console.log('No actionable items found in the input.');
    return;
  }

  const ruleProject = ruleProjectNames(targetRoot, options.originProject);
  const held = storedKeysInView(targetRoot, options, ruleProject, extracted, boldTwins(scrubbed, scrub));

  const writeOpts: CaptureWriteOptions = {
    dryRun: options.dryRun,
    tenantId: useGlobal ? undefined : options.tenantId,
    originProject: options.originProject,
    lean: false,
    now: evalNow(),
  };
  printCaptureTally(options, captureExtractedItems(targetRoot, writeOpts, extracted, held.keys, held.ruleKeys, held.rows, ruleProject));
}

/** The items with `scrub` applied to each text, as a path stores them; scrubbing can make two items one, and the first stays unless a later one is the person's rule. */
export function scrubbedItems(items: readonly ExtractedItem[], scrub: (text: string) => string): ExtractedItem[] {
  return oncePerText(items.map((item) => ({ ...item, content: scrub(item.content) })));
}

/** Held keys, each twin's clean text too when a held row has its old text and repair keeps that row: a pinned row, or one whose text is no certain defect. */
export function heldKeysOf(rows: readonly HeldText[], twins: readonly BoldTwin[]): Set<string> {
  const keys = storedTextKeys(rows);
  for (const key of twinKeys(rows, twins)) keys.add(key);
  return keys;
}

/** The held keys that also stop a stated rule written for `ruleProject` (its names): every copy but one the store's write replaces, which holds the rule's exact text, so a bold twin still stops it. */
export function ruleHeldKeysOf(rows: readonly HeldText[], twins: readonly BoldTwin[], ruleProject: readonly string[]): Set<string> {
  const keys = storedTextKeys(rows.filter((row) => !ruleReplaces(row, ruleProject)));
  for (const key of twinKeys(rows, twins)) keys.add(key);
  return keys;
}

function twinKeys(rows: readonly HeldText[], twins: readonly BoldTwin[]): string[] {
  const keys = storedTextKeys(rows);
  const pinned = storedTextKeys(rows.filter((row) => row.pinned));
  return twins
    .filter(({ old }) => (isCertainReason(storedDefect(old)) ? pinned : keys).has(duplicateKey(old)))
    .map((twin) => duplicateKey(twin.clean));
}

/** The held keys, those that also stop a stated rule, and the rows they came from, whose ids the rule's write replaces. */
interface Held {
  readonly keys: Set<string>;
  readonly ruleKeys: ReadonlySet<string>;
  readonly rows: readonly HeldText[];
}

// Dedup only against rows this capture's reader sees: another tenant's or project's rows are hidden, so they must not stop its own copy.
// Only a row holding an item's longest word can hold that item, so the store returns those rows and no others.
function storedKeysInView(
  targetRoot: string, options: CaptureOptions, ruleProject: readonly string[], extracted: readonly ExtractedItem[], twins: readonly BoldTwin[],
): Held {
  // The lookup also asks for the lines as capture once stored them, with their bold markers.
  const texts = [...extracted.map((item) => item.content), ...twins.map((twin) => twin.old)];
  const stored = loadTextsHoldingWords(
    targetRoot, options.global ? undefined : options.tenantId, texts.map(longestWord), undefined, EVERY_SCOPE,
  );
  const origin = options.originProject;
  const rows = origin === undefined ? stored : stored.filter((e) => classifyOriginProject(e.origin_project, origin) !== 'cross-project');
  return { keys: heldKeysOf(rows, twins), ruleKeys: ruleHeldKeysOf(rows, twins, ruleProject), rows };
}

/** The names of the project a stated rule is written for, resolved once per capture: the project named, else the one the store stamps on a row that names none (the store folder's);
 * none for a shared or user-global store, whose rows no project context shows. */
function ruleProjectNames(targetRoot: string, origin: ProjectRef | undefined): readonly string[] {
  if (origin !== undefined) return projectId(origin) === '' ? [] : projectNames(origin);
  if (isSharedStore(targetRoot)) return [];
  const project = resolveProjectIdentity(path.dirname(path.resolve(targetRoot)));
  return projectId(project) === '' ? [] : projectNames(project);
}

function printCaptureTally(options: CaptureOptions, { captured, skipped, rejected }: CaptureTally): void {
  const prefix = options.dryRun ? '[dry-run] ' : '';
  const globalPrefix = options.global ? '[global] ' : '';
  console.log(
    `\n${prefix}${globalPrefix}Captured ${captured} items (${skipped} skipped as duplicates` +
      (rejected > 0 ? `, ${rejected} rejected` : '') +
      ')'
  );
}

/** Session texts: user turns before `firstFollowUp` are the request, the rest answer the agent. */
interface CaptureTexts {
  readonly texts: string[];
  readonly userTexts: number;
  readonly firstFollowUp?: number;
}

/** The raw texts for the chosen source, one per session turn, the person's turns first; null after printing why a last-session capture has nothing.
 *  Only a session says who spoke, so a piped or file capture counts no user texts. */
function readCaptureTexts(options: CaptureOptions): CaptureTexts | null {
  switch (options.source) {
    case 'stdin': {
      try {
        return { texts: [fs.readFileSync(0, 'utf8')], userTexts: 0 };
      } catch {
        console.error('No input on stdin. Pipe text in or use --file <path>.');
        process.exit(1);
      }
    }
    case 'file': {
      if (!options.filePath) {
        console.error('Missing file path. Usage: hippo capture --file <path>');
        process.exit(1);
      }
      if (!fs.existsSync(options.filePath)) {
        console.error(`File not found: ${options.filePath}`);
        process.exit(1);
      }
      return { texts: [fs.readFileSync(options.filePath, 'utf8')], userTexts: 0 };
    }
    case 'last-session': {
      let turns = options.sessionTurns;
      if (!turns) {
        const resolved = resolveLastSessionTranscript(options.transcriptPath, options.stdinText, { mayScan: !options.stdinTimedOut });
        if (!resolved) {
          console.log('No transcript found. Pass --transcript <path> or run from a SessionEnd hook.');
          return null;
        }
        turns = collectSessionTurns(fs.readFileSync(resolved, 'utf8'));
      }
      const { users, assistants } = sessionTail(turns);
      if (users.length === 0 && assistants.length === 0) {
        console.log('Transcript had no user/assistant messages to summarise.');
        return null;
      }
      // The first user turn is the request; a tail that cut it off, or a later slice, holds only replies.
      const allUsers = turns.filter((t) => t.role === 'user').length;
      const opener = options.fromStart !== false && users.length === allUsers ? 1 : 0;
      return { texts: [...users, ...assistants], userTexts: users.length, firstFollowUp: opener };
    }
  }
}

export interface CaptureTally {
  captured: number;
  skipped: number;
  rejected: number;
}

/** What a capture's rows carry. The CLI passes no tenant for the global store, so `global` never reaches the writes. */
export interface CaptureWriteOptions {
  readonly dryRun: boolean;
  readonly tenantId: string | undefined;
  readonly originProject: ProjectRef | undefined;
  readonly sessionId?: string;
  /** The audit actor; the CLI's own writes leave it out and audit as `cli`. */
  readonly actor?: string;
  /** No stats and no embedding, since embedding runs a model in a server process. */
  readonly lean: boolean;
  /** Stamps `created` on every row of the call, so one capture's rows share a time. */
  readonly now: Date;
}

/** Whether a held text stops `item`: any copy stops a note, only a `ruleKeys` copy a stated rule. */
function heldCheck(keys: ReadonlySet<string>, ruleKeys: ReadonlySet<string>): (item: ExtractedItem, key: string) => boolean {
  return (item, key) => (isStatedRule(item) ? ruleKeys : keys).has(key);
}

/** The ids of the held copies a stated rule replaces: the rows of `ruleProject` that `ruleReplaces` passes and that hold its text. */
function copiesTheRuleReplaces(rows: readonly HeldText[], content: string, ruleProject: readonly string[]): string[] {
  const key = duplicateKey(content);
  return rows.flatMap(({ id, ...row }) => (id !== undefined && ruleReplaces(row, ruleProject) && heldTextKeys(row).includes(key) ? [id] : []));
}

export function captureExtractedItems(
  targetRoot: string,
  options: CaptureWriteOptions,
  extracted: readonly ExtractedItem[],
  keys: Set<string>,
  ruleKeys: ReadonlySet<string> = keys,
  rows: readonly HeldText[] = [],
  ruleProject: readonly string[] = [],
): CaptureTally {
  const tally: CaptureTally = { captured: 0, skipped: 0, rejected: 0 };
  const baseHalfLifeDays = loadConfig(targetRoot).defaultHalfLifeDays;

  if (!options.dryRun) {
    const outcomes = writeCapturedItems(
      targetRoot,
      extracted.map((item) => ({
        content: item.content,
        makeEntry: () => captureEntry(item, options, baseHalfLifeDays),
        rule: isStatedRule(item),
        replaces: isStatedRule(item) ? copiesTheRuleReplaces(rows, item.content, ruleProject) : undefined,
      })),
      keys,
      { actor: options.actor, lean: options.lean, onCaptured: options.lean ? undefined : (entry) => void embedMemory(targetRoot, entry), ruleKeys },
    );
    for (const outcome of outcomes) tally[outcome]++;
    return tally;
  }
  // Dry run probes the same checkRejectionGuard the real write uses, on a read-only handle,
  // so a tombstoned item previews as rejected rather than captured.
  const held = heldCheck(keys, ruleKeys);
  return withRejectionProbe(targetRoot, (wouldReject) => {
    for (const item of extracted) {
      if (held(item, duplicateKey(item.content))) {
        tally.skipped++;
        console.log(`  [skip] (${item.category}) ${item.content.slice(0, 80)}`);
        continue;
      }
      const entry = captureEntry(item, options, baseHalfLifeDays);
      if (wouldReject(entry.tenantId ?? 'default', entry.id, entry.content)) {
        console.log(`  [reject] (${item.category}) ${item.content.slice(0, 80)} - matches a rejected value`);
        tally.rejected++;
        continue;
      }
      console.log(`  [capture] (${item.category}) ${item.content}`);
      tally.captured++;
    }
    return tally;
  });
}

function captureEntry(item: ExtractedItem, options: CaptureWriteOptions, baseHalfLifeDays: number): MemoryEntry {
  // kind stays 'distilled': these are curated items, not raw transcript (see MEMORY_ENVELOPE.md).
  // The write tenant must match the dedup read's, or scoped dedup passes and the row lands in 'default'.
  // A rule the person stated is pinned, so it injects even when a later prompt shares none of its words.
  // SHORTCUT: every stated rule pins; cap or age these pins if a store's pins outgrow the hook budget. The from-user tag marks the same pin as the
  // person's rule for the hooks.
  const stated = isStatedRule(item);
  const created = createMemory(item.content, {
    layer: Layer.Episodic,
    tags: stated ? [...item.tags, USER_RULE_TAG] : item.tags,
    source: 'capture',
    confidence: 'observed',
    pinned: stated,
    tenantId: options.tenantId,
    source_session_id: options.sessionId,
    baseHalfLifeDays,
  }, options.now);
  return options.originProject === undefined ? created : { ...created, origin_project: projectId(options.originProject) };
}
