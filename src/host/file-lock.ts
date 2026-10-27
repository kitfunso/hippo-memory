// A lock the operating system holds for a live process: BEGIN EXCLUSIVE on a small lock database
// takes a LockFileEx (win32) or fcntl (POSIX) lock that dies with its holder, so nothing ages or breaks one.
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
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
  /** Frees the lock; the file stays. Never throws, idempotent. */
  release(): void;
}

export type LockTake =
  | { readonly kind: 'taken'; readonly lock: FileLock }
  | { readonly kind: 'held' }
  | { readonly kind: 'unusable'; readonly cause: unknown };

const SQLITE_BUSY = 5;
// Two takers starting together can each fail the same EXCLUSIVE upgrade; a jittered retry lets one win.
const BUSY_TRIES = 2;
const BUSY_JITTER_MS = 4;
const pause = new Int32Array(new SharedArrayBuffer(4));
const MAX_ATTEMPTS = 3;

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

function holder(db: LockConnection, path: string): FileLock {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      closeLogged(db, path);
    },
  };
}

function beginExclusive(db: LockConnection): void {
  for (let tries = 1; ; tries++) {
    try {
      db.exec('BEGIN EXCLUSIVE');
      return;
    } catch (err) {
      if (primaryCode(err) !== SQLITE_BUSY || tries === BUSY_TRIES) throw err;
      Atomics.wait(pause, 0, 0, 1 + Math.random() * BUSY_JITTER_MS);
    }
  }
}

type Pass = LockTake | { readonly kind: 'again' };

/** One open, stat and lock. A changed or missing path, or a busy lock, is another pass: the file
 * is never unlinked under a taker, so only a prune's unlink can change the path. */
function onePass(path: string, stat: StatFn): Pass {
  let db: LockConnection | undefined;
  let opened: FileIdentity | undefined;
  try {
    db = new DatabaseSync(path, { timeout: 0 });
    opened = stat(path);
    beginExclusive(db);
    if (sameFile(opened, stat(path))) return { kind: 'taken', lock: holder(db, path) };
    closeLogged(db, path);
    return { kind: 'again' };
  } catch (err) {
    if (db !== undefined) closeLogged(db, path);
    if (primaryCode(err) === SQLITE_BUSY) return { kind: 'again' };
    // A prune that unlinked the path under this open fails the lock with an I/O error.
    return opened !== undefined && !sameFile(opened, stat(path))
      ? { kind: 'again' }
      : unusable(path, err);
  }
}

/** Takes the lock database at `path` (its folder must exist): taken, held by a live connection, or
 * unusable. Release only closes; the file stays for the next take. */
export function takeFileLock(path: string, stat: StatFn = statIdentity): LockTake {
  for (let pass = 0; pass < MAX_ATTEMPTS; pass++) {
    const result = onePass(path, stat);
    if (result.kind !== 'again') return result;
  }
  return { kind: 'held' };
}
