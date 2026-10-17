// Slack workspace registration: `slack_workspaces` maps `team_id` to `tenant_id` (empty = single-tenant, non-empty =
// fail-closed routing). `add` overwrites a team's tenant on purpose, so moving a workspace needs no delete first.

import type { HippoStore } from '../../store/index.js';
import type { SlackWorkspace } from '../../store/port/connectors.js';

export type { SlackWorkspace };

export interface AddWorkspaceOptions {
  teamId: string;
  tenantId: string;
}

export function addWorkspace(store: HippoStore, opts: AddWorkspaceOptions): Promise<SlackWorkspace> {
  return store.connectorEvents.registerSlackWorkspace(opts.teamId, opts.tenantId);
}

export function listWorkspaces(store: HippoStore): Promise<SlackWorkspace[]> {
  return store.connectorEvents.slackWorkspaces();
}

export function removeWorkspace(store: HippoStore, teamId: string): Promise<boolean> {
  return store.connectorEvents.removeSlackWorkspace(teamId);
}
