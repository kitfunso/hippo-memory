// Where the global store lives. Creating it opens hippo.db, so the surface caller does that with initStore.

import { resolveGlobalRootDir } from '../core/project-identity.js';

/** The global store's folder: $HIPPO_HOME, else $XDG_DATA_HOME/hippo, else ~/.hippo/. */
export function getGlobalRoot(): string {
  // Single source of truth lives in project-identity.ts (leaf) so db migrations can resolve the same path without a
  // shared.ts import cycle.
  return resolveGlobalRootDir();
}
