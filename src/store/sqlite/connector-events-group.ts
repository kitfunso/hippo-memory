// hippo.db's half of the ConnectorEvents store group: each call on a handle of its own.
import type { DatabaseSyncLike } from '../../db/index.js';
import {
  archiveDeletedArtifact,
  githubCursorsAt,
  githubEventRecord,
  githubEventSeenAt,
  githubRouting,
  GITHUB_DLQ,
  markGitHubEventSeen,
  saveGitHubHwmAt,
  seedGitHubCursorsAt,
} from '../connectors/github.js';
import {
  listSlackWorkspacesAt,
  markSlackEventSeen,
  rawMemoryIdForArtifactAt,
  removeSlackWorkspaceAt,
  saveSlackCursorAt,
  slackCursorAt,
  slackEventRecord,
  slackEventSeenAt,
  slackTeamRoute,
  SLACK_DLQ,
  upsertSlackWorkspaceAt,
} from '../connectors/slack.js';
import { onHandle } from '../open.js';
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

function eventRecord(hippoRoot: string, event: ConnectorEvent): ConnectorEventRecord {
  return event.connector === 'slack'
    ? slackEventRecord(hippoRoot, event.eventId)
    : githubEventRecord(hippoRoot, event.idempotencyKey);
}

function markEventSeen(hippoRoot: string, event: ConnectorEvent): void {
  if (event.connector === 'slack') return markSlackEventSeen(hippoRoot, event.eventId, null);
  const { idempotencyKey, deliveryId, eventName } = event;
  markGitHubEventSeen(hippoRoot, { idempotencyKey, deliveryId, eventName, memoryId: null });
}

function deletionTarget(hippoRoot: string, { event, artifactRef, tenantId }: DeletionLookup): DeletionTarget {
  return onHandle(hippoRoot, (db): DeletionTarget => {
    const seen =
      event.connector === 'slack' ? slackEventSeenAt(db, event.eventId) : githubEventSeenAt(db, event.idempotencyKey);
    return seen ? { seen: true } : { seen: false, memoryId: rawMemoryIdForArtifactAt(db, artifactRef, tenantId) };
  });
}

function archiveArtifact(
  hippoRoot: string,
  { tenantId, actor, artifactRef, reason, event }: ArtifactArchive,
): { duplicate: boolean; archived: number } {
  const { idempotencyKey, deliveryId, eventName } = event;
  return archiveDeletedArtifact(hippoRoot, {
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

function sqliteConnectorState(hippoRoot: string): Omit<Sync<ConnectorEvents>, DeliveryMethods> {
  const on = <T>(fn: (db: DatabaseSyncLike) => T): T => onHandle(hippoRoot, fn);
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

export function sqliteConnectorEvents(hippoRoot: string): Sync<ConnectorEvents> {
  return {
    eventRecord: (event) => eventRecord(hippoRoot, event),
    markEventSeen: (event) => markEventSeen(hippoRoot, event),
    deletionTarget: (lookup) => deletionTarget(hippoRoot, lookup),
    archiveDeletedArtifact: (archive) => archiveArtifact(hippoRoot, archive),
    slackTeamRoute: (teamId) => slackTeamRoute(hippoRoot, teamId),
    githubRouting: (query) => githubRouting(hippoRoot, query),
    parkDeadLetter: (letter) =>
      onHandle(hippoRoot, (db) =>
        letter.connector === 'slack' ? SLACK_DLQ.insert(db, letter) : GITHUB_DLQ.insert(db, letter)),
    ...sqliteConnectorState(hippoRoot),
  };
}
