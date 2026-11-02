// Which rows print as the person's own rules: only capture sets the tag, so a row nobody typed
// cannot pass for one.
import { USER_RULE_TAG, type MemoryEntry } from '../../base/memory/entry.js';

export { USER_RULE_TAG };

/** Who reads the block, and where the row lives: the origin is the project id capture stamps on rows
 * it writes to the global store. */
export interface UserRuleViewer {
  readonly tenantId: string;
  readonly originProject: string | null;
  readonly isGlobal: boolean;
}

export function isUserRule(e: MemoryEntry, viewer: UserRuleViewer): boolean {
  const own =
    e.pinned &&
    e.source === 'capture' &&
    e.confidence === 'observed' &&
    e.tags.includes(USER_RULE_TAG) &&
    e.supersededBy === null &&
    e.scope === null &&
    e.tenantId === viewer.tenantId;
  if (!own) return false;
  // A project store's rows are that project's; capture leaves their origin unset (session-end.ts).
  const origin = e.originProject ?? null;
  if (!viewer.isGlobal) return origin === null || origin === viewer.originProject;
  // A global row is a rule only in the project capture stamped on it; a null origin matches none.
  return viewer.originProject !== null && e.originProject === viewer.originProject;
}
