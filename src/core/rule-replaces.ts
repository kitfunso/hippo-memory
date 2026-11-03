// Not in util/same-text because it reads the user-rule tag, and util may not import core.
import { USER_RULE_TAG, type MemoryEntry } from './memory.js';

type HeldCopy = Partial<Pick<MemoryEntry, 'source' | 'pinned' | 'tags' | 'origin_project' | 'superseded_by'>> & { confidence?: string };

/** Whether a stated rule replaces this held copy rather than giving way to it: a live, observed capture row of one of `ruleProject`, the names of the rule's project, unpinned or pinned without the user-rule tag.
 * Any other copy stops the rule, so a replayed transcript revives nothing and no project loses its row. */
export function ruleReplaces(row: HeldCopy, ruleProject: readonly string[]): boolean {
  return (row.pinned !== true || (row.tags !== undefined && !row.tags.includes(USER_RULE_TAG)))
    && row.source === 'capture' && Boolean(row.origin_project)
    && ruleProject.includes(row.origin_project ?? '') && row.superseded_by == null && row.confidence === 'observed';
}
