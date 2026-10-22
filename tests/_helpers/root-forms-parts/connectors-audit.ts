// Root-keyed connectors and audit forms tests call; production code goes through the port or the handle-first forms.

import type { FailedAuditEvent } from '../../../src/store/sqlite/audit.js';
import * as auditSql from '../../../src/store/sqlite/audit.js';
import type { GitHubEventLogEntry } from '../../../src/store/sqlite/connectors/github.js';
import * as githubSql from '../../../src/store/sqlite/connectors/github.js';
import * as slackSql from '../../../src/store/sqlite/connectors/slack.js';
import { onHandle } from '../../../src/store/sqlite/handles.js';
import { listApiKeyRows } from '../../../src/store/sqlite/auth.js';
import type { ApiKeyListItem, ListApiKeysOpts } from '../../../src/store/port/keys.js';
import type { AppendAuditOpts } from '../../../src/store/port/types.js';
import type { ConnectorEventRecord } from '../../../src/store/port/connectors.js';

/** The highest audit id hippo.db ever assigned, pruned rows included. */
export function auditHighId(hippoRoot: string): number {
  return onHandle(hippoRoot, (db) => {
    // SAFETY: sqlite_sequence holds one integer seq per AUTOINCREMENT table.
    const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit_log'").get() as
      | { seq: number }
      | undefined;
    return row?.seq ?? 0;
  });
}

export function recordAuditEventsRowByRow(hippoRoot: string, events: readonly AppendAuditOpts[]): FailedAuditEvent[] {
  return onHandle(hippoRoot, (db) => auditSql.recordAuditEventsRowByRow(db, events));
}

export function githubEventRecord(hippoRoot: string, idempotencyKey: string): ConnectorEventRecord {
  return onHandle(hippoRoot, (db) => githubSql.githubEventRecord(db, idempotencyKey));
}

export function markGitHubEventSeen(hippoRoot: string, entry: GitHubEventLogEntry): void {
  onHandle(hippoRoot, (db) => {
    githubSql.markGitHubEventSeen(db, entry);
  });
}

export function slackEventRecord(hippoRoot: string, eventId: string): ConnectorEventRecord {
  return onHandle(hippoRoot, (db) => slackSql.slackEventRecord(db, eventId));
}

export function markSlackEventSeen(hippoRoot: string, eventId: string, memoryId: string | null): void {
  onHandle(hippoRoot, (db) => {
    slackSql.markSlackEventSeen(db, eventId, memoryId);
  });
}

export function listApiKeys(hippoRoot: string, opts: ListApiKeysOpts): ApiKeyListItem[] {
  return onHandle(hippoRoot, (db) => listApiKeyRows(db, opts).map((r) => r.key));
}
