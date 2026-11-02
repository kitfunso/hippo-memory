// Which rows print as the person's own rules: only capture sets the tag, so a row nobody typed
// cannot pass for one.
import { USER_RULE_TAG, type MemoryEntry } from '../../base/memory/entry.js';

export { USER_RULE_TAG };

/** Who reads the block: the origin is the project id capture stamps its rows with. */
export interface UserRuleViewer {
  readonly tenantId: string;
  readonly originProject: string | null;
  readonly isGlobal: boolean;
}

export function isUserRule(e: MemoryEntry, viewer: UserRuleViewer): boolean {
  // A viewer with no project owns no rules: a legacy row's null origin must not match it.
  if (viewer.isGlobal || viewer.originProject === null) return false;
  return (
    e.pinned &&
    e.source === 'capture' &&
    e.confidence === 'observed' &&
    e.tags.includes(USER_RULE_TAG) &&
    e.supersededBy === null &&
    e.scope === null &&
    e.tenantId === viewer.tenantId &&
    (e.originProject ?? null) === viewer.originProject
  );
}
