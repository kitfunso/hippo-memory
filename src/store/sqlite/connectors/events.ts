// The event log by ConnectorEvent, whichever connector's table holds the key, and the archive a deletion event logs.

import { withWriteScope, type DatabaseSyncLike } from '../../../db/index.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { archiveRawMemories } from '../raw-archive.js';
import type {
  ArtifactDeletion,
  ArtifactLookup,
  ConnectorEvent,
  ConnectorEventRecord,
  EventMarked,
} from '../../port/connectors.js';
import { githubEventMemory, githubEventRecord, githubEventSeen, markGitHubEventSeen } from './github.js';
import { markSlackEventSeen, slackEventMemory, slackEventRecord, slackEventSeen } from './slack.js';

// The tenant filter keeps one tenant's deletion from reaching another's row under the same ref.
const RAW_ROWS = `SELECT id FROM memories WHERE artifact_ref = ? AND tenant_id = ? AND kind = 'raw'`;

function eventSeen(db: DatabaseSyncLike, event: ConnectorEvent): boolean {
  return event.connector === 'slack' ? slackEventSeen(db, event.eventId) : githubEventSeen(db, event.idempotencyKey);
}

/** False when the key was logged before: the insert ignores a taken key, so the first writer's row stays. */
export function logEvent(db: DatabaseSyncLike, event: ConnectorEvent, memoryId: string | null): boolean {
  if (event.connector === 'slack') return markSlackEventSeen(db, event.eventId, memoryId);
  const { idempotencyKey, deliveryId, eventName } = event;
  return markGitHubEventSeen(db, { idempotencyKey, deliveryId, eventName, memoryId });
}

export function loggedMemory(db: DatabaseSyncLike, event: ConnectorEvent): string | null {
  return event.connector === 'slack'
    ? slackEventMemory(db, event.eventId)
    : githubEventMemory(db, event.idempotencyKey);
}

export function eventRecord(
  db: DatabaseSyncLike,
  event: ConnectorEvent,
  artifact?: ArtifactLookup,
): ConnectorEventRecord {
  const record =
    event.connector === 'slack' ? slackEventRecord(db, event.eventId) : githubEventRecord(db, event.idempotencyKey);
  if (record.seen || artifact === undefined) return record;
  const row = cachedStatement(db, RAW_ROWS).get(artifact.artifactRef, artifact.tenantId) as { id?: string } | undefined;
  return { seen: false, memoryId: row?.id ?? null };
}

/** With `deleted`, every raw row of the tenant's artifact is archived and the log row names the first; a failed archive
 * rolls back the batch and the log row. */
export function markEventSeen(db: DatabaseSyncLike, event: ConnectorEvent, deleted?: ArtifactDeletion): EventMarked {
  if (deleted === undefined) return { duplicate: !logEvent(db, event, null), archived: 0 };
  if (eventSeen(db, event)) return { duplicate: true, archived: 0 };
  const rows = cachedStatement(db, RAW_ROWS).all(deleted.artifactRef, deleted.tenantId) as Array<{ id: string }>;
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) {
    // Still logged, so a retry of the same delete answers 'duplicate'.
    logEvent(db, event, null);
    return { duplicate: false, archived: 0 };
  }
  withWriteScope(db, 'artifact_delete', () => {
    archiveRawMemories(db, ids, { reason: deleted.reason, who: deleted.actor });
    logEvent(db, event, ids[0]!);
  });
  return { duplicate: false, archived: ids.length };
}
