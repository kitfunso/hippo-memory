// Which rows print as the person's own rules: only capture sets the tag, so a row nobody typed
// cannot pass for one.
import { USER_RULE_TAG, type MemoryEntry } from '../../base/memory/entry.js';
import { projectId, projectNames, type ProjectRef } from '../../base/scope/project-identity.js';
import { isSuperseded } from '../../base/memory/liveness.js';

export { USER_RULE_TAG };

/** Who reads the block, and where the row lives: a row's origin is the project id capture stamped,
 * so it can be any name the project had; '' is no project. */
export interface UserRuleViewer {
  readonly tenantId: string;
  readonly project: ProjectRef;
  readonly isGlobal: boolean;
}

export function isUserRule(e: MemoryEntry, viewer: UserRuleViewer): boolean {
  const own =
    e.pinned &&
    e.source === 'capture' &&
    e.confidence === 'observed' &&
    e.tags.includes(USER_RULE_TAG) &&
    !isSuperseded(e) &&
    e.scope === null &&
    e.tenantId === viewer.tenantId;
  if (!own) return false;
  // A project store's rows are that project's; capture leaves their origin unset (session-end.ts).
  const origin = e.originProject ?? null;
  const names = projectId(viewer.project) === '' ? [] : projectNames(viewer.project);
  if (!viewer.isGlobal) return origin === null || names.includes(origin);
  // A global row is a rule only in the project capture stamped on it; a null origin matches none.
  return origin !== null && names.includes(origin);
}
