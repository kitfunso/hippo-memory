import { hippoHomeDir } from './agent-homes.js';

/** The global store's folder: $HIPPO_HOME, else $XDG_DATA_HOME/hippo, else ~/.hippo/. */
export function getGlobalRoot(): string {
  return hippoHomeDir();
}
