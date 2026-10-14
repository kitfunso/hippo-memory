import { type StoreContext, adminActor } from '../api/index.js';
import { sqliteStore } from '../store/sqlite/store.js';

// The one place the CLI names its audit actor and builds its store; root is a parameter because some verbs target the global store.
export function cliApiContext(hippoRoot: string, tenantId: string): StoreContext {
  return { hippoRoot, tenantId, actor: adminActor('cli'), store: sqliteStore(hippoRoot) };
}
