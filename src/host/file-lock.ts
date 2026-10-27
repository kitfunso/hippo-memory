// A lock the operating system holds for a live process: BEGIN IMMEDIATE on a small lock database
// takes the RESERVED lock (LockFileEx on win32, fcntl on POSIX), which one connection holds and which dies with it.
// Only a holder unlinks the file, at release; a take checks the path names the same file before its open and after its lock.
import { createRequire } from 'node:module';
import { closeSync, openSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { errorCode, errorFields, errorMessage, log } from '../base/util/log.js';

const require = createRequire(import.meta.url);

interface LockConnection {
  exec(sql: string): void;
  close(): void;
}

// SAFETY: node:sqlite's DatabaseSync has this constructor shape at runtime (the built-in module
// ships no bundled types here); this require plus cast is the module's boundary, as in src/db/sqlite.ts.
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => LockConnection;
};

/** What a path names: a recreated file differs in at least one field. */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly ctimeNs: bigint;
}

/** The identity of the file at `path`, or undefined when there is none. */
export type StatFn = (path: string) => FileIdentity | undefined;

export interface FileLock {
  /** Frees the lock and removes the file when no other taker has it open. Never throws, idempotent. */
  release(): void;
}

export type LockTake =
  | { readonly kind: 'taken'; readonly lock: FileLock }
  | { readonly kind: 'held' }
  | { readonly kind: 'unusable'; readonly cause: unknown };

const SQLITE_BUSY = 5;
// IMMEDIATE needs only RESERVED, which one connection holds; EXCLUSIVE would also wait on a SHARED lock.
const MAX_ATTEMPTS = 3;
const MAX_CREATES = 10;
const WIN32 = process.platform === 'win32';
// win32 refuses an unlink while another taker has the file open; that taker unlinks at its own release.
const OPEN_FILE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

// bigint, since a win32 file index can pass 2^53
const statIdentity: StatFn = (path) => {
  const s = statSync(path, { bigint: true, throwIfNoEntry: false });
  return s === undefined ? undefined : { dev: s.dev, ino: s.ino, ctimeNs: s.ctimeNs };
};

const sameFile = (a: FileIdentity | undefined, b: FileIdentity | undefined): boolean =>
  a !== undefined &&
  b !== undefined &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.ctimeNs === b.ctimeNs;

function hasErrcode<E>(err: E): err is E & { errcode: number } {
  return err instanceof Error && 'errcode' in err && typeof err.errcode === 'number';
}

/** node:sqlite reports the extended code, so only the low byte names the primary result. */
function primaryCode<E>(err: E): number | undefined {
  return hasErrcode(err) ? err.errcode & 0xff : undefined;
}

function closeLogged(db: LockConnection, path: string): void {
  try {
    db.close();
  } catch (err) {
    log.warn(`lock database ${path} did not close: ${errorMessage(err)}`, errorFields(err));
  }
}

/** The open error, with the folder's errno named when the folder itself cannot be read. */
function unusable<E>(path: string, err: E): LockTake {
  try {
    statSync(dirname(path));
    return { kind: 'unusable', cause: err };
  } catch (folderErr) {
    const cause = new Error(`${errorMessage(err)} (folder ${errorCode(folderErr)})`, {
      cause: err,
    });
    return { kind: 'unusable', cause: Object.assign(cause, { errcode: primaryCode(err) }) };
  }
}

function unlinkIfHeld(path: string, held: FileIdentity, stat: StatFn): void {
  try {
    if (!sameFile(stat(path), held)) return;
    unlinkSync(path);
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT' || (WIN32 && OPEN_FILE_CODES.has(code))) return;
    log.warn(`lock file ${path} was not removed: ${errorMessage(err)}`, errorFields(err));
  }
}

function holder(db: LockConnection, path: string, held: FileIdentity, stat: StatFn): FileLock {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        if (WIN32) closeLogged(db, path);
        unlinkIfHeld(path, held, stat);
      } finally {
        if (!WIN32) closeLogged(db, path);
      }
    },
  };
}

type Pass =
  | LockTake
  | { readonly kind: 'again'; readonly created: boolean; readonly ioError?: unknown };
const AGAIN: Pass = { kind: 'again', created: false };
const NO_FILE: Pass = { kind: 'again', created: true };

/** Creates the lock file when it is missing, so the stat before the open has a file to name. */
function statOrCreate(path: string, stat: StatFn): FileIdentity | undefined {
  const found = stat(path);
  if (found !== undefined) return found;
  closeSync(openSync(path, 'a'));
  return stat(path);
}

/** True when the path no longer names `before`; a stat that fails counts as unchanged. */
function pathMoved(path: string, before: FileIdentity | undefined, stat: StatFn): boolean {
  if (before === undefined) return false;
  try {
    return !sameFile(before, stat(path));
  } catch (err) {
    log.warn(`lock file ${path} could not be checked: ${errorMessage(err)}`, errorFields(err));
    return false;
  }
}

function onePass(path: string, stat: StatFn): Pass {
  let before: FileIdentity | undefined;
  let db: LockConnection | undefined;
  try {
    before = statOrCreate(path, stat);
    if (before === undefined) return NO_FILE;
    db = new DatabaseSync(path);
    // A take writes no file but the lock database, so no two generations of the file share a journal.
    db.exec('PRAGMA journal_mode=MEMORY');
    db.exec('BEGIN IMMEDIATE');
    if (sameFile(before, stat(path))) {
      return { kind: 'taken', lock: holder(db, path, before, stat) };
    }
    closeLogged(db, path);
    return AGAIN;
  } catch (err) {
    if (db !== undefined) closeLogged(db, path);
    if (primaryCode(err) === SQLITE_BUSY) return { kind: 'held' };
    // Another holder's release, between the stat and the lock, fails this open or lock.
    return pathMoved(path, before, stat) ? AGAIN : unusable(path, err);
  }
}

/** Takes the lock database at `path` (its folder must exist): taken, held by a live connection, or
 * unusable. Only a holder unlinks, at release; a take checks the file across its open. */
export function takeFileLock(path: string, stat: StatFn = statIdentity): LockTake {
  let passes = 0;
  let creates = 0;
  while (passes < MAX_ATTEMPTS && creates < MAX_CREATES) {
    const result = onePass(path, stat);
    if (result.kind !== 'again') return result;
    if (result.created) creates++;
    else passes++;
  }
  return { kind: 'held' };
}
