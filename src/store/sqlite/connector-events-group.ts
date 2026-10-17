// hippo.db's half of the ConnectorEvents store group: each call on a handle of its own.
import type { DatabaseSyncLike } from '../../db/index.js';
import {
  archiveDeletedArtifactAt,
  githubCursorsAt,
  githubEventRecordAt,
  githubEventSeenAt,
  githubRoutingAt,
  GITHUB_DLQ,
  markGitHubEventSeenAt,
  saveGitHubHwmAt,
  seedGitHubCursorsAt,
} from '../connectors/github.js';
import {
  listSlackWorkspacesAt,
  markSlackEventSeenAt,
  rawMemoryIdForArtifactAt,
  removeSlackWorkspaceAt,
  saveSlackCursorAt,
  slackCursorAt,
  slackEventRecordAt,
  slackEventSeenAt,
  slackTeamRouteAt,
  SLACK_DLQ,
  upsertSlackWorkspaceAt,
} from '../connectors/slack.js';
import type { OnHandle } from '../open.js';
import type {
  ArtifactArchive,
  ConnectorEvent,
  ConnectorEventRecord,
  ConnectorEvents,
  DeadLetterConnector,
  DeadLetterRows,
  DeletionLookup,
  DeletionTarget,
  Sync,
} from '../port.js';

function eventRecordAt(db: DatabaseSyncLike, event: ConnectorEvent): ConnectorEventRecord {
  return event.connector === 'slack'
    ? slackEventRecordAt(db, event.eventId)
    : githubEventRecordAt(db, event.idempotencyKey);
}

function markEventSeenAt(db: DatabaseSyncLike, event: ConnectorEvent): void {
  if (event.connector === 'slack') {
    markSlackEventSeenAt(db, event.eventId, null);
    return;
  }
  const { idempotencyKey, deliveryId, eventName } = event;
  markGitHubEventSeenAt(db, { idempotencyKey, deliveryId, eventName, memoryId: null });
}

function deletionTargetAt(db: DatabaseSyncLike, { event, artifactRef, tenantId }: DeletionLookup): DeletionTarget {
  const seen =
    event.connector === 'slack' ? slackEventSeenAt(db, event.eventId) : githubEventSeenAt(db, event.idempotencyKey);
  return seen ? { seen: true } : { seen: false, memoryId: rawMemoryIdForArtifactAt(db, artifactRef, tenantId) };
}

function archiveArtifactAt(
  db: DatabaseSyncLike,
  { tenantId, actor, artifactRef, reason, event }: ArtifactArchive,
): { duplicate: boolean; archived: number } {
  const { idempotencyKey, deliveryId, eventName } = event;
  return archiveDeletedArtifactAt(db, {
    tenantId,
    artifactRef,
    idempotencyKey,
    deliveryId,
    eventName,
    reason,
    who: actor,
  });
}

const queueOf = (connector: DeadLetterConnector) => (connector === 'slack' ? SLACK_DLQ : GITHUB_DLQ);

type DeliveryMethods = 'eventRecord' | 'markEventSeen' | 'deletionTarget' | 'archiveDeletedArtifact' | 'slackTeamRoute'
  | 'githubRouting' | 'parkDeadLetter';

function sqliteConnectorState(on: OnHandle): Omit<Sync<ConnectorEvents>, DeliveryMethods> {
  return {
    deadLetters: (connector, tenantId, limit): DeadLetterRows[DeadLetterConnector][] =>
      on((db) => queueOf(connector).list(db, tenantId, limit)),
    deadLetter: (connector, id): DeadLetterRows[DeadLetterConnector] | null =>
      on((db) => queueOf(connector).get(db, id)),
    markDeadLetterRetried: (connector, id) => on((db) => queueOf(connector).markRetried(db, id)),
    slackCursor: (tenantId, channelId) => on((db) => slackCursorAt(db, tenantId, channelId)),
    saveSlackCursor: (tenantId, channelId, latestTs) =>
      on((db) => saveSlackCursorAt(db, tenantId, channelId, latestTs)),
    githubCursors: (tenantId, repo) => on((db) => githubCursorsAt(db, tenantId, repo)),
    saveGitHubHwm: (tenantId, repo, column, value) => on((db) => saveGitHubHwmAt(db, tenantId, repo, column, value)),
    seedGitHubCursors: (tenantId, repo, since) => on((db) => seedGitHubCursorsAt(db, tenantId, repo, since)),
    slackWorkspaces: () => on(listSlackWorkspacesAt),
    registerSlackWorkspace: (teamId, tenantId) => on((db) => upsertSlackWorkspaceAt(db, teamId, tenantId)),
    removeSlackWorkspace: (teamId) => on((db) => removeSlackWorkspaceAt(db, teamId)),
  };
}

export function sqliteConnectorEvents(on: OnHandle): Sync<ConnectorEvents> {
  return {
    eventRecord: (event) => on((db) => eventRecordAt(db, event)),
    markEventSeen: (event) => on((db) => markEventSeenAt(db, event)),
    deletionTarget: (lookup) => on((db) => deletionTargetAt(db, lookup)),
    archiveDeletedArtifact: (archive) => on((db) => archiveArtifactAt(db, archive)),
    slackTeamRoute: (teamId) => on((db) => slackTeamRouteAt(db, teamId)),
    githubRouting: (query) => on((db) => githubRoutingAt(db, query)),
    parkDeadLetter: (letter) =>
      on((db) => (letter.connector === 'slack' ? SLACK_DLQ.insert(db, letter) : GITHUB_DLQ.insert(db, letter))),
    ...sqliteConnectorState(on),
  };
}
