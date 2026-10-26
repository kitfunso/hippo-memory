// One request's handles per test, closed after it, so a test's store calls share one handle per store as a CLI
// command's do; a test that opens and closes hippo.db on every call pays a WAL checkpoint each time.
import { afterEach, beforeEach, expect } from 'vitest';
import type { Objects } from '../../src/base/ports/store.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import { openHippoDb, RequestStores, type DatabaseSyncLike } from '../../src/db/index.js';
import { readEntryIn, writeEntryIn, type WriteEntryOptions } from '../../src/store/sqlite/fixtures.js';
import { grantFor } from '../../src/store/sqlite/grant.js';
import { storeFilesOf } from '../../src/store/sqlite/handles.js';
import type { StoreFiles } from '../../src/store/sqlite/open.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { apiCtx, onSession } from './api-ctx.js';
import { objectsAt } from './objects-at.js';
import { holdSession } from './test-session.js';

/** The forms a test calls, each on the running test's session; a file takes the ones it uses under their own names. */
export interface TestSession {
  readonly session: () => RequestStores;
  readonly writeEntry: (hippoRoot: string, entry: MemoryEntry, opts?: WriteEntryOptions) => void;
  /** The row with `id` in any tenant, or null. */
  readonly readEntry: (hippoRoot: string, id: string) => MemoryEntry | null;
  readonly sqliteStore: typeof sqliteStore;
  readonly apiCtx: typeof apiCtx;
  readonly objectsAt: (hippoRoot: string) => Objects;
  /** The session's handle on the store, which closeHippoDb leaves open; a test that needs a second connection opens one. */
  readonly sessionDb: (hippoRoot: string) => DatabaseSyncLike;
}

/** A session for each test, opened on its first call and closed after it; the root-keyed helpers open on it too.
 * After-hooks run last-registered first, so call it below any afterEach that removes a test's store folder. */
export function sessionPerTest(): TestSession {
  let current: { readonly session: RequestStores; readonly files: Map<string, StoreFiles> } | undefined;
  let release = (): void => {};
  // Only this scope's tests lend the session to the root-keyed helpers, since only they run the close below.
  beforeEach(() => {
    release = holdSession(() => running().session);
  });
  afterEach(() => {
    release();
    current?.session.close();
    current = undefined;
  });
  const running = () => {
    // A beforeAll seed would hold the handle into the first test, so only a test and its hooks get one.
    if (expect.getState().currentTestName === undefined) throw new Error('sessionPerTest: no test is running');
    current ??= { session: new RequestStores(), files: new Map() };
    return current;
  };
  const session = () => running().session;
  // One StoreFiles per folder for the test, so its writes share one project walk as one store's do.
  const files = (hippoRoot: string): StoreFiles => {
    const { files: built } = running();
    const made = built.get(hippoRoot) ?? storeFilesOf(hippoRoot, { session: session() });
    built.set(hippoRoot, made);
    return made;
  };
  return {
    session,
    writeEntry: (hippoRoot, entry, opts) => writeEntryIn(files(hippoRoot), entry, opts),
    readEntry: (hippoRoot, id) => readEntryIn(files(hippoRoot), id),
    sqliteStore: (hippoRoot, opts) => sqliteStore(hippoRoot, { ...opts, session: opts?.session ?? session() }),
    apiCtx: (...args) => onSession(apiCtx(...args), session()),
    objectsAt: (hippoRoot) => objectsAt(hippoRoot, session()),
    sessionDb: (hippoRoot) => openHippoDb(hippoRoot, { grant: grantFor({ session: session() }) }),
  };
}
