// A lock the operating system holds for a live process: BEGIN IMMEDIATE on a small lock database
// takes the RESERVED lock (LockFileEx on win32, fcntl on POSIX), which one connection holds and which dies with it.
import { createRequire } from 'node:module';
import { statSync, unlinkSync } from 'node:fs';
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

/** What a path names. Only an old file is removed, so a file created later differs from it in ctime. */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly ctimeNs: bigint;
}

/** The identity of the file at `path`, or undefined when there is none. */
export type StatFn = (path: string) => FileIdentity | undefined;

export interface FileLock {
  release(): void;
  remove(cutoffMs: number): void;
}

export type LockTake =
  | { readonly kind: 'taken'; readonly lock: FileLock }
  | { readonly kind: 'held' }
  | { readonly kind: 'unusable'; readonly cause: unknown };

const SQLITE_BUSY = 5;
const NS_PER_MS = 1_000_000n;
const MAX_ATTEMPTS = 3;
const MAX_CREATES = 10;
const WIN32 = process.platform === 'win32';
// win32 refuses an unlink while another taker has the file open; the next prune retries.
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

// node:sqlite closes a connection it garbage-collects, which would free a lock whose FileLock nobody
// references; a held connection stays reachable here until release() or remove(), or its thread ends.
const heldConnections = new Set<LockConnection>();

function holder(db: LockConnection, path: string, held: FileIdentity, stat: StatFn): FileLock {
  heldConnections.add(db);
  let done = false;
  const finish = (unlink: boolean): void => {
    if (done) return;
    done = true;
    heldConnections.delete(db);
    try {
      if (WIN32) closeLogged(db, path);
      if (unlink) unlinkIfHeld(path, held, stat);
    } finally {
      if (!WIN32) closeLogged(db, path);
    }
  };
  return {
    release: () => finish(false),
    remove: (cutoffMs) => finish(held.ctimeNs <= BigInt(Math.trunc(cutoffMs)) * NS_PER_MS),
  };
}

type Pass =
  | LockTake
  | { readonly kind: 'again'; readonly created: boolean; readonly failure?: unknown };
const AGAIN: Pass = { kind: 'again', created: false };
const NO_FILE: Pass = { kind: 'again', created: true };

/** Creates the missing lock file through SQLite: a raw descriptor closed here would drop this process's other locks. */
function createViaSqlite(path: string): void {
  new DatabaseSync(path).close();
}

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
  let opening = false;
  try {
    before = stat(path);
    if (before === undefined) {
      createViaSqlite(path);
      return NO_FILE;
    }
    opening = true;
    db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=MEMORY');
    // IMMEDIATE needs only RESERVED, which one connection holds; EXCLUSIVE would also wait on a SHARED lock.
    db.exec('BEGIN IMMEDIATE');
    if (sameFile(before, stat(path))) {
      return { kind: 'taken', lock: holder(db, path, before, stat) };
    }
    closeLogged(db, path);
    return AGAIN;
  } catch (err) {
    if (db !== undefined) closeLogged(db, path);
    if (primaryCode(err) === SQLITE_BUSY) return { kind: 'held' };
    if (!opening) return { kind: 'again', created: true, failure: err };
    return pathMoved(path, before, stat) ? AGAIN : unusable(path, err);
  }
}

/** Takes the lock database at `path` (its folder must exist): taken, held, or unusable. `held` also
 * covers a file removed under every pass: an old file's prune, which re-checks the queue. */
export function takeFileLock(path: string, stat: StatFn = statIdentity): LockTake {
  let passes = 0;
  let creates = 0;
  let failure: unknown;
  while (passes < MAX_ATTEMPTS && creates < MAX_CREATES) {
    const result = onePass(path, stat);
    if (result.kind !== 'again') return result;
    failure = result.failure;
    if (result.created) creates++;
    else passes++;
  }
  return failure === undefined ? { kind: 'held' } : unusable(path, failure);
}
