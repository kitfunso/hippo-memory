import type { Objects } from '../../src/store/port.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';

/** The typed-object group of the store on hippo.db under `hippoRoot`, as the CLI's edge builds it. */
export function objectsAt(hippoRoot: string): Objects {
  return sqliteStore(hippoRoot).objects;
}
