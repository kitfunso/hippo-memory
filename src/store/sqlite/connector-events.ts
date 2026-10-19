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
} from './connectors/github.js';
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
} from './connectors/slack.js';
import { claimDeliveryAt, releaseDeliveryAt } from './connectors/replay.js';
import type { OnHandle } from './open.js';
import { bound, type Bodies } from './bound.js';
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

type DeliveryMethods =
  | 'eventRecord'
  | 'markEventSeen'
  | 'claimDelivery'
  | 'releaseDelivery'
  | 'deletionTarget'
  | 'archiveDeletedArtifact'
  | 'slackTeamRoute'
  | 'githubRouting'
  | 'parkDeadLetter';

function sqliteConnectorState(on: OnHandle): Omit<Sync<ConnectorEvents>, DeliveryMethods> {
  return {
    deadLetters: (connector, tenantId, limit): DeadLetterRows[DeadLetterConnector][] =>
      on((db) => queueOf(connector).list(db, tenantId, limit)),
    deadLetter: (connector, id): DeadLetterRows[DeadLetterConnector] | null =>
      on((db) => queueOf(connector).get(db, id)),
    markDeadLetterRetried: (connector, id) => on((db) => queueOf(connector).markRetried(db, id)),
    ...bound(on, connectorCursorsAt),
  };
}

const connectorCursorsAt: Bodies<
  Pick<
    ConnectorEvents,
    | 'slackCursor'
    | 'saveSlackCursor'
    | 'githubCursors'
    | 'saveGitHubHwm'
    | 'seedGitHubCursors'
    | 'slackWorkspaces'
    | 'registerSlackWorkspace'
    | 'removeSlackWorkspace'
  >
> = {
  slackCursor: slackCursorAt,
  saveSlackCursor: saveSlackCursorAt,
  githubCursors: githubCursorsAt,
  saveGitHubHwm: saveGitHubHwmAt,
  seedGitHubCursors: seedGitHubCursorsAt,
  slackWorkspaces: listSlackWorkspacesAt,
  registerSlackWorkspace: upsertSlackWorkspaceAt,
  removeSlackWorkspace: removeSlackWorkspaceAt,
};

const deliveriesAt: Bodies<Pick<ConnectorEvents, Exclude<DeliveryMethods, 'parkDeadLetter'>>> = {
  eventRecord: eventRecordAt,
  markEventSeen: markEventSeenAt,
  claimDelivery: claimDeliveryAt,
  releaseDelivery: releaseDeliveryAt,
  deletionTarget: deletionTargetAt,
  archiveDeletedArtifact: archiveArtifactAt,
  slackTeamRoute: slackTeamRouteAt,
  githubRouting: githubRoutingAt,
};

export function sqliteConnectorEvents(on: OnHandle): Sync<ConnectorEvents> {
  return {
    ...bound(on, deliveriesAt),
    parkDeadLetter: (letter) =>
      on((db) => (letter.connector === 'slack' ? SLACK_DLQ.insert(db, letter) : GITHUB_DLQ.insert(db, letter))),
    ...sqliteConnectorState(on),
  };
}
