import * as fs from 'node:fs';
import * as path from 'node:path';
import { createMemory, Layer, USER_RULE_TAG, type MemoryEntry } from '../../base/memory/entry.js';
import { duplicateKey, storedTextKeys } from '../../base/util/same-text.js';
import { ruleReplaces } from '../../base/memory/rule-replaces.js';
import { isCertainReason, storedDefect } from '../../base/memory/memory-quality.js';
import { maskEmails, redactSecretsStrict } from '../../base/util/secret-detect.js';
import type { HippoConfig } from '../../base/config/config.js';
import { projectId, projectNames, type ProjectRef } from '../../base/scope/project-identity.js';
import { isInitialized } from '../../host/project-identity.js';
import { errorMessage, log, errorFields, type LineLog } from '../../base/util/log.js';
import { teeStdStreams } from '../../host/stream-tee.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import {
  boldTwins,
  extractFromTexts,
  isStatedRule,
  oncePerText,
  type BoldTwin,
  type ExtractedItem,
} from './extract.js';
import { followUpRules, usageLine, withFollowUpRules, type FollowUpRule } from './follow-up.js';
import {
  type SessionTurn,
  collectSessionTurns,
  sessionTail,
  resolveLastSessionTranscript,
} from './transcript.js';
import type { CaptureDedup, CapturedOutcome } from '../../base/ports/store/capture.js';
import type { HeldText } from '../../base/ports/store/types.js';
import type { StoreGroups } from '../../base/ports/store.js';
import type { Llm } from '../../base/ports/llm.js';
import { PRIVATE_DIR } from '../../host/private-dir.js';
import { evalClock } from '../../infra/eval-switches.js';

export interface CaptureOptions {
  source: 'stdin' | 'file' | 'last-session';
  filePath?: string;
  /** Explicit transcript path for `--last-session`. Without one, `stdinText` is used, then
   * auto-discovery under `<claude config dir>/projects/` on a manual run. */
  transcriptPath?: string;
  /** Read from stdin by the caller (cli.ts), which owns the bounded wait.
   * `stdinTimedOut` marks an empty read "unknown", not "no payload". */
  stdinText?: string;
  stdinTimedOut?: boolean;
  sessionTurns?: readonly SessionTurn[];
  /** False when `sessionTurns` is a later slice of the session (a turn capture), so its first user
   * turn answers the agent. */
  fromStart?: boolean;
  /** Tee stdout/stderr to this log file while capture runs, so SessionEnd output (lost in TUI teardown) shows via
   *  `hippo last-sleep`.
   *  Appends, because `hippo sleep` writes the same file first. */
  logFile?: string | null;
  dryRun: boolean;
  global: boolean;
  /**
   * The caller's tenant: the dedup read counts only its memories, except under `global`, which
   * counts every tenant's.
   */
  tenantId: string;
  /** The session's project: rows are stamped with its id, and dedup reads its rows under either
   * name. */
  originProject?: ProjectRef;
}

/** The folder a capture writes to, the global one under `global`, and its store, which the CLI
 * root builds. */
export interface CaptureTarget {
  readonly root: string;
  readonly config: HippoConfig;
  readonly store: Pick<StoreGroups, 'captures' | 'folderFiles' | 'rejections'>;
  /** Embeds each captured row, off the capture's path. */
  readonly embed: (entry: MemoryEntry) => void;
  /** Picks the rules in the person's follow-up turns; without it capture reads word patterns only. */
  readonly llm?: Llm;
  /** Why no `llm` came when the config asked for one; printed inside the capture's log. */
  readonly llmMissing?: string;
}

export async function runCapture(target: CaptureTarget, options: CaptureOptions): Promise<void> {
  // Tee to a log file for the SessionEnd hook; APPEND, because `hippo sleep` runs first in that
  // sequence and already wrote its header and body.
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

/** Append-mode tee: mirror every stdout/stderr chunk to `logFile` until the returned restore
 * function is called. */
function beginLogTee(logFile: string): () => void {
  if (!writeLogBanner(logFile)) return () => {};

  return teeStdStreams(logFile);
}

/** Creates the log's folder and appends the banner line; false, after a warning, when the log
 * cannot be written. */
function writeLogBanner(logFile: string): boolean {
  try {
    fs.mkdirSync(path.dirname(logFile), PRIVATE_DIR);
    fs.appendFileSync(
      logFile,
      `[hippo] ${new Date().toISOString()} capturing session...\n`,
      'utf8',
    );
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
  const { texts, userTexts, firstFollowUp, followUps } = read;

  if (texts.every((text) => text.trim().length === 0)) {
    console.log('No text to capture from.');
    return;
  }

  // Scrub the texts and again each item: bold removal can rebuild an address or key the first
  // pass could not see (AGENTS.md: no secrets in memories).
  const scrub = (text: string): string => maskEmails(redactSecretsStrict(text));
  const scrubbed = texts.map(scrub);
  const dedup = await captureDedup(target.store.folderFiles, options);
  const rules = await modelRules(target, dedup, followUps);
  const patterned = extractFromTexts(scrubbed, userTexts, firstFollowUp);
  const extracted = scrubbedItems(withFollowUpRules(patterned, rules, scrub), scrub);

  if (extracted.length === 0) {
    console.log('No actionable items found in the input.');
    return;
  }

  const held = await storedKeysInView(target.store, dedup, extracted, boldTwins(scrubbed, scrub));

  printCaptureTally(options, await captureFromCli(target, options, dedup, extracted, held));
}

const warnLine: LineLog = (line, opts) => log.warn(line, opts?.fields);

/** The rules the model finds in the person's later turns, when the target has one. */
async function modelRules(
  { llm, llmMissing }: CaptureTarget,
  { ruleProject = [] }: CaptureDedup,
  followUps: readonly string[],
): Promise<readonly FollowUpRule[]> {
  // A rule with no project to belong to would pin into every project.
  if (ruleProject.length === 0) return [];
  if (!llm) {
    if (llmMissing) warnLine(llmMissing);
    return [];
  }
  const { rules, usage } = await followUpRules(followUps, llm, warnLine);
  if (usage) console.log(usageLine(usage));
  return rules;
}

async function captureFromCli(
  { store, config, embed }: CaptureTarget,
  options: CaptureOptions,
  dedup: CaptureDedup,
  extracted: readonly ExtractedItem[],
  { keys, ruleKeys }: HeldKeys,
): Promise<CaptureTally> {
  const writeOpts: CaptureWriteOptions = {
    tenantId: options.global ? undefined : options.tenantId,
    originProject: options.originProject,
    lean: false,
    dedup,
    now: evalClock()(),
  };
  if (!options.dryRun) {
    return captureExtractedItems({ store, config, embed }, writeOpts, extracted, keys, ruleKeys);
  }
  return previewCapture({ store, config }, writeOpts, extracted, keys, ruleKeys);
}

/** The items with `scrub` applied to each text, as a path stores them; scrubbing can make two
 * items one, and the first stays unless a later one is the person's rule. */
export function scrubbedItems(
  items: readonly ExtractedItem[],
  scrub: (text: string) => string,
): ExtractedItem[] {
  return oncePerText(items.map((item) => ({ ...item, content: scrub(item.content) })));
}

/** Held keys, each twin's clean text too when a held row has its old text and repair keeps that
 * row: a pinned row, or one whose text is no certain defect. */
export function heldKeysOf(rows: readonly HeldText[], twins: readonly BoldTwin[]): Set<string> {
  const keys = storedTextKeys(rows);
  for (const key of twinKeys(rows, twins)) keys.add(key);
  return keys;
}

/** The held keys that also stop a stated rule written for `ruleProject` (its names): every copy
 * but one the store's write replaces, which holds the rule's exact text, so a bold twin still
 * stops it. */
export function ruleHeldKeysOf(
  rows: readonly HeldText[],
  twins: readonly BoldTwin[],
  ruleProject: readonly string[],
): Set<string> {
  const keys = storedTextKeys(rows.filter((row) => !ruleReplaces(row, ruleProject)));
  for (const key of twinKeys(rows, twins)) keys.add(key);
  return keys;
}

function twinKeys(rows: readonly HeldText[], twins: readonly BoldTwin[]): string[] {
  const keys = storedTextKeys(rows);
  const pinned = storedTextKeys(rows.filter((row) => row.pinned));
  return twins
    .filter(({ old }) =>
      (isCertainReason(storedDefect(old)) ? pinned : keys).has(duplicateKey(old)),
    )
    .map((twin) => duplicateKey(twin.clean));
}

/** The held keys, and those that also stop a stated rule. */
interface HeldKeys {
  readonly keys: Set<string>;
  readonly ruleKeys: ReadonlySet<string>;
}

// Dedup only against rows this capture's reader sees: another tenant's or project's rows are
// hidden, so they must not stop its own copy.
async function storedKeysInView(
  store: Pick<StoreGroups, 'captures'>,
  { tenantId, project, everyScope, ruleProject = [] }: CaptureDedup,
  extracted: readonly ExtractedItem[],
  twins: readonly BoldTwin[],
): Promise<HeldKeys> {
  // The lookup matches stored text exactly, so it also asks for the lines as capture once stored them.
  const texts = [...extracted.map((item) => item.content), ...twins.map((twin) => twin.old)];
  const rows = await store.captures.textsHolding(tenantId, texts, { project, everyScope });
  return { keys: heldKeysOf(rows, twins), ruleKeys: ruleHeldKeysOf(rows, twins, ruleProject) };
}

/** The rows a capture's dedup reads, as data, so the store's write can read them again in its
 * own transaction, and the project a stated rule is written for. */
async function captureDedup(
  folderFiles: StoreGroups['folderFiles'],
  options: CaptureOptions,
): Promise<CaptureDedup> {
  const tenantId = options.global ? ALL_TENANTS : options.tenantId;
  const origin = options.originProject;
  // classifyOriginProject in SQL: a project with no id sees every row, any other its own names and
  // user-global rows.
  if (origin !== undefined && projectId(origin) !== '') {
    const names = projectNames(origin);
    return { tenantId, everyScope: true, project: names, ruleProject: names };
  }
  const ruleProject = origin === undefined ? await stampedProject(folderFiles) : [];
  return { tenantId, everyScope: true, ruleProject };
}

/** The names of the project the store stamps on a row that names none: none for a shared or a
 * user-global store. */
async function stampedProject(folderFiles: StoreGroups['folderFiles']): Promise<readonly string[]> {
  const { shared, project } = await folderFiles.home();
  return shared || projectId(project) === '' ? [] : projectNames(project);
}

function printCaptureTally(
  options: CaptureOptions,
  { captured, skipped, rejected }: CaptureTally,
): void {
  const prefix = options.dryRun ? '[dry-run] ' : '';
  const globalPrefix = options.global ? '[global] ' : '';
  console.log(
    `\n${prefix}${globalPrefix}Captured ${captured} items (${skipped} skipped as duplicates` +
      (rejected > 0 ? `, ${rejected} rejected` : '') +
      ')',
  );
}

/** A capture's raw texts, the person's first: user turns before `firstFollowUp` are the request,
 * the rest answer the agent. `followUps` holds those later turns whole, for the model. */
interface CaptureTexts {
  readonly texts: string[];
  readonly userTexts: number;
  readonly firstFollowUp?: number;
  readonly followUps: string[];
}

/** The raw texts for the chosen source, one per session turn, the person's turns first; null after printing why a
 *  last-session capture has nothing.
 *  Only a session says who spoke, so a piped or file capture counts no user texts. */
function readCaptureTexts(options: CaptureOptions): CaptureTexts | null {
  switch (options.source) {
    case 'stdin': {
      try {
        return { texts: [fs.readFileSync(0, 'utf8')], userTexts: 0, followUps: [] };
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
      return { texts: [fs.readFileSync(options.filePath, 'utf8')], userTexts: 0, followUps: [] };
    }
    case 'last-session':
      return readSessionTexts(options);
  }
}

function readSessionTexts(options: CaptureOptions): CaptureTexts | null {
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
  // The first user turn is the request; a tail that cut it off, or a later slice, holds only replies.
  const userTurns = turns.filter((t) => t.role === 'user').map((t) => t.text);
  const opener = options.fromStart !== false && users.length === userTurns.length ? 1 : 0;
  return {
    texts: [...users, ...assistants],
    userTexts: users.length,
    firstFollowUp: opener,
    followUps: userTurns.slice(opener),
  };
}

export interface CaptureTally {
  captured: number;
  skipped: number;
  rejected: number;
}

/** What a capture's rows carry. The CLI passes no tenant for the global store, so `global` never
 * reaches the writes. */
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
  /** The instant each captured memory is stamped with. */
  readonly now: Date;
}

/** A folder's store with the config its root loaded for this capture, and where its rows'
 * vectors go. */
export interface ConfiguredStore {
  readonly store: Pick<StoreGroups, 'captures'>;
  readonly config: HippoConfig;
  readonly embed: (entry: MemoryEntry) => void;
}

/** The entries to write, and per item the entry whose outcome it takes, or -1 for a text the
 * store already holds. */
interface CapturePlan {
  readonly entries: MemoryEntry[];
  readonly keys: string[];
  readonly slots: number[];
}

/** One entry per new text: building can throw, so a held text or a repeat within the batch is
 * never built. */
function planCapture(
  extracted: readonly ExtractedItem[],
  isHeld: (item: ExtractedItem, key: string) => boolean,
  build: (item: ExtractedItem) => MemoryEntry,
): CapturePlan {
  const plan: CapturePlan = { entries: [], keys: [], slots: [] };
  const firstSlot = new Map<string, number>();
  for (const item of extracted) {
    const key = duplicateKey(item.content);
    let slot = isHeld(item, key) ? -1 : firstSlot.get(key);
    if (slot === undefined) {
      slot = plan.entries.push(build(item)) - 1;
      plan.keys.push(key);
      firstSlot.set(key, slot);
    }
    plan.slots.push(slot);
  }
  return plan;
}

/** Whether a held text stops `item`: any copy stops a note, only a `ruleKeys` copy a stated rule. */
function heldCheck(
  keys: ReadonlySet<string>,
  ruleKeys: ReadonlySet<string>,
): (item: ExtractedItem, key: string) => boolean {
  return (item, key) => (isStatedRule(item) ? ruleKeys : keys).has(key);
}

/** Writes each new text once; a repeat of a captured text in the same batch counts as skipped,
 * as a held one does. */
export async function captureExtractedItems(
  { store, config, embed }: ConfiguredStore,
  options: CaptureWriteOptions,
  extracted: readonly ExtractedItem[],
  keys: Set<string>,
  ruleKeys: ReadonlySet<string> = keys,
): Promise<CaptureTally> {
  const plan = planCapture(extracted, heldCheck(keys, ruleKeys), (item) =>
    captureEntry(item, options, config.defaultHalfLifeDays),
  );
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
    if (!options.lean) embed(plan.entries[i]);
  });
  return tally;
}

interface PreviewStore {
  readonly store: Pick<StoreGroups, 'rejections'>;
  readonly config: Pick<HippoConfig, 'defaultHalfLifeDays'>;
}

/** A dry run asks the store the same rejected-value question the write's gate does, so a
 * tombstoned item previews as rejected rather than captured. */
async function previewCapture(
  { store: { rejections }, config }: PreviewStore,
  options: CaptureWriteOptions,
  extracted: readonly ExtractedItem[],
  keys: ReadonlySet<string>,
  ruleKeys: ReadonlySet<string>,
): Promise<CaptureTally> {
  const tally: CaptureTally = { captured: 0, skipped: 0, rejected: 0 };
  const held = heldCheck(keys, ruleKeys);
  const fresh = extracted.filter((item) => !held(item, duplicateKey(item.content)));
  const refused = await rejections.refusedAmong(
    fresh.map((item) => {
      const entry = captureEntry(item, options, config.defaultHalfLifeDays);
      return { tenantId: entry.tenantId, entryId: entry.id, content: entry.content };
    }),
  );
  let next = 0;
  for (const item of extracted) {
    if (held(item, duplicateKey(item.content))) {
      tally.skipped++;
      console.log(`  [skip] (${item.category}) ${item.content.slice(0, 80)}`);
    } else if (refused[next++] === true) {
      console.log(
        `  [reject] (${item.category}) ${item.content.slice(0, 80)} - matches a rejected value`,
      );
      tally.rejected++;
    } else {
      console.log(`  [capture] (${item.category}) ${item.content}`);
      tally.captured++;
    }
  }
  return tally;
}

function captureEntry(
  item: ExtractedItem,
  options: CaptureWriteOptions,
  baseHalfLifeDays: number,
): MemoryEntry {
  // kind stays 'distilled': these are curated items, not raw transcript (see MEMORY_ENVELOPE.md).
  // The write tenant must match the dedup read's, or scoped dedup passes and the row lands in
  // 'default'. A rule the person stated is pinned, so it injects even when a later prompt shares
  // none of its words. SHORTCUT: every stated rule pins; cap or age these pins if a store's pins
  // outgrow the hook budget. The from-user tag marks the same pin as the person's rule for the hooks.
  const stated = isStatedRule(item);
  const created = createMemory(
    item.content,
    {
      layer: Layer.Episodic,
      tags: stated ? [...item.tags, USER_RULE_TAG] : item.tags,
      source: 'capture',
      confidence: 'observed',
      pinned: stated,
      tenantId: options.tenantId,
      sourceSessionId: options.sessionId,
      baseHalfLifeDays,
    },
    options.now,
  );
  if (options.originProject === undefined) return created;
  return { ...created, originProject: projectId(options.originProject) };
}
