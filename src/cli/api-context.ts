import { type ContextWith, adminActor } from '../api/index.js';
import { consolidate } from '../consolidate/sleep.js';
import type { McpHost } from '../mcp/protocol.js';
import type { HippoStore, StoreGroup, StoreGroups } from '../store/index.js';
import { runDetachedSqliteRequest, runSqliteRequest, sqliteReach, sqliteStore } from '../store/sqlite/store.js';

/** The store the CLI and the stdio MCP server open; the adapter is named here so src/mcp never imports it. */
function cliStore(hippoRoot: string): HippoStore & StoreGroups {
  return sqliteStore(hippoRoot);
}

/** The request scope a scoped CLI verb and the stdio MCP server run in; named here so no other surface opens one. */
export function cliRequest<T>(run: () => T | Promise<T>): Promise<T> {
  return runSqliteRequest(run, 'cli');
}

// The one place the CLI names its audit actor and builds its store;
// root is a parameter because some verbs target the global store.
export function cliApiContext(hippoRoot: string, tenantId: string): ContextWith<StoreGroup> {
  const store = cliStore(hippoRoot);
  return { hippoRoot, tenantId, actor: adminActor('cli'), store, reach: sqliteReach(hippoRoot, store) };
}

/** Stdio is the operator's own process: host admin, the folder's hippo.db, and an auto-sleep that runs in process. */
export const cliStdioHost: McpHost = {
  contextFor(hippoRoot, tenantId) {
    const store = cliStore(hippoRoot);
    return {
      hippoRoot,
      tenantId,
      actor: 'mcp',
      role: 'admin',
      hostAdmin: true,
      stdio: true,
      store,
      reach: sqliteReach(hippoRoot, store),
      autoSleepRunner: (root) => runDetachedSqliteRequest(() => consolidate(root)).then(() => {}),
    };
  },
  runRequest: cliRequest,
};
