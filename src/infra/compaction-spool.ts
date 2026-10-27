// Summaries post-compact could not record because the store was busy, waiting on disk for the next
// replay.
import { MINUTE_MS } from '../base/util/time.js';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isObjectLike,
  isStringValue,
  type PostCompactPayload,
} from '../base/session/capture-contract.js';
import type { CompactionText, StepFailure } from '../base/ports/store/capture.js';
import { isStoreBusy } from '../base/ports/store.js';
import { errorCode, errorFields, errorMessage, type LogFields } from '../base/util/log.js';
import { tryParseJson } from '../base/util/json.js';
import { takeFileLock } from '../host/file-lock.js';
import { PRIVATE_DIR } from '../host/private-dir.js';

const STAMP_DIGITS = 13;

export const SPOOL_DIR = 'compactions-spool';
/**
 * Starts the log line of a step that broke with an unexpected error, so the session-start banner
 * counts it; a set-aside file is counted by its `.bad` name instead. */
export const SPOOL_PROBLEM = 'spool problem: ';
const LOCK = 'replay.lock.db';
/** Long enough that a live replayer has finished with its claim. */
const STALE_MS = 10 * MINUTE_MS;
const MAX_ATTEMPTS = 3;
const BUSY_RETRIES = 3;
const BUSY_WAIT_MS = 50;
// Antivirus, the indexer or a delete still pending on Windows: the step is left for a later run.
const BUSY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

// A stem is `<ms13>-<rand8hex>`, so name order is age order; legacy files are
// `<session>-<ms>.json`.
const WAITING = /^([\w-]+)(?:\.a(\d+))?\.json$/;
const CLAIM = /^([\w-]+)\.a(\d+)\.claim-(\d{13})$/;
// An old binary's claim carries no claim time, so its mtime stands in.
const LEGACY_CLAIM = /^([\w-]+)(?:\.a(\d+))?\.json\.claimed$/;
const TMP = /^([\w-]+)(?:\.a\d+)?\.json\.tmp$/;
const BAD = /^([\w-]+)\.(?:\w+\.)?bad$/;
const BAD_TMP = /^[\w-]+\.\w+\.bad\.[0-9a-f]{8}\.tmp$/;
const NEW_STEM = /^(\d{13})-[0-9a-f]{8}$/;
const LEGACY_STEM_TIME = /-(\d+)$/;

/** Where a compaction step's lines go: the hook's log file, or a sleep's warnings. */
export type Log = (message: string, fields?: LogFields) => void;

/** Only the fs calls the spool makes, so a test can stand in for one of them. */
export interface SpoolFs {
  existsSync(file: string): boolean;
  mkdirSync(dir: string, options: typeof PRIVATE_DIR): void;
  readdirSync(dir: string): string[];
  readFileSync(file: string, encoding: 'utf8'): string;
  renameSync(from: string, to: string): void;
  statSync(file: string): { mtimeMs: number };
  unlinkSync(file: string): void;
  writeFileSync(file: string, data: string, options: { encoding: 'utf8'; flag?: 'wx' }): void;
}

export interface SpooledCompaction {
  tenantId: string;
  payload: PostCompactPayload;
  text: CompactionText;
  at: Date;
}

/**
 * Records one spooled compaction; it calls `recorded` once the store holds the summary, so the file
 * is done even if a later step fails. Answers why a step failed, or null; a throw counts as a
 * failure too.
 */
export type SpoolImporter = (
  spooled: SpooledCompaction,
  recorded: () => void,
) => Promise<StepFailure | null>;

type Settled = 'done' | 'gone' | 'busy';
type BadCause = 'unreadable' | 'failed' | 'interrupted';
type FileOutcome = 'imported' | 'skipped' | 'stop';

/** One fs step's outcome: the value it returned once it ran, else the error code that ended it. */
type SettledStep<T> =
  | { readonly settled: 'done'; readonly code: ''; readonly value: T }
  | { readonly settled: 'gone' | 'busy'; readonly code: string; readonly value?: undefined };

interface Waiting {
  name: string;
  stem: string;
  attempt: number;
  created: number;
}

interface Claim {
  name: string;
  stem: string;
  attempt: number;
  /** null for a legacy claim, which is aged by mtime. */
  claimedAt: number | null;
}

const stamp = (ms: number): string => String(Math.trunc(ms)).padStart(STAMP_DIGITS, '0');
const idle = new Int32Array(new SharedArrayBuffer(4));

/**
 * Runs one fs step, retrying a busy code briefly: its value once it ran, else the busy code it
 * kept hitting. Any other error throws.
 */
function retryBusy<T>(step: () => T): { readonly value: T } | { readonly busyCode: string } {
  for (let retry = 0; ; retry++) {
    try {
      return { value: step() };
    } catch (err) {
      const code = errorCode(err);
      if (!BUSY_CODES.has(code)) throw err;
      if (retry === BUSY_RETRIES) return { busyCode: code };
      Atomics.wait(idle, 0, 0, BUSY_WAIT_MS);
    }
  }
}

/**
 * Runs one fs step: ENOENT means gone, a busy code is retried briefly, and any other error is
 * logged and counted busy, so a replay never throws.
 */
function settleCode<T>(step: () => T, log: Log, what: string): SettledStep<T> {
  try {
    const ran = retryBusy(step);
    return 'value' in ran ? done(ran.value) : { settled: 'busy', code: ran.busyCode };
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT') return { settled: 'gone', code };
    log(`${SPOOL_PROBLEM}${what}: ${errorMessage(err)}`, { ...errorFields(err), errno: code });
    return { settled: 'busy', code };
  }
}

/** A step that needed no fs call, as one that ran. */
function done<T>(value: T): SettledStep<T> {
  return { settled: 'done', code: '', value };
}

/** {@link settleCode} for a caller that needs only the outcome. */
function settle(step: () => void, log: Log, what: string): Settled {
  return settleCode(step, log, what).settled;
}

/** When a stem was spooled: the time that leads a new stem, else the time that ends a legacy
 * one, else 0. */
function created(stem: string): number {
  const m = NEW_STEM.exec(stem) ?? LEGACY_STEM_TIME.exec(stem);
  return m === null ? 0 : Number(m[1]);
}

/** Files waiting for import, oldest first across new and legacy names. */
function waitingFiles(names: readonly string[]): Waiting[] {
  const found = names.flatMap((name) => {
    const m = WAITING.exec(name);
    return m === null
      ? []
      : [{ name, stem: m[1], attempt: Number(m[2] ?? 0), created: created(m[1]) }];
  });
  return found.sort(
    (a, b) => a.created - b.created || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

function claimOf(name: string): Claim | null {
  const m = CLAIM.exec(name);
  if (m !== null) return { name, stem: m[1], attempt: Number(m[2]), claimedAt: Number(m[3]) };
  const legacy = LEGACY_CLAIM.exec(name);
  return legacy === null
    ? null
    : { name, stem: legacy[1], attempt: Number(legacy[2] ?? 0), claimedAt: null };
}

// The session id stays in the body only, and the random part keeps two spools of one millisecond
// apart.
function spoolFile(hippoRoot: string): string {
  return path.join(
    hippoRoot,
    SPOOL_DIR,
    `${stamp(Date.now())}-${randomBytes(4).toString('hex')}.a0.json`,
  );
}

export interface SpoolOptions {
  hippoRoot: string;
  tenantId: string;
  payload: PostCompactPayload;
  text: CompactionText;
  at: Date;
  fsx?: SpoolFs;
}

export function spool(options: SpoolOptions): void {
  const { hippoRoot, tenantId, payload, text, at, fsx = fs } = options;
  const file = spoolFile(hippoRoot);
  fsx.mkdirSync(path.dirname(file), PRIVATE_DIR);
  const body = {
    tenantId,
    sessionId: payload.sessionId,
    trigger: payload.trigger,
    cwd: payload.cwd,
    transcriptPath: payload.transcriptPath,
    at: at.toISOString(),
    summary: text.summary,
    items: text.items,
  };
  // Renamed into place so a replayer listing `.json` files never reads half a file.
  fsx.writeFileSync(`${file}.tmp`, JSON.stringify(body), { encoding: 'utf8', flag: 'wx' });
  // A rename that stays busy leaves a whole tmp, which a replay promotes once it is STALE_MS old.
  retryBusy(() => fsx.renameSync(`${file}.tmp`, file));
}

/** null when the text is not a spooled compaction. */
export function parseSpooled(text: string, fallbackTenantId: string): SpooledCompaction | null {
  // A half-written spool file holds no compaction; the caller treats null as unreadable.
  const raw: unknown = tryParseJson(text);
  if (
    !isObjectLike(raw) ||
    !('sessionId' in raw) ||
    !isStringValue(raw.sessionId) ||
    !('summary' in raw) ||
    !isStringValue(raw.summary)
  ) {
    return null;
  }
  if (!('at' in raw) || !isStringValue(raw.at) || Number.isNaN(Date.parse(raw.at))) return null;
  const items: string[] =
    'items' in raw && Array.isArray(raw.items) ? raw.items.filter(isStringValue) : [];
  return {
    tenantId:
      'tenantId' in raw && isStringValue(raw.tenantId) && raw.tenantId !== ''
        ? raw.tenantId
        : fallbackTenantId,
    payload: {
      sessionId: raw.sessionId,
      trigger: 'trigger' in raw && isStringValue(raw.trigger) ? raw.trigger : null,
      cwd: 'cwd' in raw && isStringValue(raw.cwd) ? raw.cwd : null,
      transcriptPath:
        'transcriptPath' in raw && isStringValue(raw.transcriptPath) ? raw.transcriptPath : null,
      compactSummary: null,
    },
    text: { summary: raw.summary, items },
    at: new Date(raw.at),
  };
}

/**
 * Claim time sits in the claim's name, so a claim over STALE_MS away from now belongs to a replayer
 * that never finished. True when one was put back.
 */
function recoverStaleClaims(
  fsx: SpoolFs,
  dir: string,
  names: readonly string[],
  log: Log,
): boolean {
  const now = Date.now();
  // A claim whose unlink stayed busy after its `.bad` landed is a spare copy, not a second failure.
  const setAside = new Set(names.flatMap((name) => BAD.exec(name)?.[1] ?? []));
  let putBackOne = false;
  for (const claim of names.flatMap((name) => claimOf(name) ?? [])) {
    const file = path.join(dir, claim.name);
    const what = `spool file ${claim.name} not recovered`;
    const at =
      claim.claimedAt === null
        ? settleCode(() => fsx.statSync(file).mtimeMs, log, what)
        : done(claim.claimedAt);
    if (at.settled !== 'done' || Math.abs(now - at.value) <= STALE_MS) continue;
    if (setAside.has(claim.stem)) {
      settle(() => fsx.unlinkSync(file), log, what);
    } else if (putBackStale(fsx, dir, claim, log)) {
      putBackOne = true;
    }
  }
  return putBackOne;
}

/** Puts a stale claim back for another try, or sets it aside after its last; true when put back. */
function putBackStale(fsx: SpoolFs, dir: string, claim: Claim, log: Log): boolean {
  const file = path.join(dir, claim.name);
  const what = `spool file ${claim.name} not recovered`;
  const next = claim.attempt + 1;
  if (next < MAX_ATTEMPTS) {
    const moved = settle(
      () => fsx.renameSync(file, path.join(dir, `${claim.stem}.a${next}.json`)),
      log,
      what,
    );
    if (moved !== 'done') return false;
    log(
      `spool file ${claim.name} was claimed by a replayer that never finished, put back (try ${next} of ` +
        `${MAX_ATTEMPTS})`,
    );
    return true;
  }
  if (
    moveBad(fsx, dir, file, { stem: claim.stem, attempt: claim.attempt, cause: 'interrupted', log })
  ) {
    log(
      `spool file ${claim.name} was claimed by a replayer that never finished ${MAX_ATTEMPTS} times, set aside as ` +
        `.bad`,
    );
  }
  return false;
}

interface PutBackOptions {
  fsx: SpoolFs;
  dir: string;
  claim: string;
  stem: string;
  attempt: number;
  log: Log;
}

/** Returns a claim to the waiting files as `<stem>.a<attempt>.json`; one that stays busy is left
 * for stale recovery. */
function putBack(options: PutBackOptions): void {
  const { fsx, dir, claim, stem, attempt, log } = options;
  const name = path.basename(claim);
  if (
    settle(
      () => fsx.renameSync(claim, path.join(dir, `${stem}.a${attempt}.json`)),
      log,
      `spool file ${name} not put back`,
    ) === 'busy'
  ) {
    log(
      `spool file ${name} could not be put back; it returns ${STALE_MS / MINUTE_MS} minutes after its claim`,
    );
  }
}

interface WriteBadOptions {
  readonly stem: string;
  readonly cause: BadCause;
  readonly text: string;
  readonly log: Log;
  readonly what: string;
}

/** Writes `<stem>.<cause>.bad` through a random temp file, so the rename replaces any torn
 * `.bad` a crash left. */
function writeBad(fsx: SpoolFs, dir: string, options: WriteBadOptions): boolean {
  const { stem, cause, text, log, what } = options;
  const tmp = path.join(dir, `${stem}.${cause}.bad.${randomBytes(4).toString('hex')}.tmp`);
  const written = settle(
    () => fsx.writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' }),
    log,
    what,
  );
  const moved =
    written === 'done'
      ? settle(() => fsx.renameSync(tmp, path.join(dir, `${stem}.${cause}.bad`)), log, what)
      : written;
  if (moved !== 'done' && written === 'done') settle(() => fsx.unlinkSync(tmp), log, what);
  return moved === 'done';
}

interface MoveBadOptions {
  readonly stem: string;
  readonly attempt: number;
  readonly cause: BadCause;
  readonly log: Log;
  readonly raw?: string;
}

/**
 * Sets a claim aside as `.bad` before the claim goes, so a crash between leaves a whole copy; a
 * busy write puts the claim back.
 */
function moveBad(fsx: SpoolFs, dir: string, claim: string, options: MoveBadOptions): boolean {
  const { stem, attempt, cause, log, raw } = options;
  const what = `spool file ${path.basename(claim)} not set aside`;
  const read =
    raw === undefined ? settleCode(() => fsx.readFileSync(claim, 'utf8'), log, what) : done(raw);
  if (read.settled !== 'done') return false;
  if (!writeBad(fsx, dir, { stem, cause, text: read.value, log, what })) {
    putBack({ fsx, dir, claim, stem, attempt, log });
    return false;
  }
  settle(() => fsx.unlinkSync(claim), log, what);
  return true;
}

interface PromoteTmpOptions {
  readonly dir: string;
  readonly names: readonly string[];
  readonly tenantId: string;
  readonly log: Log;
}

/**
 * A tmp over STALE_MS old belongs to a spool that never renamed it: a whole one joins the waiting
 * files, a torn one is set aside. True when one joined.
 */
function promoteTmp(fsx: SpoolFs, { dir, names, tenantId, log }: PromoteTmpOptions): boolean {
  const now = Date.now();
  let promoted = false;
  for (const name of names) {
    const m = TMP.exec(name);
    if (m === null && !BAD_TMP.test(name)) continue;
    const file = path.join(dir, name);
    const what = `spool file ${name} not promoted`;
    const stat = settleCode(() => fsx.statSync(file).mtimeMs, log, what);
    if (stat.settled !== 'done' || Math.abs(now - stat.value) <= STALE_MS) continue;
    if (m === null) {
      // A `.bad` write cut off before its rename: its source goes only after that rename lands, so
      // this copy is spare.
      settle(() => fsx.unlinkSync(file), log, `spool file ${name} not removed`);
      continue;
    }
    const read = settleCode(() => fsx.readFileSync(file, 'utf8'), log, what);
    if (read.settled !== 'done') continue;
    const text = read.value;
    if (parseSpooled(text, tenantId) !== null) {
      if (settle(() => fsx.renameSync(file, file.slice(0, -'.tmp'.length)), log, what) === 'done') {
        log(`spool file ${name} was never renamed into place, promoted`);
        promoted = true;
      }
    } else if (writeBad(fsx, dir, { stem: m[1], cause: 'unreadable', text, log, what })) {
      settle(() => fsx.unlinkSync(file), log, what);
      log(`spool file ${name} was never finished, set aside as .bad`);
    }
  }
  return promoted;
}

/** Removes a claim once the store holds its summary; a claim left behind is imported again, so
 * the log says so. */
function removeClaim(fsx: SpoolFs, claim: string, name: string, log: Log): void {
  const removed = settleCode(
    () => fsx.unlinkSync(claim),
    log,
    `spool file ${name} claim not removed`,
  );
  if (removed.settled === 'busy') {
    log(
      `spool file ${name} saved; its claim could not be removed (${removed.code}); it will be imported again`,
    );
  }
}

interface ImportFailedOptions {
  readonly dir: string;
  readonly claim: string;
  readonly entry: Waiting;
  readonly text: string;
  readonly recorded: boolean;
  readonly failure: StepFailure;
  readonly log: Log;
}

/**
 * After an importer failure: a busy store stops the run with the count unchanged, any other error
 * counts one try toward .bad.
 */
function importFailed(fsx: SpoolFs, options: ImportFailedOptions): FileOutcome {
  const { dir, claim, entry, text, recorded, failure, log } = options;
  const { name } = entry;
  const { busy, message, fields } = failure;
  if (recorded) {
    // The record stays `summarised`, so the stalled-record step of a later replay writes its items.
    log(
      busy
        ? `spool file ${name} saved; its memories wait for the next sleep (store busy)`
        : `spool file ${name} saved; writing its memories failed: ${message}`,
      fields,
    );
    return busy ? 'stop' : 'skipped';
  }
  if (busy) {
    putBack({ fsx, dir, claim, stem: entry.stem, attempt: entry.attempt, log });
    log(`spool file ${name} waits for the next run: the store is busy`);
    return 'stop';
  }
  const next = entry.attempt + 1;
  if (next < MAX_ATTEMPTS) {
    putBack({ fsx, dir, claim, stem: entry.stem, attempt: next, log });
    log(`spool file ${name} failed to import (try ${next} of ${MAX_ATTEMPTS}): ${message}`, fields);
  } else if (
    moveBad(fsx, dir, claim, {
      stem: entry.stem,
      attempt: entry.attempt,
      cause: 'failed',
      log,
      raw: text,
    })
  ) {
    log(`spool file ${name} set aside as .bad after ${MAX_ATTEMPTS} tries: ${message}`, fields);
  }
  return 'skipped';
}

interface ImportFileOptions {
  fsx: SpoolFs;
  dir: string;
  entry: Waiting;
  tenantId: string;
  log: Log;
  importOne: SpoolImporter;
}

/** Claims, reads and imports one waiting file; `stop` ends the run because the store is busy. */
async function importFile(options: ImportFileOptions): Promise<FileOutcome> {
  const { fsx, dir, entry, tenantId, log, importOne } = options;
  const { name } = entry;
  const claim = claimWaiting(options);
  if (claim === null) return 'skipped';
  const text = readClaim(options, claim);
  if (text === null) return 'skipped';
  const spooled = parseSpooled(text, tenantId);
  if (spooled === null) {
    setAsideUnreadable(options, claim, text);
    return 'skipped';
  }
  let recorded = false;
  const markRecorded = (): void => {
    if (recorded) return;
    recorded = true;
    removeClaim(fsx, claim, name, log);
  };
  let failure: StepFailure | null;
  try {
    failure = await importOne(spooled, markRecorded);
  } catch (err) {
    failure = { busy: isStoreBusy(err), message: errorMessage(err), fields: errorFields(err) };
  }
  if (failure !== null) {
    return importFailed(fsx, { dir, claim, entry, text, recorded, failure, log });
  }
  markRecorded();
  return 'imported';
}

/** Renames the waiting file to a claim stamped now; null when it could not be taken. */
function claimWaiting({ fsx, dir, entry, log }: ImportFileOptions): string | null {
  const { name } = entry;
  const claim = path.join(dir, `${entry.stem}.a${entry.attempt}.claim-${stamp(Date.now())}`);
  const taken = settleCode(
    () => fsx.renameSync(path.join(dir, name), claim),
    log,
    `spool file ${name} not claimed`,
  );
  if (BUSY_CODES.has(taken.code)) {
    log(`spool file ${name} is locked by another program, left for the next run`);
  }
  return taken.settled === 'done' ? claim : null;
}

/** The claim's text; null when it vanished or stayed busy, and a busy one goes back. */
function readClaim({ fsx, dir, entry, log }: ImportFileOptions, claim: string): string | null {
  const { name } = entry;
  const read = settleCode(
    () => fsx.readFileSync(claim, 'utf8'),
    log,
    `spool file ${name} not read`,
  );
  if (read.settled === 'gone') log(`spool file ${name} vanished`);
  if (read.settled === 'busy') {
    putBack({ fsx, dir, claim, stem: entry.stem, attempt: entry.attempt, log });
  }
  return read.settled === 'done' ? read.value : null;
}

function setAsideUnreadable(
  { fsx, dir, entry, log }: ImportFileOptions,
  claim: string,
  text: string,
): void {
  const { stem, attempt } = entry;
  if (moveBad(fsx, dir, claim, { stem, attempt, cause: 'unreadable', log, raw: text })) {
    log(`spool file ${entry.name} is not readable, set aside as .bad`);
  }
}

export interface SpoolCounts {
  waiting: number;
  stale: number;
  bad: number;
}

function mtimeOf(fsx: SpoolFs, file: string): number | null {
  try {
    return fsx.statSync(file).mtimeMs;
  } catch (err) {
    const code = errorCode(err);
    // Moved by a replay after the listing, or held by another program: left out of this count
    // rather than failing it.
    if (code === 'ENOENT' || BUSY_CODES.has(code)) return null;
    throw err;
  }
}

/**
 * What doctor reports, read only: files a replay should have taken by now, claims and tmp files a
 * dead process left, and `.bad` files.
 */
export function spoolCounts(
  hippoRoot: string,
  now: Date,
  waitingAfterMs: number,
  fsx: SpoolFs = fs,
): SpoolCounts {
  const counts: SpoolCounts = { waiting: 0, stale: 0, bad: 0 };
  const dir = path.join(hippoRoot, SPOOL_DIR);
  if (!fsx.existsSync(dir)) return counts;
  const at = now.getTime();
  for (const name of fsx.readdirSync(dir)) {
    const file = path.join(dir, name);
    const waiting = WAITING.exec(name);
    const claim = claimOf(name);
    if (name.endsWith('.bad')) counts.bad++;
    else if (waiting !== null) {
      const spooled = NEW_STEM.test(waiting[1]) ? created(waiting[1]) : mtimeOf(fsx, file);
      if (spooled !== null && at - spooled > waitingAfterMs) counts.waiting++;
    } else if (claim !== null || TMP.test(name)) {
      const since = claim?.claimedAt ?? mtimeOf(fsx, file);
      if (since !== null && Math.abs(at - since) > STALE_MS) counts.stale++;
    }
  }
  return counts;
}

export interface ImportSpoolOptions {
  hippoRoot: string;
  tenantId: string;
  log: Log;
  deadline: number;
  importOne: SpoolImporter;
  fsx?: SpoolFs;
}

/**
 * One replayer at a time holds `replay.lock.db`, so only one process claims a file even where
 * Windows lets two renames of it both land.
 */
export async function importSpool(options: ImportSpoolOptions): Promise<number> {
  const { hippoRoot, tenantId, log, deadline, importOne, fsx = fs } = options;
  const dir = path.join(hippoRoot, SPOOL_DIR);
  if (!fsx.existsSync(dir)) return 0;
  const take = takeFileLock(path.join(dir, LOCK));
  if (take.kind === 'held') {
    log('spool left to another replayer (lock held by another process)');
    return 0;
  }
  if (take.kind === 'unusable') {
    log(`spool lock not taken: ${errorMessage(take.cause)}`, errorFields(take.cause));
    return 0;
  }
  try {
    const names = fsx.readdirSync(dir);
    const promoted = promoteTmp(fsx, { dir, names, tenantId, log });
    const recovered = recoverStaleClaims(fsx, dir, names, log);
    let finished = 0;
    // Only promotion and recovery add waiting names, so the folder is listed again only after one
    // of them did.
    for (const entry of waitingFiles(promoted || recovered ? fsx.readdirSync(dir) : names)) {
      if (Date.now() > deadline) break;
      const outcome = await importFile({ fsx, dir, entry, tenantId, log, importOne });
      if (outcome === 'imported') finished++;
      if (outcome === 'stop') break;
    }
    return finished;
  } finally {
    take.lock.release();
  }
}
