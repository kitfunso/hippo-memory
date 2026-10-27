// A lock the operating system holds for a live process: BEGIN EXCLUSIVE on a small lock database
// takes a LockFileEx (win32) or fcntl (POSIX) lock that dies with its holder, so nothing ages or breaks one.
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
  DatabaseSync: new (path: string, options?: { timeout?: number }) => LockConnection;
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
  /** Frees the lock and removes its file when the path still names it; never throws, idempotent. */
  release(): void;
}

export type LockTake =
  | { readonly kind: 'taken'; readonly lock: FileLock }
  | { readonly kind: 'held' }
  | { readonly kind: 'unusable'; readonly cause: unknown };

const SQLITE_BUSY = 5;
// Two takers starting together can each fail the same EXCLUSIVE upgrade; a short wait lets one win.
const BUSY_WAIT_MS = 25;
const MAX_ATTEMPTS = 4;
const MAX_MISMATCHES = 2;
const WIN32 = process.platform === 'win32';
const WIN32_OPEN_FILE = new Set(['EBUSY', 'EPERM', 'EACCES']);

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
    if (code === 'ENOENT' || (WIN32 && WIN32_OPEN_FILE.has(code))) return;
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
        // win32 refuses an unlink of an open file; POSIX lets only this holder unlink, while it holds.
        if (WIN32) closeLogged(db, path);
        unlinkIfHeld(path, held, stat);
      } finally {
        if (!WIN32) closeLogged(db, path);
      }
    },
  };
}

type Pass = LockTake | { readonly kind: 'again'; readonly mismatch: boolean };

function onePass(path: string, stat: StatFn): Pass {
  let db: LockConnection | undefined;
  let before: FileIdentity | undefined;
  try {
    before = stat(path);
    db = new DatabaseSync(path, { timeout: BUSY_WAIT_MS });
    db.exec('BEGIN EXCLUSIVE');
    const after = stat(path);
    if (after !== undefined && sameFile(before, after)) {
      return { kind: 'taken', lock: holder(db, path, after, stat) };
    }
    closeLogged(db, path);
    // A missing `before` is the first pass (the open made the file); anything else is a releaser's unlink.
    return { kind: 'again', mismatch: before !== undefined || after === undefined };
  } catch (err) {
    if (db !== undefined) closeLogged(db, path);
    if (primaryCode(err) !== SQLITE_BUSY) return unusable(path, err);
    // Busy on a missing file means another taker's first pass holds it until its next pass.
    return before === undefined ? { kind: 'again', mismatch: false } : { kind: 'held' };
  }
}

/** Takes the lock database at `path` (its folder must exist): taken, held by a live connection, or
 * unusable. A false `held` is safe: it needs a releaser's unlink between this open and this lock, or
 * a busy result for as many passes as another taker's first pass lasts; a releaser's own re-check
 * and that taker's next pass then run the work. */
export function takeFileLock(path: string, stat: StatFn = statIdentity): LockTake {
  let mismatches = 0;
  for (let pass = 0; pass < MAX_ATTEMPTS; pass++) {
    const result = onePass(path, stat);
    if (result.kind !== 'again') return result;
    if (result.mismatch && ++mismatches >= MAX_MISMATCHES) break;
  }
  return { kind: 'held' };
}
