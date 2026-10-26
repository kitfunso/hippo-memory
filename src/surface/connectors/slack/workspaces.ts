// Slack workspace registration: `slack_workspaces` maps `team_id` to `tenant_id` (empty =
// single-tenant, non-empty = fail-closed routing). `add` overwrites a team's tenant on purpose, so
// moving a workspace needs no delete first.

import type { ConnectorStore } from '../ingest.js';
import type { SlackWorkspace } from '../../../base/ports/store/connectors.js';

export type { SlackWorkspace };

export interface AddWorkspaceOptions {
  teamId: string;
  tenantId: string;
}

export function addWorkspace(
  store: ConnectorStore,
  opts: AddWorkspaceOptions,
): Promise<SlackWorkspace> {
  return store.connectorEvents.registerSlackWorkspace(opts.teamId, opts.tenantId);
}

export function listWorkspaces(store: ConnectorStore): Promise<SlackWorkspace[]> {
  return store.connectorEvents.slackWorkspaces();
}

export function removeWorkspace(store: ConnectorStore, teamId: string): Promise<boolean> {
  return store.connectorEvents.removeSlackWorkspace(teamId);
}
