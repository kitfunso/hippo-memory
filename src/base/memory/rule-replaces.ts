// Not in same-text because it reads the user-rule tag, and base/util may not import base/memory.
import { USER_RULE_TAG, type MemoryEntry } from './entry.js';
import { isSuperseded } from './liveness.js';

type HeldCopy = Partial<
  Pick<MemoryEntry, 'source' | 'pinned' | 'tags' | 'originProject' | 'supersededBy'>
> & { confidence?: string };

/** Whether a stated rule replaces this held copy: a live, observed capture row of `ruleProject`
 * (the rule's project names), unpinned or pinned without the user-rule tag. Any other copy stops
 * the rule, so a replayed transcript revives nothing and no project loses its row. */
export function ruleReplaces(row: HeldCopy, ruleProject: readonly string[]): boolean {
  return (
    (row.pinned !== true || (row.tags !== undefined && !row.tags.includes(USER_RULE_TAG))) &&
    row.source === 'capture' &&
    Boolean(row.originProject) &&
    ruleProject.includes(row.originProject ?? '') &&
    !isSuperseded(row) &&
    row.confidence === 'observed'
  );
}
