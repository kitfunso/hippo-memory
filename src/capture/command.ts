import * as fs from 'fs';
import * as path from 'path';
import { createMemory, Layer, type MemoryEntry } from '../core/memory.js';
import { duplicateKey, longestWord, storedTextKeys } from '../util/same-text.js';
import { isInitialized } from '../store/open.js';
import { writeCapturedItems } from '../store/capture-write.js';
import { EVERY_SCOPE, loadTextsHoldingWords } from '../store/candidates.js';
import { getGlobalRoot, initGlobal } from '../sharing/global-store.js';
import { maskEmails, redactSecretsStrict } from '../util/secret-detect.js';
import { withRejectionProbe } from '../store/rejection-probe.js';
import { loadConfig } from '../core/config.js';
import { classifyOriginProject, projectId, type ProjectRef } from '../core/project-identity.js';
import { errorMessage, log } from '../util/log.js';
import { teeStdStreams } from '../util/stream-tee.js';
import { extractFromTexts, type ExtractedItem } from './extract.js';
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
  const { texts, userTexts } = read;

  if (texts.every((text) => text.trim().length === 0)) {
    console.log('No text to capture from.');
    return;
  }

  // Scrub once here, as the snapshot fields are: every source can carry a pasted token (AGENTS.md: no secrets in memories).
  const extracted = extractFromTexts(texts.map((text) => maskEmails(redactSecretsStrict(text))), userTexts);

  if (extracted.length === 0) {
    console.log('No actionable items found in the input.');
    return;
  }

  const keys = storedKeysInView(targetRoot, options, extracted);

  const writeOpts: CaptureWriteOptions = {
    dryRun: options.dryRun,
    tenantId: useGlobal ? undefined : options.tenantId,
    originProject: options.originProject,
    lean: false,
  };
  printCaptureTally(options, captureExtractedItems(targetRoot, writeOpts, extracted, keys));
}

// Dedup only against rows this capture's reader sees: another tenant's or project's rows are hidden, so they must not stop its own copy.
// Only a row holding an item's longest word can hold that item, so the store returns those rows and no others.
function storedKeysInView(targetRoot: string, options: CaptureOptions, extracted: readonly ExtractedItem[]): Set<string> {
  const stored = loadTextsHoldingWords(
    targetRoot, options.global ? undefined : options.tenantId, extracted.map((item) => longestWord(item.content)), undefined, EVERY_SCOPE,
  );
  const origin = options.originProject;
  return storedTextKeys(origin === undefined
    ? stored
    : stored.filter((e) => classifyOriginProject(e.origin_project, origin) !== 'cross-project'));
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

/** The raw texts for the chosen source, one per session turn, the person's turns first; null after printing why a last-session capture has nothing.
 *  Only a session says who spoke, so a piped or file capture counts no user texts. */
function readCaptureTexts(options: CaptureOptions): { texts: string[]; userTexts: number } | null {
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
      return { texts: [...users, ...assistants], userTexts: users.length };
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
}

export function captureExtractedItems(
  targetRoot: string,
  options: CaptureWriteOptions,
  extracted: readonly ExtractedItem[],
  keys: Set<string>,
): CaptureTally {
  const tally: CaptureTally = { captured: 0, skipped: 0, rejected: 0 };
  const baseHalfLifeDays = loadConfig(targetRoot).defaultHalfLifeDays;

  if (!options.dryRun) {
    const outcomes = writeCapturedItems(
      targetRoot,
      extracted.map((item) => ({ content: item.content, makeEntry: () => captureEntry(item, options, baseHalfLifeDays) })),
      keys,
      { actor: options.actor, lean: options.lean },
    );
    for (const outcome of outcomes) tally[outcome]++;
    return tally;
  }
  // Dry run probes the same checkRejectionGuard the real write uses, on a read-only handle,
  // so a tombstoned item previews as rejected rather than captured.
  return withRejectionProbe(targetRoot, (wouldReject) => {
    for (const item of extracted) {
      if (keys.has(duplicateKey(item.content))) {
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
  // SHORTCUT: every stated rule pins; cap or age these pins if a store's pins outgrow the hook budget.
  const created = createMemory(item.content, {
    layer: Layer.Episodic,
    tags: item.tags,
    source: 'capture',
    confidence: 'observed',
    pinned: item.fromUser === true && item.category === 'rule',
    tenantId: options.tenantId,
    source_session_id: options.sessionId,
    baseHalfLifeDays,
  });
  return options.originProject === undefined ? created : { ...created, origin_project: projectId(options.originProject) };
}
