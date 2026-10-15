import { type ContextWith, adminActor } from '../api/index.js';
import type { HippoStore, StoreGroup, StoreGroups } from '../store/index.js';
import { sqliteStore } from '../store/sqlite/store.js';

/** The store the CLI and the stdio MCP server open; the adapter is named here so src/mcp never imports it. */
export function cliStore(hippoRoot: string): HippoStore & StoreGroups {
  return sqliteStore(hippoRoot);
}

// The one place the CLI names its audit actor and builds its store;
// root is a parameter because some verbs target the global store.
export function cliApiContext(hippoRoot: string, tenantId: string): ContextWith<StoreGroup> {
  return { hippoRoot, tenantId, actor: adminActor('cli'), store: cliStore(hippoRoot) };
}
