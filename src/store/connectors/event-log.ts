// The event-log statements both connectors share; each connector names its table, key column and extra columns.

import type { DatabaseSyncLike } from '../../db/index.js';
import type { EntryWrite, RawArchive } from '../port.js';
import type { GitHubDlqInsert, GitHubRouting } from './github.js';
import type { SlackDlqInsert, SlackTeamRoute } from './slack.js';
import { placeholders } from '../../util/sql.js';
import { onHandle } from '../open.js';

/** Which log table a connector writes and the column its dedupe key lives in. */
export interface EventLogSpec {
  readonly table: 'slack_event_log' | 'github_event_log';
  readonly keyColumn: 'event_id' | 'idempotency_key';
}

export function eventSeenAt(db: DatabaseSyncLike, log: EventLogSpec, key: string): boolean {
  return !!db.prepare(`SELECT 1 FROM ${log.table} WHERE ${log.keyColumn} = ?`).get(key);
}

export function eventMemoryAt(db: DatabaseSyncLike, log: EventLogSpec, key: string): string | null {
  // SAFETY: the SELECT projects only `memory_id`, a nullable column; .get() returns undefined when no row matches.
  const row = db.prepare(`SELECT memory_id FROM ${log.table} WHERE ${log.keyColumn} = ?`).get(key) as
    | { memory_id: string | null }
    | undefined;
  return row?.memory_id ?? null;
}

/** Records the key unless a row holds it already; false means another writer got there first. `extra` pairs
 * connector-only columns with values. */
export function markEventSeenAt(
  db: DatabaseSyncLike,
  log: EventLogSpec,
  key: string,
  extra: ReadonlyArray<readonly [string, string]>,
  memoryId: string | null,
): boolean {
  const names = [log.keyColumn, ...extra.map(([name]) => name), 'ingested_at', 'memory_id'];
  const values = [key, ...extra.map(([, value]) => value), new Date().toISOString(), memoryId];
  const inserted = db
    .prepare(`INSERT OR IGNORE INTO ${log.table} (${names.join(', ')}) VALUES (${placeholders(names.length)})`)
    .run(...values);
  return Number(inserted.changes ?? 0) !== 0;
}

export function eventRecord(hippoRoot: string, log: EventLogSpec, key: string): ConnectorEventRecord {
  return onHandle(hippoRoot, (db): ConnectorEventRecord =>
    eventSeenAt(db, log, key) ? { seen: true, memoryId: eventMemoryAt(db, log, key) } : { seen: false });
}

/** The source event a connector's write answers, by the source's own key. The store logs each key once per connector,
 * across every tenant. */
export type ConnectorEvent =
  | { readonly connector: 'slack'; readonly eventId: string }
  | {
      readonly connector: 'github';
      readonly idempotencyKey: string;
      readonly deliveryId: string;
      readonly eventName: string;
    };

/** An entry a connector brings in. `quarantine` is the review record of flagged content, whose entry already carries
 * its quarantine scope. */
export interface ConnectorWrite extends EntryWrite {
  readonly event?: ConnectorEvent;
  readonly quarantine?: { readonly originalScope: string | null; readonly reason: string };
}

/** 'duplicate': the event's key was logged before; `memoryId` is the id its log row holds, null for an event logged
 * with no memory. */
export type ConnectorWriteOutcome =
  | { readonly outcome: 'written' }
  | { readonly outcome: 'duplicate'; readonly memoryId: string | null };

export interface ConnectorArchive extends RawArchive {
  readonly event: ConnectorEvent;
}

/** A connector's writes with the rows that must commit with them: the event log row
 * that turns a redelivery into a no-op, and the quarantine record of flagged content. */
export interface ConnectorWrites {
  /** entryWrites.writeEntry plus, in its transaction: with `quarantine`, one pending record and quarantine row; with
   * `event`, one log row. All commit or none. A key logged before resolves 'duplicate' and stores nothing (never a
   * rejection); every other refusal is writeEntry's own, decided first. */
  writeConnectorEntry(write: ConnectorWrite): Promise<ConnectorWriteOutcome>;
  /** entryWrites.archiveRaw plus, in its transaction, one log row for `event` naming the archived id, so a redelivery
   * finds it logged; a failed log write undoes the archive. A key logged before keeps its row and does not stop the
   * archive. Reach and every rejection are archiveRaw's own. */
  archiveConnectorEntry(archive: ConnectorArchive): Promise<string>;
}

/** What the event log holds for one event's key; `memoryId` is null for an event logged with no memory. */
export type ConnectorEventRecord = { readonly seen: false } | { readonly seen: true; readonly memoryId: string | null };

export interface DeletionLookup {
  readonly event: ConnectorEvent;
  readonly artifactRef: string;
  readonly tenantId: string;
}

/** `memoryId` is null when the tenant holds no raw row for the artifact. */
export type DeletionTarget = { readonly seen: true } | { readonly seen: false; readonly memoryId: string | null };

export interface ArtifactArchive {
  readonly tenantId: string;
  readonly actor: string;
  readonly artifactRef: string;
  readonly reason: string;
  readonly event: Extract<ConnectorEvent, { readonly connector: 'github' }>;
}

/** One payload a webhook could not use, already redacted, for the dead-letter queue of its connector. */
export type ConnectorDeadLetter =
  ({ readonly connector: 'slack' } & SlackDlqInsert) | ({ readonly connector: 'github' } & GitHubDlqInsert);

/** What a connector delivery reads and writes beside connectorWrites: the event log,
 * tenant routing, the dead-letter queue and the archive of a deleted artifact. */
export interface ConnectorEvents {
  /** The log row of the event's key, in its connector's own key space. */
  eventRecord(event: ConnectorEvent): Promise<ConnectorEventRecord>;
  /** Logs an event that stored no memory, so its redelivery finds it. A key logged before keeps its row, the memory id
   * it names included. */
  markEventSeen(event: ConnectorEvent): Promise<void>;
  /** Both reads on one snapshot: an event logged before answers `seen`, else the raw row the
   * tenant holds for the artifact. Another tenant's row under the same ref is never returned. */
  deletionTarget(lookup: DeletionLookup): Promise<DeletionTarget>;
  /** A logged event answers `duplicate` and changes nothing. Else one transaction archives every raw row of the
   * artifact (archive_raw row each, under `actor`) and logs the event naming the first, or no memory if none; one
   * failed archive undoes all and the log row. No reach check. */
  archiveDeletedArtifact(archive: ArtifactArchive): Promise<{ readonly duplicate: boolean; readonly archived: number }>;
  /** The tenant a Slack team is registered to, or how many workspaces are registered when it is not. */
  slackTeamRoute(teamId: string): Promise<SlackTeamRoute>;
  /** The tenant of the installation, or of the repository when no installation is named, with the size of both routing
   * tables. */
  githubRouting(query: {
    readonly installationId?: string | null;
    readonly repoFullName?: string | null;
  }): Promise<GitHubRouting>;
  /** Appends the row and answers its id. */
  parkDeadLetter(letter: ConnectorDeadLetter): Promise<number>;
}
