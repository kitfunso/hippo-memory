import * as fs from 'fs';
import * as path from 'path';
import { createMemory, Layer, type MemoryEntry } from '../memory.js';
import { duplicateKey, storedTextKeys } from '../same-text.js';
import { stampOriginProject } from '../store/entry-row.js';
import { isInitialized, openStore } from '../store/open.js';
import { writeEntryMirrors } from '../store/entry-writes.js';
import { loadAllEntries } from '../store/entry-reads.js';
import { updateStats } from '../store/index-and-stats.js';
import { gatedWrite } from '../gated-write.js';
import { getGlobalRoot, initGlobal } from '../shared.js';
import { embedMemory } from '../embeddings.js';
import { maskEmails, redactSecretsStrict } from '../secret-detect.js';
import { RejectedValueError, checkRejectionGuard } from '../rejection.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../db.js';
import { loadConfig } from '../config.js';
import { classifyOriginProject, projectId, type ProjectRef } from '../project-identity.js';
import { isStringValue } from '../capture-contract.js';
import { errorMessage, log } from '../log.js';
import { extractFromTexts, type ExtractedItem } from './extract.js';
import { type SessionTurn, collectSessionTurns, sessionTail, resolveLastSessionTranscript } from './transcript.js';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

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
  /**
   * Tee stdout/stderr to this log file while capture runs. Mirrors the
   * pattern used by `hippo sleep --log-file` so the SessionEnd hook output
   * (invisible during TUI teardown) can be surfaced via `hippo last-sleep`
   * on the next session start. Appends rather than truncates — `hippo sleep`
   * writes the same file first in the SessionEnd sequence.
   */
  logFile?: string;
  dryRun: boolean;
  global: boolean;
  /**
   * Tenant scope for the dedup read in `cmdCaptureCore`. When provided
   * AND `global` is false, the dedup check only considers this tenant's
   * existing memories. Undefined means host-wide dedup. Ignored when `global: true` (global captures are host-wide).
   */
  tenantId?: string;
  /** The session's project: rows are stamped with its id, and dedup reads its rows under either name. */
  originProject?: ProjectRef;
}

export function cmdCapture(
  hippoRoot: string,
  options: CaptureOptions
): void {
  // Tee stdout/stderr to a log file when --log-file is set. Used by the
  // SessionEnd hook so output (otherwise swallowed by TUI teardown) surfaces
  // on the next session start via `hippo last-sleep`. Runs second in the
  // SessionEnd sequence after `hippo sleep`, so we APPEND rather than
  // truncate — sleep already wrote its own header + body to this file.
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

/**
 * Append-mode tee: writes a banner line then mirrors every stdout/stderr
 * chunk to `logFile` until the returned restore function is called.
 * Failures to write the log are non-fatal; the real streams still get
 * the data.
 */
function beginLogTee(logFile: string): () => void {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(
      logFile,
      `[hippo] ${new Date().toISOString()} capturing session...\n`,
      'utf8'
    );
  } catch (err) {
    log.warn(`could not open log file ${logFile}: ${errorMessage(err)}`);
    return () => {};
  }

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const tee = (chunk: string | Uint8Array): void => {
    try {
      const buf = isStringValue(chunk) ? chunk : Buffer.from(chunk).toString('utf8');
      fs.appendFileSync(logFile, buf, 'utf8');
    } catch {
      // log failures are non-fatal
    }
  };
  // Node's `write` is overloaded (`(chunk, cb?)` vs `(chunk, encoding, cb?)`);
  // this wraps whichever of the two shapes was actually called, forwarding
  // to the same real stream method so runtime behaviour is unchanged.
  type StreamWriteArgs = [
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ];
  const wrapWrite = (origWrite: typeof process.stdout.write): typeof process.stdout.write => {
    const wrapped = (...args: StreamWriteArgs): boolean => {
      tee(args[0]);
      // SAFETY: forwarding the exact arguments Node's real overloaded
      // `write` received is safe regardless of which overload the call
      // site used — Node dispatches on the actual argument shapes at
      // runtime, and `StreamWriteArgs` is the union of both overloads'
      // parameter lists.
      return (origWrite as (...args: StreamWriteArgs) => boolean)(...args);
    };
    // SAFETY: `wrapped` matches both real `write` overload shapes it's
    // assigned to; TS can't verify a single implementation covers an
    // overloaded type, but this one forwards to the real stream method.
    return wrapped as typeof process.stdout.write;
  };
  process.stdout.write = wrapWrite(origStdoutWrite);
  process.stderr.write = wrapWrite(origStderrWrite);

  return () => {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  };
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

  // Dedup only against rows this capture's reader sees: another tenant's rows, or another
  // project's, are hidden from it, so they must not stop its own copy.
  const stored = loadAllEntries(targetRoot, useGlobal ? undefined : options.tenantId);
  const origin = options.originProject;
  const keys = storedTextKeys(origin === undefined
    ? stored
    : stored.filter((e) => classifyOriginProject(e.origin_project, origin) !== 'cross-project'));

  const { captured, skipped, rejected } = captureExtractedItems(targetRoot, options, extracted, keys);

  const prefix = options.dryRun ? '[dry-run] ' : '';
  const globalPrefix = useGlobal ? '[global] ' : '';
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

interface CaptureTally {
  captured: number;
  skipped: number;
  rejected: number;
}

function captureExtractedItems(
  targetRoot: string,
  options: CaptureOptions,
  extracted: ExtractedItem[],
  keys: Set<string>,
): CaptureTally {
  const tally: CaptureTally = { captured: 0, skipped: 0, rejected: 0 };
  const baseHalfLifeDays = loadConfig(targetRoot).defaultHalfLifeDays;

  // Dry run probes the same checkRejectionGuard the real write uses, on a read-only handle,
  // so a tombstoned item previews as rejected rather than captured.
  const dryRunDb = options.dryRun ? openHippoDb(targetRoot) : null;
  const writeDb = options.dryRun ? null : openStore(targetRoot);
  try {
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
  } finally {
    if (dryRunDb) closeHippoDb(dryRunDb);
    if (writeDb) closeHippoDb(writeDb);
  }
  return tally;
}

function captureEntry(item: ExtractedItem, options: CaptureOptions, baseHalfLifeDays: number): MemoryEntry {
  const useGlobal = options.global;
  // kind stays 'distilled': these are curated items, not raw transcript (see MEMORY_ENVELOPE.md).
  // The write tenant must match the dedup read's, or scoped dedup passes and the row lands in 'default'.
  const created = createMemory(item.content, {
    layer: Layer.Episodic,
    tags: item.tags,
    source: 'capture',
    confidence: 'observed',
    tenantId: useGlobal ? undefined : options.tenantId,
    baseHalfLifeDays,
  });
  return options.originProject === undefined ? created : { ...created, origin_project: projectId(options.originProject) };
}

interface CaptureWriteContext {
  targetRoot: string;
  options: CaptureOptions;
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
    const outcome = gatedWrite(writeDb, targetRoot, stamped);
    if (outcome === 'skipped:rejected') return 'rejected';
    if (outcome !== 'written') return 'skipped';
    writeEntryMirrors(targetRoot, stamped);
    updateStats(targetRoot, { remembered: 1 });
    keys.add(duplicateKey(item.content)); // within-batch dedup
    void embedMemory(targetRoot, entry);
  }
  return 'captured';
}
