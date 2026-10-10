// Summaries post-compact could not record because the store was busy, waiting on disk for the next replay.
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isObjectLike, isStringValue } from '../core/capture-contract.js';
import type { CompactionText, Log, PostCompactPayload } from './compaction-record.js';
import { isSqliteBusy } from '../db/busy.js';
import { errorMessage } from '../util/log.js';

const STAMP_DIGITS = 13;

export const SPOOL_DIR = 'compactions-spool';
/** Starts the log line of a step that broke with an unexpected error, so the session-start banner counts it; a set-aside file is counted by its `.bad` name instead. */
export const SPOOL_PROBLEM = 'spool problem: ';
const LOCK = 'replay.lock';
/** Long enough that a live replayer has finished with its claim. */
const STALE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
const BUSY_RETRIES = 3;
const BUSY_WAIT_MS = 50;
// Antivirus, the indexer or a delete still pending on Windows: the step is left for a later run.
const BUSY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

// A stem is `<ms13>-<rand8hex>`, so name order is age order; legacy files are `<session>-<ms>.json`.
const WAITING = /^([\w-]+)(?:\.a(\d+))?\.json$/;
const CLAIM = /^([\w-]+)\.a(\d+)\.claim-(\d{13})$/;
// An old binary's claim carries no claim time, so its mtime stands in.
const LEGACY_CLAIM = /^([\w-]+)(?:\.a(\d+))?\.json\.claimed$/;
const TMP = /^([\w-]+)(?:\.a\d+)?\.json\.tmp$/;
const BAD = /^([\w-]+)\.(?:\w+\.)?bad$/;
const BAD_TMP = /^[\w-]+\.\w+\.bad\.[0-9a-f]{8}\.tmp$/;
const NEW_STEM = /^(\d{13})-[0-9a-f]{8}$/;
const LEGACY_STEM_TIME = /-(\d+)$/;

/** Only the fs calls the spool makes, so a test can stand in for one of them. */
export interface SpoolFs {
  existsSync(file: string): boolean;
  mkdirSync(dir: string, options: { recursive: true }): void;
  readdirSync(dir: string): string[];
  readFileSync(file: string, encoding: 'utf8'): string;
  renameSync(from: string, to: string): void;
  statSync(file: string): { mtimeMs: number };
  unlinkSync(file: string): void;
  writeFileSync(file: string, data: string, options: { encoding: 'utf8'; flag?: 'wx' }): void;
}

let fsx: SpoolFs = fs;

/** Test-only seam, so a test can make one fs call fail; null restores the real fs. */
export function _setSpoolFsForTests(next: SpoolFs | null): void {
  fsx = next ?? fs;
}

export interface SpooledCompaction {
  tenantId: string;
  payload: PostCompactPayload;
  text: CompactionText;
  at: Date;
}

/** Records one spooled compaction; it calls `recorded` once the store holds the summary, so the file is done even if a later step throws. */
export type SpoolImporter = (spooled: SpooledCompaction, recorded: () => void) => void;

type Settled = 'done' | 'gone' | 'busy';
type BadCause = 'unreadable' | 'failed' | 'interrupted';
type FileOutcome = 'imported' | 'skipped' | 'stop';

interface SettledStep {
  settled: Settled;
  /** The error code that ended the step, '' when it ran. */
  code: string;
}

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

interface LockBody {
  pid: number | null;
  at: number;
  token: string | null;
}

interface HeldLock {
  token: string;
  at: number;
}

const stamp = (ms: number): string => String(Math.trunc(ms)).padStart(STAMP_DIGITS, '0');
const isTime = <T>(value: T): value is T & number => typeof value === 'number' && Number.isFinite(value);
const idle = new Int32Array(new SharedArrayBuffer(4));

function errCode(cause: unknown): string {
  return cause instanceof Error && 'code' in cause && isStringValue(cause.code) ? cause.code : '';
}

/** Runs one fs step, retrying a busy code briefly; '' when it ran, else the busy code it kept hitting. Any other error throws. */
function retryBusy(step: () => void): string {
  for (let retry = 0; ; retry++) {
    try {
      step();
      return '';
    } catch (err) {
      const code = errCode(err);
      if (!BUSY_CODES.has(code)) throw err;
      if (retry === BUSY_RETRIES) return code;
      Atomics.wait(idle, 0, 0, BUSY_WAIT_MS);
    }
  }
}

/** Runs one fs step: ENOENT means gone, a busy code is retried briefly, and any other error is logged and counted busy, so a replay never throws. */
function settleCode(step: () => void, log: Log, what: string): SettledStep {
  try {
    const code = retryBusy(step);
    return { settled: code === '' ? 'done' : 'busy', code };
  } catch (err) {
    const code = errCode(err);
    if (code === 'ENOENT') return { settled: 'gone', code };
    log(`${SPOOL_PROBLEM}${what}: ${errorMessage(err)}`);
    return { settled: 'busy', code };
  }
}

/** {@link settleCode} for a caller that needs only the outcome. */
function settle(step: () => void, log: Log, what: string): Settled {
  return settleCode(step, log, what).settled;
}

/** When a stem was spooled: the time that leads a new stem, else the time that ends a legacy one, else 0. */
function created(stem: string): number {
  const m = NEW_STEM.exec(stem) ?? LEGACY_STEM_TIME.exec(stem);
  return m === null ? 0 : Number(m[1]);
}

/** Files waiting for import, oldest first across new and legacy names. */
function waitingFiles(names: readonly string[]): Waiting[] {
  const found = names.flatMap((name) => {
    const m = WAITING.exec(name);
    return m === null ? [] : [{ name, stem: m[1], attempt: Number(m[2] ?? 0), created: created(m[1]) }];
  });
  return found.sort((a, b) => a.created - b.created || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function claimOf(name: string): Claim | null {
  const m = CLAIM.exec(name);
  if (m !== null) return { name, stem: m[1], attempt: Number(m[2]), claimedAt: Number(m[3]) };
  const legacy = LEGACY_CLAIM.exec(name);
  return legacy === null ? null : { name, stem: legacy[1], attempt: Number(legacy[2] ?? 0), claimedAt: null };
}

// The session id stays in the body only, and the random part keeps two spools of one millisecond apart.
function spoolFile(hippoRoot: string): string {
  return path.join(hippoRoot, SPOOL_DIR, `${stamp(Date.now())}-${randomBytes(4).toString('hex')}.a0.json`);
}

export function spool(hippoRoot: string, tenantId: string, payload: PostCompactPayload, text: CompactionText, at: Date): void {
  const file = spoolFile(hippoRoot);
  fsx.mkdirSync(path.dirname(file), { recursive: true });
  const body = { tenantId, sessionId: payload.sessionId, trigger: payload.trigger, cwd: payload.cwd, transcriptPath: payload.transcriptPath, at: at.toISOString(), summary: text.summary, items: text.items };
  // Renamed into place so a replayer listing `.json` files never reads half a file.
  fsx.writeFileSync(`${file}.tmp`, JSON.stringify(body), { encoding: 'utf8', flag: 'wx' });
  // A rename that stays busy leaves a whole tmp, which a replay promotes once it is STALE_MS old.
  retryBusy(() => fsx.renameSync(`${file}.tmp`, file));
}

/** null when the text is not a spooled compaction. */
export function parseSpooled(text: string, fallbackTenantId: string): SpooledCompaction | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null; // a half-written spool file holds no compaction; the caller treats null as unreadable
  }
  if (!isObjectLike(raw) || !('sessionId' in raw) || !isStringValue(raw.sessionId) || !('summary' in raw) || !isStringValue(raw.summary)) return null;
  if (!('at' in raw) || !isStringValue(raw.at) || Number.isNaN(Date.parse(raw.at))) return null;
  const items: string[] = 'items' in raw && Array.isArray(raw.items) ? raw.items.filter(isStringValue) : [];
  return {
    tenantId: 'tenantId' in raw && isStringValue(raw.tenantId) && raw.tenantId !== '' ? raw.tenantId : fallbackTenantId,
    payload: {
      sessionId: raw.sessionId,
      trigger: 'trigger' in raw && isStringValue(raw.trigger) ? raw.trigger : null,
      cwd: 'cwd' in raw && isStringValue(raw.cwd) ? raw.cwd : null,
      transcriptPath: 'transcriptPath' in raw && isStringValue(raw.transcriptPath) ? raw.transcriptPath : null,
      compactSummary: null,
    },
    text: { summary: raw.summary, items },
    at: new Date(raw.at),
  };
}

const heldBy = (pid: number | null): string => `spool left to another replayer (lock held by ${pid === null ? 'another process' : `pid ${pid}`})`;

function parseLock(text: string): LockBody | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null; // torn, or its holder is still writing it; the caller judges it by mtime
  }
  if (!isObjectLike(raw) || !('at' in raw) || !isTime(raw.at)) return null;
  const pid = 'pid' in raw && isTime(raw.pid) ? raw.pid : null;
  const token = 'token' in raw && isStringValue(raw.token) ? raw.token : null;
  return { pid, at: raw.at, token };
}

/** The lock's body; its mtime stands in for the time when the body does not parse. */
function readLock(lock: string, log: Log): LockBody | 'gone' | 'busy' {
  let text = '';
  const read = settle(() => { text = fsx.readFileSync(lock, 'utf8'); }, log, 'spool lock not read');
  if (read !== 'done') return read;
  const body = parseLock(text);
  if (body !== null) return body;
  let mtime = 0;
  const stat = settle(() => { mtime = fsx.statSync(lock).mtimeMs; }, log, 'spool lock not read');
  return stat === 'done' ? { pid: null, at: mtime, token: null } : stat;
}

function createLock(lock: string, body: string, log: Log): 'taken' | 'exists' | 'skip' {
  try {
    fsx.writeFileSync(lock, body, { encoding: 'utf8', flag: 'wx' });
    return 'taken';
  } catch (err) {
    const code = errCode(err);
    if (code === 'EEXIST') return 'exists';
    // Windows refuses a create while a delete of the same name is pending, and the folder may have just gone.
    if (code !== 'ENOENT' && !BUSY_CODES.has(code)) log(`spool lock not taken: ${errorMessage(err)}`);
    return 'skip';
  }
}

/** This run's token and take time once it holds `replay.lock`, else null: another replayer holds it, or it could not be made. */
function takeLock(dir: string, log: Log): HeldLock | null {
  const lock = path.join(dir, LOCK);
  const token = randomBytes(8).toString('hex');
  const at = Date.now();
  const body = JSON.stringify({ pid: process.pid, at, token });
  for (let tries = 0; tries < 2; tries++) {
    const made = createLock(lock, body, log);
    if (made === 'taken') return { token, at };
    if (made === 'skip') break;
    const held = readLock(lock, log);
    if (held === 'gone') continue;
    if (held === 'busy') break;
    if (Math.abs(Date.now() - held.at) <= STALE_MS) {
      log(heldBy(held.pid));
      return null;
    }
    // SHORTCUT: two takers of one stale lock overlap by one file each; a pid-alive check is the upgrade.
    if (settle(() => fsx.unlinkSync(lock), log, 'spool lock not taken over') === 'busy') break;
  }
  log(heldBy(null));
  return null;
}

/** False, after saying so, once `replay.lock` no longer holds this run's token or cannot be read. */
function ownsLock(dir: string, token: string, log: Log): boolean {
  const held = readLock(path.join(dir, LOCK), log);
  if (held !== 'gone' && held !== 'busy' && held.token === token) return true;
  log(held === 'busy' ? 'spool lock could not be read, stopping' : 'spool left to another replayer (lock taken over)');
  return false;
}

/** Removes `replay.lock` only while it holds this run's token, so a run never deletes a successor's lock. Never throws. */
function releaseLock(dir: string, mine: HeldLock, log: Log): void {
  const lock = path.join(dir, LOCK);
  const held = readLock(lock, log);
  // A takeover needs a lock over STALE_MS old, so a busy read of one this run took more recently is still this run's.
  const ours = held === 'busy' ? Date.now() - mine.at < STALE_MS : held !== 'gone' && held.token === mine.token;
  if (ours) settle(() => fsx.unlinkSync(lock), log, 'spool lock not released');
}

/** Claim time sits in the claim's name, so a claim over STALE_MS away from now belongs to a replayer that never finished. True when one was put back. */
function recoverStaleClaims(dir: string, names: readonly string[], log: Log): boolean {
  const now = Date.now();
  // A claim whose unlink stayed busy after its `.bad` landed is a spare copy, not a second failure.
  const setAside = new Set(names.flatMap((name) => BAD.exec(name)?.[1] ?? []));
  let putBackOne = false;
  for (const claim of names.flatMap((name) => claimOf(name) ?? [])) {
    const file = path.join(dir, claim.name);
    const what = `spool file ${claim.name} not recovered`;
    let at = claim.claimedAt ?? 0;
    if (claim.claimedAt === null && settle(() => { at = fsx.statSync(file).mtimeMs; }, log, what) !== 'done') continue;
    if (Math.abs(now - at) <= STALE_MS) continue;
    const next = claim.attempt + 1;
    if (setAside.has(claim.stem)) {
      settle(() => fsx.unlinkSync(file), log, what);
    } else if (next < MAX_ATTEMPTS) {
      if (settle(() => fsx.renameSync(file, path.join(dir, `${claim.stem}.a${next}.json`)), log, what) === 'done') {
        log(`spool file ${claim.name} was claimed by a replayer that never finished, put back (try ${next} of ${MAX_ATTEMPTS})`);
        putBackOne = true;
      }
    } else if (moveBad(dir, file, { stem: claim.stem, attempt: claim.attempt, cause: 'interrupted', log })) {
      log(`spool file ${claim.name} was claimed by a replayer that never finished ${MAX_ATTEMPTS} times, set aside as .bad`);
    }
  }
  return putBackOne;
}

/** Returns a claim to the waiting files as `<stem>.a<attempt>.json`; one that stays busy is left for stale recovery. */
function putBack(dir: string, claim: string, stem: string, attempt: number, log: Log): void {
  const name = path.basename(claim);
  if (settle(() => fsx.renameSync(claim, path.join(dir, `${stem}.a${attempt}.json`)), log, `spool file ${name} not put back`) === 'busy') {
    log(`spool file ${name} could not be put back; it returns ${STALE_MS / 60_000} minutes after its claim`);
  }
}

interface WriteBadOptions {
  readonly stem: string;
  readonly cause: BadCause;
  readonly text: string;
  readonly log: Log;
  readonly what: string;
}

/** Writes `<stem>.<cause>.bad` through a random temp file, so the rename replaces any torn `.bad` a crash left. */
function writeBad(dir: string, options: WriteBadOptions): boolean {
  const { stem, cause, text, log, what } = options;
  const tmp = path.join(dir, `${stem}.${cause}.bad.${randomBytes(4).toString('hex')}.tmp`);
  const written = settle(() => fsx.writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' }), log, what);
  const moved = written === 'done' ? settle(() => fsx.renameSync(tmp, path.join(dir, `${stem}.${cause}.bad`)), log, what) : written;
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

/** Sets a claim aside as `.bad` before the claim goes, so a crash between leaves a whole copy; a busy write puts the claim back. */
function moveBad(dir: string, claim: string, options: MoveBadOptions): boolean {
  const { stem, attempt, cause, log, raw } = options;
  const what = `spool file ${path.basename(claim)} not set aside`;
  let text = raw ?? '';
  if (raw === undefined && settle(() => { text = fsx.readFileSync(claim, 'utf8'); }, log, what) !== 'done') return false;
  if (!writeBad(dir, { stem, cause, text, log, what })) {
    putBack(dir, claim, stem, attempt, log);
    return false;
  }
  settle(() => fsx.unlinkSync(claim), log, what);
  return true;
}

/** A tmp over STALE_MS old belongs to a spool that never renamed it: a whole one joins the waiting files, a torn one is set aside. True when one joined. */
function promoteTmp(dir: string, names: readonly string[], tenantId: string, log: Log): boolean {
  const now = Date.now();
  let promoted = false;
  for (const name of names) {
    const m = TMP.exec(name);
    if (m === null && !BAD_TMP.test(name)) continue;
    const file = path.join(dir, name);
    const what = `spool file ${name} not promoted`;
    let mtime = 0;
    let text = '';
    if (settle(() => { mtime = fsx.statSync(file).mtimeMs; }, log, what) !== 'done' || Math.abs(now - mtime) <= STALE_MS) continue;
    if (m === null) {
      // A `.bad` write cut off before its rename: its source goes only after that rename lands, so this copy is spare.
      settle(() => fsx.unlinkSync(file), log, `spool file ${name} not removed`);
      continue;
    }
    if (settle(() => { text = fsx.readFileSync(file, 'utf8'); }, log, what) !== 'done') continue;
    if (parseSpooled(text, tenantId) !== null) {
      if (settle(() => fsx.renameSync(file, file.slice(0, -'.tmp'.length)), log, what) === 'done') {
        log(`spool file ${name} was never renamed into place, promoted`);
        promoted = true;
      }
    } else if (writeBad(dir, { stem: m[1], cause: 'unreadable', text, log, what })) {
      settle(() => fsx.unlinkSync(file), log, what);
      log(`spool file ${name} was never finished, set aside as .bad`);
    }
  }
  return promoted;
}

/** Removes a claim once the store holds its summary; a claim left behind is imported again, so the log says so. */
function removeClaim(claim: string, name: string, log: Log): void {
  const removed = settleCode(() => fsx.unlinkSync(claim), log, `spool file ${name} claim not removed`);
  if (removed.settled === 'busy') log(`spool file ${name} saved; its claim could not be removed (${removed.code}); it will be imported again`);
}

interface ImportFailedOptions {
  readonly text: string;
  readonly recorded: boolean;
  readonly cause: unknown;
  readonly log: Log;
}

/** After an importer throw: a busy store stops the run with the count unchanged, any other error counts one try toward .bad. */
function importFailed(dir: string, claim: string, entry: Waiting, options: ImportFailedOptions): FileOutcome {
  const { text, recorded, cause, log } = options;
  const { name } = entry;
  const busy = isSqliteBusy(cause);
  if (recorded) {
    // The record stays `summarised`, so the stalled-record step of a later replay writes its items.
    log(busy ? `spool file ${name} saved; its memories wait for the next sleep (store busy)` : `spool file ${name} saved; writing its memories failed: ${errorMessage(cause)}`);
    return busy ? 'stop' : 'skipped';
  }
  if (busy) {
    putBack(dir, claim, entry.stem, entry.attempt, log);
    log(`spool file ${name} waits for the next run: the store is busy`);
    return 'stop';
  }
  const next = entry.attempt + 1;
  if (next < MAX_ATTEMPTS) {
    putBack(dir, claim, entry.stem, next, log);
    log(`spool file ${name} failed to import (try ${next} of ${MAX_ATTEMPTS}): ${errorMessage(cause)}`);
  } else if (moveBad(dir, claim, { stem: entry.stem, attempt: entry.attempt, cause: 'failed', log, raw: text })) {
    log(`spool file ${name} set aside as .bad after ${MAX_ATTEMPTS} tries: ${errorMessage(cause)}`);
  }
  return 'skipped';
}

/** Claims, reads and imports one waiting file; `stop` ends the run because the store is busy. */
function importFile(dir: string, entry: Waiting, tenantId: string, log: Log, importOne: SpoolImporter): FileOutcome {
  const { name } = entry;
  const claim = path.join(dir, `${entry.stem}.a${entry.attempt}.claim-${stamp(Date.now())}`);
  const taken = settleCode(() => fsx.renameSync(path.join(dir, name), claim), log, `spool file ${name} not claimed`);
  if (BUSY_CODES.has(taken.code)) log(`spool file ${name} is locked by another program, left for the next run`);
  if (taken.settled !== 'done') return 'skipped';
  let text = '';
  const read = settle(() => { text = fsx.readFileSync(claim, 'utf8'); }, log, `spool file ${name} not read`);
  if (read === 'gone') log(`spool file ${name} vanished`);
  if (read === 'busy') putBack(dir, claim, entry.stem, entry.attempt, log);
  if (read !== 'done') return 'skipped';
  const spooled = parseSpooled(text, tenantId);
  if (spooled === null) {
    if (moveBad(dir, claim, { stem: entry.stem, attempt: entry.attempt, cause: 'unreadable', log, raw: text })) log(`spool file ${name} is not readable, set aside as .bad`);
    return 'skipped';
  }
  let recorded = false;
  const markRecorded = (): void => {
    if (recorded) return;
    recorded = true;
    removeClaim(claim, name, log);
  };
  try {
    importOne(spooled, markRecorded);
    markRecorded();
    return 'imported';
  } catch (err) {
    return importFailed(dir, claim, entry, { text, recorded, cause: err, log });
  }
}

export interface SpoolCounts {
  waiting: number;
  stale: number;
  bad: number;
}

function mtimeOf(file: string): number | null {
  try {
    return fsx.statSync(file).mtimeMs;
  } catch (err) {
    const code = errCode(err);
    // Moved by a replay after the listing, or held by another program: left out of this count rather than failing it.
    if (code === 'ENOENT' || BUSY_CODES.has(code)) return null;
    throw err;
  }
}

/** What doctor reports, read only: files a replay should have taken by now, claims and tmp files a dead process left, and `.bad` files. */
export function spoolCounts(hippoRoot: string, now: Date, waitingAfterMs: number): SpoolCounts {
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
      const spooled = NEW_STEM.test(waiting[1]) ? created(waiting[1]) : mtimeOf(file);
      if (spooled !== null && at - spooled > waitingAfterMs) counts.waiting++;
    } else if (claim !== null || TMP.test(name)) {
      const since = claim?.claimedAt ?? mtimeOf(file);
      if (since !== null && Math.abs(at - since) > STALE_MS) counts.stale++;
    }
  }
  return counts;
}

/** One replayer at a time holds `replay.lock`, so only one process claims a file even where Windows lets two renames of it both land. */
export function importSpool(hippoRoot: string, tenantId: string, log: Log, deadline: number, importOne: SpoolImporter): number {
  const dir = path.join(hippoRoot, SPOOL_DIR);
  if (!fsx.existsSync(dir)) return 0;
  const mine = takeLock(dir, log);
  if (mine === null) return 0;
  try {
    if (!ownsLock(dir, mine.token, log)) return 0;
    const names = fsx.readdirSync(dir);
    const promoted = promoteTmp(dir, names, tenantId, log);
    const recovered = recoverStaleClaims(dir, names, log);
    let finished = 0;
    // Only promotion and recovery add waiting names, so the folder is listed again only after one of them did.
    for (const entry of waitingFiles(promoted || recovered ? fsx.readdirSync(dir) : names)) {
      if (Date.now() > deadline || !ownsLock(dir, mine.token, log)) break;
      const outcome = importFile(dir, entry, tenantId, log, importOne);
      if (outcome === 'imported') finished++;
      if (outcome === 'stop') break;
    }
    return finished;
  } finally {
    releaseLock(dir, mine, log);
  }
}
