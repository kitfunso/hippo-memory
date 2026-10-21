import * as fs from 'fs';
import * as path from 'path';
import { createMemory, Layer, type MemoryEntry } from '../../base/memory/memory.js';
import { duplicateKey, longestWord, storedTextKeys } from '../../base/util/same-text.js';
import { embedMemoryDetached, type EmbedTarget } from '../../domain/search/embed-memories.js';
import { maskEmails, redactSecretsStrict } from '../../base/util/secret-detect.js';
import type { HippoConfig } from '../../base/config/config.js';
import { projectId, projectNames, type ProjectRef, isInitialized } from '../../base/scope/project-identity.js';
import { errorMessage, log, errorFields } from '../../base/util/log.js';
import { teeStdStreams } from '../../base/util/stream-tee.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { extractFromTexts, type ExtractedItem } from './extract.js';
import { type SessionTurn, collectSessionTurns, sessionTail, resolveLastSessionTranscript } from './transcript.js';
import type { CaptureDedup, CapturedOutcome } from '../../store/port/capture.js';
import type { StoreGroups } from '../../store/port.js';

export interface CaptureOptions {
  source: 'stdin' | 'file' | 'last-session';
  filePath?: string;
  /** Explicit transcript path for `--last-session`. Without one, `stdinText` is used, then auto-discovery under
   * `<claude config dir>/projects/` on a manual run. */
  transcriptPath?: string;
  /** Read from stdin by the caller (cli.ts), which owns the bounded wait.
   * `stdinTimedOut` marks an empty read "unknown", not "no payload". */
  stdinText?: string;
  stdinTimedOut?: boolean;
  sessionTurns?: readonly SessionTurn[];
  /** Tee stdout/stderr to this log file while capture runs, so SessionEnd output (lost in TUI teardown) shows via
   *  `hippo last-sleep`.
   *  Appends, because `hippo sleep` writes the same file first. */
  logFile?: string | null;
  dryRun: boolean;
  global: boolean;
  /**
   * The caller's tenant: the dedup read counts only its memories, except under `global`, which counts every tenant's.
   */
  tenantId: string;
  /** The session's project: rows are stamped with its id, and dedup reads its rows under either name. */
  originProject?: ProjectRef;
}

/** The folder a capture writes to, the global one under `global`, and its store, which the CLI root builds. */
export interface CaptureTarget {
  readonly root: string;
  readonly config: HippoConfig;
  readonly store: Pick<StoreGroups, 'captures' | 'folderFiles' | 'rejections'>;
  /** Where each captured row's vector goes. */
  readonly index: EmbedTarget;
}

export async function runCapture(target: CaptureTarget, options: CaptureOptions): Promise<void> {
  // Tee to a log file for the SessionEnd hook; APPEND, because `hippo sleep` runs first in that sequence and already
  // wrote its header and body.
  const restoreStdio = options.logFile ? beginLogTee(options.logFile) : null;
  try {
    await runCaptureCore(target, options);
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
    fs.appendFileSync(logFile, `[hippo] ${new Date().toISOString()} capturing session...\n`, 'utf8');
  } catch (err) {
    log.warn(`could not open log file ${logFile}: ${errorMessage(err)}`, errorFields(err));
    return false;
  }
  return true;
}

// Console lines here are the `hippo capture` command's printed result, so they stay off the logger.
async function runCaptureCore(target: CaptureTarget, options: CaptureOptions): Promise<void> {
  if (options.global) {
    await target.store.folderFiles.ensure();
  } else if (!isInitialized(target.root)) {
    console.error(
      `No hippo store at ${target.root} (searched ${process.cwd()} and its parents up to your home directory). ` +
        `Run \`hippo init\` first.`,
    );
    // Set, not exit, so runCapture's finally restores the tee'd stdio.
    process.exitCode = 1;
    return;
  }

  const read = readCaptureTexts(options);
  if (read === null) return;
  const { texts, userTexts } = read;

  if (texts.every((text) => text.trim().length === 0)) {
    console.log('No text to capture from.');
    return;
  }

  // Scrub once here, as the snapshot fields are: every source can carry a pasted token (AGENTS.md: no secrets in
  // memories).
  const extracted = extractFromTexts(
    texts.map((text) => maskEmails(redactSecretsStrict(text))),
    userTexts,
  );

  if (extracted.length === 0) {
    console.log('No actionable items found in the input.');
    return;
  }

  const keys = await storedKeysInView(target.store, options, extracted);

  printCaptureTally(options, await captureFromCli(target, options, extracted, keys));
}

async function captureFromCli(
  { store, config, index }: CaptureTarget,
  options: CaptureOptions,
  extracted: readonly ExtractedItem[],
  keys: Set<string>,
): Promise<CaptureTally> {
  const writeOpts: CaptureWriteOptions = {
    tenantId: options.global ? undefined : options.tenantId,
    originProject: options.originProject,
    lean: false,
    dedup: captureDedup(options),
  };
  if (!options.dryRun) return captureExtractedItems({ store, config, index }, writeOpts, extracted, keys);
  return previewCapture(store, writeOpts, extracted, keys, config.defaultHalfLifeDays);
}

// Dedup only against rows this capture's reader sees: another tenant's or project's rows are hidden, so they must not
// stop its own copy.
// Only a row holding an item's longest word can hold that item, so the store returns those rows and no others.
async function storedKeysInView(
  store: Pick<StoreGroups, 'captures'>,
  options: CaptureOptions,
  extracted: readonly ExtractedItem[],
): Promise<Set<string>> {
  const { tenantId, ...filter } = captureDedup(options);
  const words = extracted.map((item) => longestWord(item.content));
  return storedTextKeys(await store.captures.textsHolding(tenantId, words, filter));
}

/** The rows a capture's dedup reads, as data, so the store's write can read them again in its own transaction. */
function captureDedup(options: CaptureOptions): CaptureDedup {
  const tenantId = options.global ? ALL_TENANTS : options.tenantId;
  const origin = options.originProject;
  // classifyOriginProject in SQL: a project with no id sees every row, any other its own names and user-global rows.
  if (origin === undefined || projectId(origin) === '') return { tenantId, everyScope: true };
  return { tenantId, everyScope: true, project: projectNames(origin) };
}

function printCaptureTally(options: CaptureOptions, { captured, skipped, rejected }: CaptureTally): void {
  const prefix = options.dryRun ? '[dry-run] ' : '';
  const globalPrefix = options.global ? '[global] ' : '';
  console.log(
    `\n${prefix}${globalPrefix}Captured ${captured} items (${skipped} skipped as duplicates` +
      (rejected > 0 ? `, ${rejected} rejected` : '') +
      ')',
  );
}

/** The raw texts for the chosen source, one per session turn, the person's turns first; null after printing why a
 *  last-session capture has nothing.
 *  Only a session says who spoke, so a piped or file capture counts no user texts. */
function readCaptureTexts(options: CaptureOptions): { texts: string[]; userTexts: number } | null {
  switch (options.source) {
    case 'stdin': {
      try {
        return { texts: [fs.readFileSync(0, 'utf8')], userTexts: 0 };
      } catch (err) {
        log.warn(`reading stdin failed: ${errorMessage(err)}`, errorFields(err));
        console.error('No input on stdin. Pipe text in or use --file <path>.');
        process.exitCode = 1;
        return null;
      }
    }
    case 'file': {
      if (!options.filePath) {
        console.error('Missing file path. Usage: hippo capture --file <path>');
        process.exitCode = 1;
        return null;
      }
      if (!fs.existsSync(options.filePath)) {
        console.error(`File not found: ${options.filePath}`);
        process.exitCode = 1;
        return null;
      }
      return { texts: [fs.readFileSync(options.filePath, 'utf8')], userTexts: 0 };
    }
    case 'last-session': {
      let turns = options.sessionTurns;
      if (!turns) {
        const resolved = resolveLastSessionTranscript(options.transcriptPath, options.stdinText, {
          mayScan: !options.stdinTimedOut,
        });
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
  readonly tenantId: string | undefined;
  readonly originProject: ProjectRef | undefined;
  readonly sessionId?: string;
  /** The audit actor; the CLI's own writes leave it out and audit as `cli`. */
  readonly actor?: string;
  /** No stats and no embedding, since embedding runs a model in a server process. */
  readonly lean: boolean;
  /** The rows the dedup read; the store's write reads them again before it writes. */
  readonly dedup: CaptureDedup;
}

/** A folder's store with the config its root loaded for this capture, and where its rows' vectors go. */
export interface ConfiguredStore {
  readonly store: Pick<StoreGroups, 'captures'>;
  readonly config: HippoConfig;
  readonly index: EmbedTarget;
}

/** The entries to write, and per item the entry whose outcome it takes, or -1 for a text the store already holds. */
interface CapturePlan {
  readonly entries: MemoryEntry[];
  readonly keys: string[];
  readonly slots: number[];
}

/** One entry per new text: building can throw, so a held text or a repeat within the batch is never built. */
function planCapture(
  extracted: readonly ExtractedItem[],
  held: ReadonlySet<string>,
  build: (item: ExtractedItem) => MemoryEntry,
): CapturePlan {
  const plan: CapturePlan = { entries: [], keys: [], slots: [] };
  const firstSlot = new Map<string, number>();
  for (const item of extracted) {
    const key = duplicateKey(item.content);
    let slot = held.has(key) ? -1 : firstSlot.get(key);
    if (slot === undefined) {
      slot = plan.entries.push(build(item)) - 1;
      plan.keys.push(key);
      firstSlot.set(key, slot);
    }
    plan.slots.push(slot);
  }
  return plan;
}

/** Writes each new text once; a repeat of a captured text in the same batch counts as skipped, as a held one does. */
export async function captureExtractedItems(
  { store, config, index }: ConfiguredStore,
  options: CaptureWriteOptions,
  extracted: readonly ExtractedItem[],
  keys: Set<string>,
): Promise<CaptureTally> {
  const plan = planCapture(extracted, keys, (item) => captureEntry(item, options, config.defaultHalfLifeDays));
  const { actor, lean, dedup } = options;
  const outcomes = await store.captures.write(plan.entries, { actor, lean, dedup });
  const tally: CaptureTally = { captured: 0, skipped: 0, rejected: 0 };
  const counted = new Set<number>();
  for (const slot of plan.slots) {
    const outcome: CapturedOutcome = slot === -1 ? 'skipped' : outcomes[slot];
    tally[counted.has(slot) && outcome === 'captured' ? 'skipped' : outcome]++;
    counted.add(slot);
  }
  outcomes.forEach((outcome, i) => {
    if (outcome !== 'captured') return;
    keys.add(plan.keys[i]);
    if (!options.lean) embedMemoryDetached(index, plan.entries[i]);
  });
  return tally;
}

/** A dry run asks the store the same rejected-value question the write's gate does, so a tombstoned item previews as
 * rejected rather than captured. */
async function previewCapture(
  { rejections }: Pick<StoreGroups, 'rejections'>,
  options: CaptureWriteOptions,
  extracted: readonly ExtractedItem[],
  keys: ReadonlySet<string>,
  baseHalfLifeDays: number,
): Promise<CaptureTally> {
  const tally: CaptureTally = { captured: 0, skipped: 0, rejected: 0 };
  const fresh = extracted.filter((item) => !keys.has(duplicateKey(item.content)));
  const refused = await rejections.refusedAmong(
    fresh.map((item) => {
      const entry = captureEntry(item, options, baseHalfLifeDays);
      return { tenantId: entry.tenantId, entryId: entry.id, content: entry.content };
    }),
  );
  let next = 0;
  for (const item of extracted) {
    if (keys.has(duplicateKey(item.content))) {
      tally.skipped++;
      console.log(`  [skip] (${item.category}) ${item.content.slice(0, 80)}`);
    } else if (refused[next++] === true) {
      console.log(`  [reject] (${item.category}) ${item.content.slice(0, 80)} - matches a rejected value`);
      tally.rejected++;
    } else {
      console.log(`  [capture] (${item.category}) ${item.content}`);
      tally.captured++;
    }
  }
  return tally;
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
    sourceSessionId: options.sessionId,
    baseHalfLifeDays,
  });
  if (options.originProject === undefined) return created;
  return { ...created, originProject: projectId(options.originProject) };
}
