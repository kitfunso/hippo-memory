import { DAG_LEVEL, type MemoryEntry } from '../core/memory.js';
import { passesScopeFilterForRecall } from '../core/recall-scope.js';
import { classifyOriginProject } from '../core/project-identity.js';
import type { CallerProject } from './prompt-hook.js';

/** The level-2 summaries that may stand in for their children: live, in the caller's scope and in its project. */
export function eligibleSummaryParents(
  parents: readonly MemoryEntry[],
  scope: string | undefined,
  own: string | undefined,
  project: CallerProject | undefined,
): MemoryEntry[] {
  return parents.filter(
    (p) =>
      (p.dagLevel ?? 0) === DAG_LEVEL.topic &&
      !p.supersededBy &&
      passesScopeFilterForRecall(p.scope ?? null, scope, own) &&
      (!project || classifyOriginProject(p.originProject, project) !== 'cross-project'),
  );
}
