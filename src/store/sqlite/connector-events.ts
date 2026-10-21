// hippo.db's half of the ConnectorEvents store group: each call on a handle of its own.
import type { DatabaseSyncLike } from '../../db/index.js';
import {
  archiveDeletedArtifact,
  githubCursors,
  githubEventRecord,
  githubEventSeen,
  githubRouting,
  GITHUB_DLQ,
  markGitHubEventSeen,
  saveGitHubHwm,
  seedGitHubCursors,
} from './connectors/github.js';
import {
  listSlackWorkspaces,
  markSlackEventSeen,
  rawMemoryIdForArtifact,
  removeSlackWorkspace,
  saveSlackCursor,
  slackCursor,
  slackEventRecord,
  slackEventSeen,
  slackTeamRoute,
  SLACK_DLQ,
  upsertSlackWorkspace,
} from './connectors/slack.js';
import { claimDelivery, releaseDelivery } from './connectors/replay.js';
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
} from '../port.js';
import type { Sync } from './served.js';

function eventRecord(db: DatabaseSyncLike, event: ConnectorEvent): ConnectorEventRecord {
  return event.connector === 'slack'
    ? slackEventRecord(db, event.eventId)
    : githubEventRecord(db, event.idempotencyKey);
}

function markEventSeen(db: DatabaseSyncLike, event: ConnectorEvent): void {
  if (event.connector === 'slack') {
    markSlackEventSeen(db, event.eventId, null);
    return;
  }
  const { idempotencyKey, deliveryId, eventName } = event;
  markGitHubEventSeen(db, { idempotencyKey, deliveryId, eventName, memoryId: null });
}

function deletionTarget(db: DatabaseSyncLike, { event, artifactRef, tenantId }: DeletionLookup): DeletionTarget {
  const seen =
    event.connector === 'slack' ? slackEventSeen(db, event.eventId) : githubEventSeen(db, event.idempotencyKey);
  return seen ? { seen: true } : { seen: false, memoryId: rawMemoryIdForArtifact(db, artifactRef, tenantId) };
}

function archiveArtifact(
  db: DatabaseSyncLike,
  { tenantId, actor, artifactRef, reason, event }: ArtifactArchive,
): { duplicate: boolean; archived: number } {
  const { idempotencyKey, deliveryId, eventName } = event;
  return archiveDeletedArtifact(db, {
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
    deadLetter: (connector, tenantId, id): DeadLetterRows[DeadLetterConnector] | null =>
      on((db) => queueOf(connector).get(db, tenantId, id)),
    markDeadLetterRetried: (connector, tenantId, id) => on((db) => queueOf(connector).markRetried(db, tenantId, id)),
    ...bound(on, connectorCursorsBodies),
  };
}

const connectorCursorsBodies: Bodies<
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
  slackCursor: slackCursor,
  saveSlackCursor: saveSlackCursor,
  githubCursors: githubCursors,
  saveGitHubHwm: saveGitHubHwm,
  seedGitHubCursors: seedGitHubCursors,
  slackWorkspaces: listSlackWorkspaces,
  registerSlackWorkspace: upsertSlackWorkspace,
  removeSlackWorkspace: removeSlackWorkspace,
};

const deliveriesBodies: Bodies<Pick<ConnectorEvents, Exclude<DeliveryMethods, 'parkDeadLetter'>>> = {
  eventRecord: eventRecord,
  markEventSeen: markEventSeen,
  claimDelivery: claimDelivery,
  releaseDelivery: releaseDelivery,
  deletionTarget: deletionTarget,
  archiveDeletedArtifact: archiveArtifact,
  slackTeamRoute: slackTeamRoute,
  githubRouting: githubRouting,
};

export function sqliteConnectorEvents(on: OnHandle): Sync<ConnectorEvents> {
  return {
    ...bound(on, deliveriesBodies),
    parkDeadLetter: (letter) =>
      on((db) => (letter.connector === 'slack' ? SLACK_DLQ.insert(db, letter) : GITHUB_DLQ.insert(db, letter))),
    ...sqliteConnectorState(on),
  };
}
