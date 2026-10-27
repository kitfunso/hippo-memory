// One session-end worker per session at a time, plus how far turn capture has read that session's
// transcript. Two fast replies would otherwise start two workers that both read the dedupe keys
// before either writes.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homeDir } from '../../host/agent-homes.js';
import { takeFileLock } from '../../host/file-lock.js';
import { errorCode, errorMessage, log as logger, errorFields } from '../../base/util/log.js';
import {
  isObjectLike,
  isStringValue,
  type ProgressCursor,
} from '../../base/session/capture-contract.js';
import { SESSION_ID_RE } from './copilot-transcript.js';
import type { SessionTurn } from './transcript.js';
import { blockHash } from '../../base/util/token-text.js';
import { HIPPO_DIR } from '../../base/util/agent-homes.js';
import { DAY_MS } from '../../base/util/time.js';
import { PRIVATE_DIR } from '../../host/private-dir.js';

/** A turn close runs after each reply; a full close runs once, when the session ends. */
export type WorkerMode = 'turn' | 'full';

interface SessionStateFiles {
  readonly lock: string;
  readonly queued: string;
  readonly cursor: string;
}

const sessionsDir = (): string => path.join(homeDir(), HIPPO_DIR, 'sessions');

/** Null for a missing id or one that could climb out of the sessions folder. */
function sessionStateFiles(sessionId: string | null): SessionStateFiles | null {
  if (sessionId === null || !SESSION_ID_RE.test(sessionId)) return null;
  const base = path.join(sessionsDir(), sessionId);
  return { lock: `${base}.lock.db`, queued: `${base}.queued`, cursor: `${base}.cursor.json` };
}

const warnedLocks = new Set<string>();

// The lock is best-effort, so the work still runs; the line says why it ran without one.
function warnUnusableLockOnce<E>(lock: string, cause: E): void {
  if (warnedLocks.has(lock)) return;
  warnedLocks.add(lock);
  const why = `${errorCode(cause) || 'no errno'}: ${errorMessage(cause)}`;
  logger.warn(
    `session worker: lock ${lock} cannot be taken (${why}), so the work runs without it`,
    errorFields(cause),
  );
}

/** False when the request could not be queued; the caller then refuses the run, since an
 * unlocked worker could race a live one. */
function queueRun(files: SessionStateFiles, mode: WorkerMode): boolean {
  try {
    fs.mkdirSync(path.dirname(files.queued), PRIVATE_DIR);
  } catch (err) {
    logger.warn(
      `session worker: cannot create ${path.dirname(files.queued)}, ` +
        `so the ${mode} close is not run: ${errorMessage(err)}`,
      errorFields(err),
    );
    return false;
  }
  try {
    // A full close outranks a turn close: it overwrites a queued turn, and a turn never replaces a
    // queued full close.
    if (mode === 'full') fs.writeFileSync(files.queued, 'full');
    else fs.writeFileSync(files.queued, 'turn', { flag: 'wx' });
    return true;
  } catch (err) {
    if (errorCode(err) === 'EEXIST') return true;
    logger.warn(
      `session worker: cannot queue the ${mode} close in ${files.queued}, so it is not run: ${errorMessage(err)}`,
      errorFields(err),
    );
    return false;
  }
}

/** Takes the queued request by renaming it, so one queued while this reads it lands in a fresh
 * file. */
function takeQueued(queued: string): WorkerMode | null {
  const taken = `${queued}.${process.pid}`;
  try {
    fs.renameSync(queued, taken);
  } catch (err) {
    // ENOENT means nothing is queued; any other refusal leaves the request queued for the next
    // round, but is told.
    if (errorCode(err) !== 'ENOENT') {
      logger.warn(
        `session worker: cannot take the queued request ${queued}: ${errorMessage(err)}`,
        errorFields(err),
      );
    }
    return null;
  }
  try {
    return fs.readFileSync(taken, 'utf8') === 'full' ? 'full' : 'turn';
  } finally {
    fs.rmSync(taken, { force: true });
  }
}

/** Runs `work` unless a live worker holds this session, which then runs the request after its
 * own so the last reply is never dropped. */
export async function runSessionWorker(
  sessionId: string | null,
  mode: WorkerMode,
  work: (mode: WorkerMode) => Promise<void>,
): Promise<void> {
  const files = sessionStateFiles(sessionId);
  if (files === null) return work(mode);
  if (!queueRun(files, mode)) return;
  for (let take = takeFileLock(files.lock); take.kind !== 'held'; take = takeFileLock(files.lock)) {
    if (take.kind === 'unusable') {
      warnUnusableLockOnce(files.lock, take.cause);
      return work(mode);
    }
    let ran = false;
    try {
      for (let next = takeQueued(files.queued); next !== null; next = takeQueued(files.queued)) {
        ran = true;
        await work(next);
      }
    } finally {
      take.lock.release();
    }
    // A request queued after the last take found the lock still held and left, so it runs here.
    if (!ran || !fs.existsSync(files.queued)) return;
  }
}

function turnKey(turn: SessionTurn): string {
  return blockHash(`${turn.role}\n${turn.text}`);
}

/** The cursor position after `turns`: how many there were and a hash of the last. */
export function turnPosition(turns: readonly SessionTurn[]): string {
  return turns.length === 0 ? '0:' : `${turns.length}:${turnKey(turns[turns.length - 1])}`;
}

/** The turns after `position`; all of them when it is null or its last turn is no longer in
 * view. */
export function turnsAfter(
  turns: readonly SessionTurn[],
  position: string | null,
): readonly SessionTurn[] {
  if (position === null) return turns;
  const [countText, key] = position.split(':');
  const count = Number(countText);
  if (!Number.isInteger(count) || count <= 0) return turns;
  if (count <= turns.length && turnKey(turns[count - 1]) === key) return turns.slice(count);
  // A transcript too big to read whole is read from its tail, so the count shifts; the last turn's
  // text still marks the place.
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turnKey(turns[i]) === key) return turns.slice(i + 1);
  }
  return turns;
}

/** The saved position for this session's transcript; null when none was saved, it names another
 * file, or it is unreadable. */
export function loadTurnPosition(sessionId: string, transcriptPath: string): string | null {
  const file = sessionStateFiles(sessionId)?.cursor;
  if (!file || !fs.existsSync(file)) return null;
  try {
    const cursor: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isObjectLike(cursor) || !('source' in cursor) || cursor.source !== transcriptPath) {
      return null;
    }
    return 'position' in cursor && isStringValue(cursor.position) ? cursor.position : null;
  } catch (err) {
    // A torn cursor means the next capture reads every turn, which the dedupe keys absorb.
    if (err instanceof SyntaxError) return null;
    logger.warn(
      `session worker: cannot read the cursor ${file}: ${errorMessage(err)}`,
      errorFields(err),
    );
    return null;
  }
}

export function saveTurnPosition(
  sessionId: string,
  transcriptPath: string,
  turns: readonly SessionTurn[],
  log: (message: string) => void,
): void {
  const file = sessionStateFiles(sessionId)?.cursor;
  if (!file) return;
  const cursor: ProgressCursor = {
    runtime: 'vscode',
    sessionId,
    source: transcriptPath,
    position: turnPosition(turns),
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), PRIVATE_DIR);
    fs.writeFileSync(tmp, JSON.stringify(cursor));
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows refuses the rename (EPERM) while another process has the cursor open; the next reply
    // re-reads these turns, which the dedupe keys absorb.
    log(`cursor not saved: ${errorMessage(err)}`);
  }
}

const WIN32 = process.platform === 'win32';
const CURSOR_TMP = /\.cursor\.json\.\d+\.tmp$/;
const CURSOR_MAX_AGE_MS = 30 * DAY_MS;

/** A text lock from before 3.0 names no process any more, so a day old is long dead. */
const LEGACY_LOCK_MAX_AGE_MS = DAY_MS;

/** Age limit in ms for a file in the sessions folder that a prune may remove; null for any other. */
function pruneLimit(name: string): number | null {
  if (name.endsWith('.cursor.json') || CURSOR_TMP.test(name)) return CURSOR_MAX_AGE_MS;
  return name.endsWith('.lock') ? LEGACY_LOCK_MAX_AGE_MS : null;
}

const LOCK_DB = '.lock.db';
const BUSY_UNLINK = new Set(['EBUSY', 'EPERM', 'EACCES']);

/** A session's lock database is idle when it has no queued request and its cursor is gone or
 * past its age. */
function lockDbIdle(dir: string, id: string, nowMs: number): boolean {
  if (fs.existsSync(path.join(dir, `${id}.queued`))) return false;
  const cursor = fs.statSync(path.join(dir, `${id}.cursor.json`), { throwIfNoEntry: false });
  return cursor === undefined || nowMs - cursor.mtimeMs >= CURSOR_MAX_AGE_MS;
}

/** Removes an idle lock database after taking it; win32 cannot unlink an open file, so it
 * releases first and leaves the file when another taker opened it. */
function removeIdleLockDb(file: string): boolean {
  const take = takeFileLock(file);
  if (take.kind !== 'taken') return false;
  try {
    if (!WIN32) fs.unlinkSync(file);
  } finally {
    take.lock.release();
  }
  if (WIN32) {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if (BUSY_UNLINK.has(errorCode(err))) return false;
      throw err;
    }
  }
  return true;
}

/** Removes cursor files and leftovers of the old text locks past their age, and the lock database
 * of a session that is idle. Never throws; returns the number removed. */
export function pruneSessionFiles(nowMs: number): number {
  const dir = sessionsDir();
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') {
      logger.warn(`session worker: cannot prune ${dir}: ${errorMessage(err)}`, errorFields(err));
    }
    return 0;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (name.endsWith(LOCK_DB)) {
        const idle = lockDbIdle(dir, name.slice(0, -LOCK_DB.length), nowMs);
        if (idle && removeIdleLockDb(file)) removed++;
        continue;
      }
      const limit = pruneLimit(name);
      if (limit === null) continue;
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (stat === undefined || !stat.isFile() || nowMs - stat.mtimeMs < limit) continue;
      fs.rmSync(file, { force: true });
      removed++;
    } catch (err) {
      logger.warn(`session worker: cannot prune ${file}: ${errorMessage(err)}`, errorFields(err));
    }
  }
  return removed;
}
