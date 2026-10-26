// The store the HTTP and MCP end-to-end suites serve: hippo.db by default, a port-only store under
// HIPPO_TEST_STORE=port-only, which the port-only job in ci.yml sets. Only this file reads the variable.
import { serve as serveOn, type ServeOptions, type ServerHandle } from '../../src/server.js';
import { portOnlyStore } from './port-only-store.js';

export const onPortOnly = process.env.HIPPO_TEST_STORE === 'port-only';

/** Why a test runs on hippo.db only, each under the groups a port-only store leaves out. */
const NEEDS_HIPPO_DB = {
  db: {
    group: 'folder',
    reason: 'reads or writes hippo.db itself while the server runs, which a port-only store blocks',
  },
  team: {
    group: 'folder',
    reason: 'a port-only store serves a team: each caller names its project and no global store is in reach',
  },
  addon: { group: 'folder', reason: 'an add-on route with no storeReady runs only on hippo.db' },
  lock: { group: 'folder', reason: "tests hippo.db's write lock, worker threads or folder setup" },
  parity: { group: 'folder', reason: 'compares hippo.db with a port-only store itself' },
  sleep: { group: 'sleep', reason: 'sleep and auto-sleep need the consolidation group a port-only store leaves out' },
} as const;

/** True on the port-only run, for `it.skipIf` / `describe.skipIf`; the key names the group and the reason. */
export function needsHippoDb(why: keyof typeof NEEDS_HIPPO_DB): boolean {
  return onPortOnly && NEEDS_HIPPO_DB[why] !== undefined;
}

/** serve() as the suites call it: on the port-only run, a test that names no store of its own gets hippo.db's store
 * through the port alone, without its folder groups and under a kind that is not 'sqlite'. A path that skips the port
 * is caught by tests/server/server-no-direct-open.server.test.ts, which serves a folder marked for another store. */
export function serve(opts: ServeOptions): Promise<ServerHandle> {
  if (!onPortOnly || opts.store) return serveOn(opts);
  return serveOn({ ...opts, store: portOnlyStore(opts.hippoRoot) });
}
