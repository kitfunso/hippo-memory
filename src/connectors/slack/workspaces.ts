/** Slack workspace registration helpers: the `slack_workspaces` table maps `team_id` to `tenant_id` (empty = single-tenant, non-empty = fail-closed routing).
 *  `add` is an upsert that overwrites an existing team_id's tenant on purpose, so moving a workspace needs no delete+add. */

import { upsertSlackWorkspace, type SlackWorkspace } from '../../store/connectors/slack.js';

export type { SlackWorkspace };
export { listSlackWorkspaces as listWorkspaces, removeSlackWorkspace as removeWorkspace } from '../../store/connectors/slack.js';

export interface AddWorkspaceOpts {
  teamId: string;
  tenantId: string;
}

/** Register or re-register a Slack team → tenant mapping. Upserts on
 *  team_id conflict (operators move workspaces between tenants). */
export function addWorkspace(
  hippoRoot: string,
  opts: AddWorkspaceOpts,
): SlackWorkspace {
  return upsertSlackWorkspace(hippoRoot, opts.teamId, opts.tenantId);
}
