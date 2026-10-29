// The handle forms the root-keyed helpers open with: on the running test's session when its file holds one per test
// (sessionPerTest), else on a handle of their own, so a helper call costs what one call in a CLI command costs.
import type { DatabaseSyncLike, RequestStores } from '../../src/db/index.js';
import { grantFor, type HandleOptions, type SqliteStoreOptions } from '../../src/store/sqlite/runtime/grant.js';
import * as handles from '../../src/store/sqlite/runtime/handles.js';
import { type HandleOpener, type Handles, readWrite, type StoreFiles } from '../../src/store/sqlite/runtime/open.js';
import { sqliteStore as storeAt } from '../../src/store/sqlite/store.js';

const held: (() => RequestStores)[] = [];

/** Puts `session` under the helpers until the returned release runs; sessionPerTest holds one around each test. */
export function holdSession(session: () => RequestStores): () => void {
  held.push(session);
  return () => void held.splice(held.lastIndexOf(session), 1);
}

const heldSession = (): RequestStores | undefined => held.at(-1)?.();

export function sqliteStore(hippoRoot: string, opts?: SqliteStoreOptions): ReturnType<typeof storeAt> {
  return storeAt(hippoRoot, { ...opts, session: opts?.session ?? heldSession() });
}

export function storeFilesOf(hippoRoot: string, opts?: HandleOptions): StoreFiles {
  return handles.storeFilesOf(hippoRoot, { ...opts, session: opts?.session ?? heldSession() });
}

export function handlesOf(hippoRoot: string, opts?: HandleOptions): Handles {
  return handles.handlesOf(hippoRoot, { ...opts, session: opts?.session ?? heldSession() });
}

/** `onHandle` of the adapter; the held session's handle stays open after the call. */
export function onHandle<T>(hippoRoot: string, fn: (db: DatabaseSyncLike) => T, open: HandleOpener = readWrite): T {
  const opens = { grant: grantFor({ session: heldSession() }) };
  return handles.onHandle(hippoRoot, fn, (root) => open(root, opens));
}

/** `initStore` of the adapter, leaving the store's handle in the held session for the test's next call. */
export function initStore(hippoRoot: string): void {
  handles.initStore(hippoRoot, { session: heldSession() });
}
