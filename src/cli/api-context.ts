import { type HippoDbContext, adminActor } from '../api/index.js';

// The one place the CLI names its audit actor; root is a parameter because some verbs target the global store.
export function cliApiContext(hippoRoot: string, tenantId: string): HippoDbContext {
  return { hippoRoot, tenantId, actor: adminActor('cli') };
}
