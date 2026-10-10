import * as fs from 'fs';
import * as path from 'path';
import { createMemory, Layer, type MemoryEntry } from '../core/memory.js';
import { duplicateKey, longestWord, storedTextKeys } from '../util/same-text.js';
import { stampOriginProject } from '../store/entry-row.js';
import { isInitialized, withCaptureHandles } from '../store/open.js';
import { writeEntryMirrors } from '../store/entry-writes.js';
import { EVERY_SCOPE, loadTextsHoldingWords } from '../store/candidates.js';
import { updateStatsOn } from '../store/index-and-stats.js';
import { gatedWrite } from '../trust/gated-write.js';
import { getGlobalRoot, initGlobal } from '../sharing/global-store.js';
import { embedMemory } from '../store/embeddings/index.js';
import { maskEmails, redactSecretsStrict } from '../util/secret-detect.js';
import { RejectedValueError, checkRejectionGuard } from '../store/rejection.js';
import type { DatabaseSyncLike } from '../db/index.js';
import { loadConfig } from '../core/config.js';
import { classifyOriginProject, projectId, type ProjectRef } from '../core/project-identity.js';
import { isStringValue } from '../core/capture-contract.js';
import { errorMessage, log } from '../util/log.js';
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

/** Append-mode tee: mirror every stdout/stderr chunk to `logFile` until the returned restore function is called; a log-write failure is non-fatal. */
function beginLogTee(logFile: string): () => void {
  if (!writeLogBanner(logFile)) return () => {};

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const tee = (chunk: string | Uint8Array): void => appendToLog(logFile, chunk);
  // Node's `write` is overloaded (`(chunk, cb?)` vs `(chunk, encoding, cb?)`); this forwards whichever shape was called to the real method.
  type StreamWriteArgs = [
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ];
  const wrapWrite = (origWrite: typeof process.stdout.write): typeof process.stdout.write => {
    const wrapped = (...args: StreamWriteArgs): boolean => {
      tee(args[0]);
      // SAFETY: forwarding the exact arguments the real overloaded `write` received is safe; `StreamWriteArgs` is the union of both overloads' parameter lists.
      return (origWrite as (...args: StreamWriteArgs) => boolean)(...args);
    };
    // SAFETY: `wrapped` matches both real `write` overload shapes; TS cannot verify one implementation covers an overloaded type.
    return wrapped as typeof process.stdout.write;
  };
  process.stdout.write = wrapWrite(origStdoutWrite);
  process.stderr.write = wrapWrite(origStderrWrite);

  return () => {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  };
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

function appendToLog(logFile: string, chunk: string | Uint8Array): void {
  try {
    const buf = isStringValue(chunk) ? chunk : Buffer.from(chunk).toString('utf8');
    fs.appendFileSync(logFile, buf, 'utf8');
  } catch {
    // log failures are non-fatal
  }
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

  const texts = readCaptureTexts(options);
  if (texts === null) return;

  if (texts.every((text) => text.trim().length === 0)) {
    console.log('No text to capture from.');
    return;
  }

  // Scrub once here, as the snapshot fields are: every source can carry a pasted token (AGENTS.md: no secrets in memories).
  const extracted = extractFromTexts(texts.map((text) => maskEmails(redactSecretsStrict(text))));

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

/** The raw texts for the chosen source, one per session turn; null after printing why a last-session capture has nothing. */
function readCaptureTexts(options: CaptureOptions): string[] | null {
  switch (options.source) {
    case 'stdin': {
      try {
        return [fs.readFileSync(0, 'utf8')];
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
      return [fs.readFileSync(options.filePath, 'utf8')];
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
      return [...users, ...assistants];
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

  // Dry run probes the same checkRejectionGuard the real write uses, on a read-only handle,
  // so a tombstoned item previews as rejected rather than captured.
  withCaptureHandles(targetRoot, options.dryRun, (dryRunDb, writeDb) => {
    for (const item of extracted) {
      if (keys.has(duplicateKey(item.content))) {
        tally.skipped++;
        if (options.dryRun) {
          console.log(`  [skip] (${item.category}) ${item.content.slice(0, 80)}`);
        }
        continue;
      }
      const entry = captureEntry(item, options, baseHalfLifeDays);
      tally[captureOne({ targetRoot, options, dryRunDb, writeDb, keys }, item, entry)]++;
    }
  });
  return tally;
}

function captureEntry(item: ExtractedItem, options: CaptureWriteOptions, baseHalfLifeDays: number): MemoryEntry {
  // kind stays 'distilled': these are curated items, not raw transcript (see MEMORY_ENVELOPE.md).
  // The write tenant must match the dedup read's, or scoped dedup passes and the row lands in 'default'.
  const created = createMemory(item.content, {
    layer: Layer.Episodic,
    tags: item.tags,
    source: 'capture',
    confidence: 'observed',
    tenantId: options.tenantId,
    source_session_id: options.sessionId,
    baseHalfLifeDays,
  });
  return options.originProject === undefined ? created : { ...created, origin_project: projectId(options.originProject) };
}

interface CaptureWriteContext {
  targetRoot: string;
  options: CaptureWriteOptions;
  dryRunDb: DatabaseSyncLike | null;
  writeDb: DatabaseSyncLike | null;
  keys: Set<string>;
}

/** Previews or writes one non-duplicate item and names the tally it counts toward. */
function captureOne(ctx: CaptureWriteContext, item: ExtractedItem, entry: MemoryEntry): keyof CaptureTally {
  const { targetRoot, options, dryRunDb, writeDb, keys } = ctx;
  if (options.dryRun) {
    if (dryRunDb) {
      try {
        checkRejectionGuard(dryRunDb, entry.tenantId ?? 'default', entry.id, entry.content);
      } catch (err) {
        if (err instanceof RejectedValueError) {
          console.log(`  [reject] (${item.category}) ${item.content.slice(0, 80)} - matches a rejected value`);
          return 'rejected';
        }
        throw err;
      }
    }
    console.log(`  [capture] (${item.category}) ${item.content}`);
  } else if (writeDb !== null) {
    // One rejected item must not abort the rest of this capture's items.
    const stamped = stampOriginProject(targetRoot, entry);
    const outcome = gatedWrite(writeDb, targetRoot, stamped, { actor: options.actor });
    if (outcome === 'skipped:rejected') return 'rejected';
    if (outcome !== 'written') return 'skipped';
    writeEntryMirrors(targetRoot, stamped);
    if (!options.lean) updateStatsOn(writeDb, targetRoot, { remembered: 1 });
    keys.add(duplicateKey(item.content)); // within-batch dedup
    if (!options.lean) void embedMemory(targetRoot, entry);
  }
  return 'captured';
}
