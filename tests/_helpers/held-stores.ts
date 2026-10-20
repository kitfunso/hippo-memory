// A test's stores stay held open from their first close until the test ends, as `hippo serve` holds its store: no store
// call's close is then SQLite's last, which checkpoints the WAL with two flushes and deletes it.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { basename, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Taken as this module loads, so a test that spies on them or counts their calls never sees a hold's.
const { existsSync, realpathSync } = fs;

interface Connection {
  exec(sql: string): void;
  prepare(sql: string): { get(): object | undefined };
  close(): void;
  readonly isOpen?: boolean;
}
interface ConnectionOptions {
  readonly readOnly?: boolean;
}
type ConnectionClass = new (path: string | URL | Buffer, options?: ConnectionOptions) => Connection;

interface Held {
  readonly db: Connection;
  readonly names: readonly string[];
}

declare global {
  // On globalThis: tests/_held-stores-setup.ts patches node:sqlite once per worker, and each test file loads this module anew.
  var hippoHeldStores: Map<string, Held> | undefined;
  var hippoNeverHeld: Set<string> | undefined;
  var hippoUnheldConnection: ConnectionClass | undefined;
}
const held = (globalThis.hippoHeldStores ??= new Map<string, Held>());
const neverHeld = (globalThis.hippoNeverHeld ??= new Set<string>());
// SAFETY: node:sqlite's DatabaseSync has this shape at runtime, as src/db/sqlite.ts states; no types ship for it here.
const sqlite = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: ConnectionClass };

/** `path` as given and as the disk names it: src opens a store by its realpath, while a test may name its folder by an
 *  8.3 short form on Windows or by a symlink such as macOS's /var. */
function forms(path: string): string[] {
  const at = resolve(path);
  return existsSync(at) ? [...new Set([at, realpathSync.native(at)])] : [at];
}

function under(file: string, at: string): boolean {
  return file === at || file.startsWith(at + sep) || at.startsWith(`${file}-`);
}

function anyUnder(names: readonly string[], ats: readonly string[]): boolean {
  return names.some((file) => ats.some((at) => under(file, at)));
}

/** Whether `at` ends in a name along a held store's path: only such a path can be another form of the store's own,
 *  so only it is looked up on the disk. */
function mayName(at: string): boolean {
  const last = basename(at)
    .toLowerCase()
    .replace(/-(wal|shm|journal)$/, '');
  return [...held.values()].some(({ names }) => names.some((name) => name.toLowerCase().split(sep).includes(last)));
}

/** A connection that holds the WAL store `file`, or undefined while SQLite will not read it or it is not in WAL mode
 *  yet: a store locked whole or still on a rollback journal is held at a later close instead. */
function holder(file: string): Connection | undefined {
  const Unheld = globalThis.hippoUnheldConnection ?? sqlite.DatabaseSync;
  let db: Connection | undefined;
  try {
    db = new Unheld(file);
    // Its close is the store's last, and the store is deleted after the test, so that checkpoint flushes nothing.
    db.exec('PRAGMA synchronous = OFF');
    // A read opens the WAL and takes the shared lock that keeps every other close from being the last.
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    if (Object.values(db.prepare('PRAGMA journal_mode').get() ?? {})[0] === 'wal') return db;
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'ERR_SQLITE_ERROR')) throw err;
  }
  db?.close();
  return undefined;
}

function hold(file: string): void {
  // An open of a missing file would create it.
  if (held.has(file) || !existsSync(file)) return;
  const names = forms(file);
  if (anyUnder(names, [...neverHeld])) return;
  const db = holder(file);
  if (db) held.set(file, { db, names });
}

/** Makes every hippo.db connection hold its store as it closes; tests/_held-stores-setup.ts calls it once per worker,
 *  before any test file loads src/db/sqlite.ts. */
export function holdStoresOnClose(): void {
  const Unheld = (globalThis.hippoUnheldConnection = sqlite.DatabaseSync);
  sqlite.DatabaseSync = class extends Unheld {
    readonly #file: string | undefined;
    constructor(...args: ConstructorParameters<ConnectionClass>) {
      // As given: node:sqlite refuses an options argument that is there but undefined.
      super(...args);
      const [path] = args;
      const name = path instanceof URL ? fileURLToPath(path) : String(path);
      this.#file = basename(name) === 'hippo.db' ? resolve(name) : undefined;
    }
    override close(): void {
      if (this.#file !== undefined && this.isOpen !== false) hold(this.#file);
      super.close();
    }
  };
}

/** Closes the held stores at or under `path`, or whose -wal or -shm file it is; every one without it. */
export function releaseHeldStores(path?: string): void {
  // Every file a test or src reads, removes or writes comes through here, so this stays off the disk where it can.
  if (held.size === 0) return;
  const ats = path === undefined ? undefined : mayName(path) ? forms(path) : [resolve(path)];
  for (const [file, { db, names }] of held) {
    if (ats !== undefined && !anyUnder(names, ats)) continue;
    db.close();
    held.delete(file);
  }
}

/** For a test of what a store's last close leaves, or of a lock on the whole file: the stores at or under `path` are
 *  let go now and never held again. */
export function neverHold(path: string): void {
  releaseHeldStores(path);
  for (const at of forms(path)) neverHeld.add(at);
}
