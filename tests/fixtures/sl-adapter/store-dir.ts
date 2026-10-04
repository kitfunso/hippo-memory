import type { MemoryAdapter } from '../../../benchmarks/sequential-learning/adapters/interface.mjs';

/** The adapter's private temp-store path; no public accessor exists, so read it by key check, not a cast. */
export function storeDirOf(adapter: MemoryAdapter): string | null {
  if (!('_storeDir' in adapter)) return null;
  const dir = adapter._storeDir;
  return dir === null || dir === undefined ? null : String(dir);
}
