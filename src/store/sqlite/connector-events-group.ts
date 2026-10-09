// hippo.db's half of the ConnectorEvents store group: each call on a handle of its own.
import { archiveDeletedArtifact, eventSeenAt, githubRouting, insertDlq, logEvent, seenEvent } from '../connectors/github.js';
import { insertSlackDlq, markSlackEventSeen, rawMemoryIdForArtifactAt, slackEventRecord, slackEventSeenAt, slackTeamRoute } from '../connectors/slack.js';
import { onHandle } from '../open.js';
import type { ArtifactArchive, ConnectorEvent, ConnectorEventRecord, ConnectorEvents, DeletionLookup, DeletionTarget, Sync } from '../port.js';

function eventRecord(hippoRoot: string, event: ConnectorEvent): ConnectorEventRecord {
  if (event.connector === 'slack') return slackEventRecord(hippoRoot, event.eventId);
  const logged = seenEvent(hippoRoot, event.idempotencyKey);
  return logged ? { seen: true, memoryId: logged.memoryId } : { seen: false };
}

function markEventSeen(hippoRoot: string, event: ConnectorEvent): void {
  if (event.connector === 'slack') return markSlackEventSeen(hippoRoot, event.eventId, null);
  const { idempotencyKey, deliveryId, eventName } = event;
  logEvent(hippoRoot, { idempotencyKey, deliveryId, eventName, memoryId: null });
}

function deletionTarget(hippoRoot: string, { event, artifactRef, tenantId }: DeletionLookup): DeletionTarget {
  return onHandle(hippoRoot, (db): DeletionTarget => {
    const seen = event.connector === 'slack' ? slackEventSeenAt(db, event.eventId) : eventSeenAt(db, event.idempotencyKey);
    return seen ? { seen: true } : { seen: false, memoryId: rawMemoryIdForArtifactAt(db, artifactRef, tenantId) };
  });
}

function archiveArtifact(hippoRoot: string, { tenantId, actor, artifactRef, reason, event }: ArtifactArchive): { duplicate: boolean; archived: number } {
  const { idempotencyKey, deliveryId, eventName } = event;
  return archiveDeletedArtifact(hippoRoot, { tenantId, artifactRef, idempotencyKey, deliveryId, eventName, reason, who: actor });
}

export function sqliteConnectorEvents(hippoRoot: string): Sync<ConnectorEvents> {
  return {
    eventRecord: (event) => eventRecord(hippoRoot, event),
    markEventSeen: (event) => markEventSeen(hippoRoot, event),
    deletionTarget: (lookup) => deletionTarget(hippoRoot, lookup),
    archiveDeletedArtifact: (archive) => archiveArtifact(hippoRoot, archive),
    slackTeamRoute: (teamId) => slackTeamRoute(hippoRoot, teamId),
    githubRouting: (query) => githubRouting(hippoRoot, query),
    parkDeadLetter: (letter) => (letter.connector === 'slack' ? insertSlackDlq(hippoRoot, letter) : insertDlq(hippoRoot, letter)),
  };
}

/** The group as a served store answers it: each call runs at once and resolves through a Promise, so a throw rejects as another store's would. */
export function servedConnectorEvents(sync: Sync<ConnectorEvents>): ConnectorEvents {
  return {
    eventRecord: async (event) => sync.eventRecord(event),
    markEventSeen: async (event) => sync.markEventSeen(event),
    deletionTarget: async (lookup) => sync.deletionTarget(lookup),
    archiveDeletedArtifact: async (archive) => sync.archiveDeletedArtifact(archive),
    slackTeamRoute: async (teamId) => sync.slackTeamRoute(teamId),
    githubRouting: async (query) => sync.githubRouting(query),
    parkDeadLetter: async (letter) => sync.parkDeadLetter(letter),
  };
}
