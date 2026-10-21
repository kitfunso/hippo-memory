// Root-keyed connectors and audit forms tests call; production code goes through the store port or the At forms.

import { recordAuditEventsRowByRowAt, type FailedAuditEvent } from '../../../src/store/sqlite/audit.js';
import {
  githubEventRecordAt,
  markGitHubEventSeenAt,
  type GitHubEventLogEntry,
} from '../../../src/store/sqlite/connectors/github.js';
import { markSlackEventSeenAt, slackEventRecordAt } from '../../../src/store/sqlite/connectors/slack.js';
import { sqliteSyncStore } from '../../../src/store/sqlite/store.js';
import { handlesOf } from '../../../src/store/sqlite/handles.js';
import { onHandle } from '../../../src/store/sqlite/handles.js';
import { listApiKeyRows } from '../../../src/store/sqlite/auth.js';
import type { ApiKeyListItem, ListApiKeysOpts } from '../../../src/store/port/key-writes.js';
import type { AppendAuditOpts } from '../../../src/store/port/types.js';
import type { ConnectorEventRecord } from '../../../src/store/port/connectors.js';

export function auditHighId(hippoRoot: string): number {
  return sqliteSyncStore(handlesOf(hippoRoot)).keyAudit.auditHighId();
}

export function recordAuditEventsRowByRow(hippoRoot: string, events: readonly AppendAuditOpts[]): FailedAuditEvent[] {
  return onHandle(hippoRoot, (db) => recordAuditEventsRowByRowAt(db, events));
}

export function githubEventRecord(hippoRoot: string, idempotencyKey: string): ConnectorEventRecord {
  return onHandle(hippoRoot, (db) => githubEventRecordAt(db, idempotencyKey));
}

export function markGitHubEventSeen(hippoRoot: string, entry: GitHubEventLogEntry): void {
  onHandle(hippoRoot, (db) => {
    markGitHubEventSeenAt(db, entry);
  });
}

export function slackEventRecord(hippoRoot: string, eventId: string): ConnectorEventRecord {
  return onHandle(hippoRoot, (db) => slackEventRecordAt(db, eventId));
}

export function markSlackEventSeen(hippoRoot: string, eventId: string, memoryId: string | null): void {
  onHandle(hippoRoot, (db) => {
    markSlackEventSeenAt(db, eventId, memoryId);
  });
}

export function listApiKeys(hippoRoot: string, opts: ListApiKeysOpts): ApiKeyListItem[] {
  return onHandle(hippoRoot, (db) => listApiKeyRows(db, opts).map((r) => r.key));
}
