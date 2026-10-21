// The store the HTTP and MCP end-to-end suites serve: hippo.db by default, memoryStore under HIPPO_TEST_STORE=memory,
// which the memory-store job in ci.yml sets. Only this file reads the variable; the suites import serve from here.
import { serve as serveOn, type ServeOpts, type ServerHandle } from '../../src/server.js';
import { memoryStore } from '../../src/store/memory/store.js';
import { loadTables } from './memory-tables.js';

export const onMemory = process.env.HIPPO_TEST_STORE === 'memory';

/** Why a test runs on hippo.db only, each under the group memoryStore leaves to hippo.db's folder. */
const NEEDS_HIPPO_DB = {
  db: {
    group: 'folder',
    reason: 'seeds or reads hippo.db beside the served store, which memoryStore copies once at boot',
  },
  team: {
    group: 'folder',
    reason: 'a store other than hippo.db serves a team: each caller names its project and no global store is in reach',
  },
  addon: { group: 'folder', reason: 'an add-on route with no storeReady runs only on hippo.db' },
  lock: { group: 'folder', reason: "tests hippo.db's write lock, worker threads or folder setup" },
  parity: { group: 'folder', reason: 'compares hippo.db with another store itself' },
  sleep: { group: 'sleep', reason: 'sleep and auto-sleep run on hippo.db' },
} as const;

/** True on the memory run, for `it.skipIf` / `describe.skipIf`; the key names the group and the reason. */
export function needsHippoDb(why: keyof typeof NEEDS_HIPPO_DB): boolean {
  return onMemory && NEEDS_HIPPO_DB[why] !== undefined;
}

/** serve() as the suites call it: on the memory run, a test that names no store of its own gets memoryStore over the
 * folder's rows as they stand at boot, through serve's own `store` option. */
export function serve(opts: ServeOpts): Promise<ServerHandle> {
  return serveOn(onMemory && !opts.store ? { ...opts, store: memoryStore(loadTables(opts.hippoRoot)) } : opts);
}
