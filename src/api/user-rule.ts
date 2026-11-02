// Which rows print as the person's own rules: only capture sets the tag, so a row nobody typed cannot pass for one.
import { USER_RULE_TAG, type MemoryEntry } from '../core/memory.js';
import { projectId, projectNames, type ProjectRef } from '../core/project-identity.js';
import type { ContextPlan, ContextPools } from './context-select.js';

export { USER_RULE_TAG };

/** Who reads the block, and where the row lives: a row's origin is the project id capture stamped, so it can be any name the project had;
 * '' is no project. */
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
    e.superseded_by === null &&
    e.scope === null &&
    e.tenantId === viewer.tenantId;
  if (!own) return false;
  // A project store's rows are that project's; capture leaves their origin unset (cli/session-hooks.ts).
  const origin = e.origin_project ?? null;
  const names = projectId(viewer.project) === '' ? [] : projectNames(viewer.project);
  if (!viewer.isGlobal) return origin === null || names.includes(origin);
  // A global row is a rule only in the project capture stamped on it; a null origin matches none.
  return origin !== null && names.includes(origin);
}

/** The tokens of the user-rule heading: nothing unless a loaded row prints under it. SHORTCUT: paid when the pool holds a user rule, even if the
 * ranking then leaves it out; one heading of slack. */
export function userRuleReserve(plan: ContextPlan, pools: ContextPools): number {
  const { cost } = plan;
  const held = pools.local.entries.some((e) => plan.isUserRule(e, plan.primaryIsGlobal))
    || pools.global.entries.some((e) => plan.isUserRule(e, true));
  if (!cost || !held) return 0;
  // The headings are priced apart, so the two totals differ by the user-rule heading alone.
  const can = { cross: false, promptRecall: false, ambient: false };
  return cost.fixed(0, { ...can, userRule: true }) - cost.fixed(0, { ...can, userRule: false });
}
