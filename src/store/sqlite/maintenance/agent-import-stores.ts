// The agent-memories import's stores on hippo.db: each scores by the caller's rules, its container
// writes use the caller's lock wait, and a dry run's stand-in is a scratch folder deleted at close.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInitialized } from '../../../host/project-identity.js';
import { isStoreBusy } from '../../../base/ports/store.js';
import { sqliteAgentImport } from './agent-import.js';
import { handlesOf, initStore } from '../runtime/handles.js';
import { inPortTerms } from '../runtime/port-errors.js';
import { sqliteStore } from '../store.js';
import type { HippoDbTier, HippoDbStore } from '../../../base/ports/hippo-db.js';
import type { SqliteStoreOptions } from '../runtime/grant.js';

type SqliteImportStore = HippoDbStore & HippoDbTier;

interface SqliteImportStores {
  open(root: string, opts: { readonly busyWaitMs?: number }): SqliteImportStore;
  exists(root: string): boolean;
  create(root: string): Promise<void>;
  standIn(): SqliteImportStore;
  isBusy<E>(err: E): boolean;
}

/** The opener a CLI verb hands the sync; `opts` are the invoking root's rules, runtime and
 * session, which every store it opens takes. */
export function sqliteImportStores(opts: SqliteStoreOptions): SqliteImportStores {
  return {
    open: (root, { busyWaitMs }) => {
      const store = sqliteStore(root, opts);
      const agentImport = sqliteAgentImport(handlesOf(root, opts), busyWaitMs);
      return { ...store, hippoDb: { ...store.hippoDb, agentImport } };
    },
    exists: isInitialized,
    create: async (root) => inPortTerms(() => initStore(root, opts)),
    // Its folder is deleted at close, so no session of the caller's may keep one of its handles
    // open past that.
    standIn: () => standIn({ ...opts, session: undefined }),
    isBusy: isStoreBusy,
  };
}

function standIn(opts: SqliteStoreOptions): SqliteImportStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-agent-memories-'));
  initStore(root, opts);
  const store = sqliteStore(root, opts);
  return {
    ...store,
    close: async () => {
      await store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
