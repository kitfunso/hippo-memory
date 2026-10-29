// hippo.db's local tier: the features only this store serves, as repositories typed by their SQL
// bodies. No other store implements them, so none is part of the store port.
import type { MethodEffects } from '../../base/ports/store/effects.js';
import { sqliteQuarantine } from './connectors/quarantine.js';
import { sqliteStats } from './entries/index-and-stats.js';
import type { Handles } from './runtime/open.js';

/** Every local repository on `handles`; the SQLite store carries them as `hippoDb`. */
export function hippoDbRepos(handles: Handles) {
  return { stats: sqliteStats(handles), quarantine: sqliteQuarantine(handles) };
}

export type HippoDbRepos = ReturnType<typeof hippoDbRepos>;

/** What each local method does to the store, which places it on a worker; a method missing here
 * fails to compile. */
export const HIPPO_DB_EFFECTS = {
  stats: { bumpRemembered: 'write' },
  quarantine: { list: 'read', approve: 'write', reject: 'write' },
} as const satisfies { readonly [R in keyof HippoDbRepos]: MethodEffects<HippoDbRepos[R]> };
