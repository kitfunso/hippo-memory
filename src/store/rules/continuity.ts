// The continuity key's match, once for both adapters: all or nothing, so a key missing its owner or every project name
// matches no row, never the tenant's newest.
import type { ContinuityKey } from '../port/types.js';

/** The project names a row's origin must be one of, or null when the key matches no row. */
export function keyProjects(key: ContinuityKey): readonly string[] | null {
  const names = key.project.filter((n) => n !== '');
  return key.owner === '' || names.length === 0 ? null : names;
}
