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
