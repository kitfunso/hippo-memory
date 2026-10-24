// The global store's folder under the name hippo publishes; creating the store opens hippo.db, so the surface caller
// does that with initStore.
import { resolveGlobalRootDir } from './project-identity.js';

/** The global store's folder: $HIPPO_HOME, else $XDG_DATA_HOME/hippo, else ~/.hippo/. */
export function getGlobalRoot(): string {
  return resolveGlobalRootDir();
}
