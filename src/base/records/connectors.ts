// The connector repositories of hippo.db's local tier and the rows they read and write.

import type { EntryWrite, RawArchive } from '../ports/store/entry-writes.js';

/** What a connector delivery reads and writes beside connectorWrites, one method family per
 * concept: the event log, delivery holds, tenant routing, dead letters, backfill cursors and the
 * Slack workspace registry. */
export interface ConnectorEvents {
  /** The log row of the event's key, in its connector's own key space. With `artifact`, an event
   * not logged yet also names the raw row the tenant holds for the artifact, read on the same
   * handle; never another tenant's row. */
  eventRecord(event: ConnectorEvent, artifact?: ArtifactLookup): Promise<ConnectorEventRecord>;
  /** A logged event answers `duplicate` and changes nothing; else the event is logged with no
   * memory. With `deleted`, one transaction first archives every raw row of the artifact
   * (archive_raw row each, under `actor`) and the log row names the first; one failed archive
   * undoes all and the log row. No reach check. */
  markEventSeen(event: ConnectorEvent, deleted?: ArtifactDeletion): Promise<EventMarked>;
  /** Holds a signed delivery's key from `nowMs` for `ttlMs`; false when a hold on it has not run
   * out. A hold outlives a restart and covers every process on the store. */
  claimDelivery(claim: DeliveryClaim): Promise<boolean>;
  /** Frees a hold whose delivery failed, so the sender's retry gets through. */
  releaseDelivery(connector: ConnectorEvent['connector'], key: string): Promise<void>;
  /** The tenant the connector's routing rows name for the query, else how many rows a match
   * could have come from. */
  route(query: RouteQuery): Promise<TenantRoute>;
  /** Appends the row and answers its id. */
  parkDeadLetter(letter: ConnectorDeadLetter): Promise<number>;
  /** The tenant's rows in one queue, oldest first, up to `limit`; with `id`, that row alone.
   * Another tenant's row reads as absent. */
  deadLetters<C extends DeadLetterConnector>(
    connector: C,
    tenantId: string,
    which: DeadLetterQuery,
  ): Promise<DeadLetterRows[C][]>;
  /** Adds one to the tenant's row retry count and stamps its retry time; another tenant's row is
   * left alone. */
  markDeadLetterRetried(
    connector: DeadLetterConnector,
    tenantId: string,
    id: number,
  ): Promise<void>;
  /** The backfill position saved under the key, or null before the first save. */
  cursor(key: CursorKey): Promise<string | null>;
  /** With `keepSaved`, a position already saved stays, so a first run's `--since` seeds only
   * what no run saved. */
  saveCursor(key: CursorKey, value: string, opts?: { readonly keepSaved?: boolean }): Promise<void>;
  slackWorkspaces(): Promise<SlackWorkspace[]>;
  /** Maps the team to the tenant, replacing any mapping it had. */
  registerSlackWorkspace(teamId: string, tenantId: string): Promise<SlackWorkspace>;
  /** False when the team had no mapping. */
  removeSlackWorkspace(teamId: string): Promise<boolean>;
}

/** The source event a connector's write answers, by the source's own key. The store logs each
 * key once per connector, across every tenant. */
export type ConnectorEvent =
  | { readonly connector: 'slack'; readonly eventId: string }
  | {
      readonly connector: 'github';
      readonly idempotencyKey: string;
      readonly deliveryId: string;
      readonly eventName: string;
    };

/** One signed delivery to hold, by the key its connector signs: Slack's signature, GitHub's
 * body signature. */
export interface DeliveryClaim {
  readonly connector: ConnectorEvent['connector'];
  readonly key: string;
  readonly nowMs: number;
  readonly ttlMs: number;
}

/** What the event log holds for one event's key; `memoryId` is null for an event logged with no
 * memory. An unlogged event read with an artifact carries the tenant's raw row for it as
 * `memoryId`, null when it holds none. */
export type ConnectorEventRecord =
  | { readonly seen: false; readonly memoryId?: string | null }
  | { readonly seen: true; readonly memoryId: string | null };

/** The artifact a deletion event names, in the tenant whose rows it may archive. */
export interface ArtifactLookup {
  readonly artifactRef: string;
  readonly tenantId: string;
}

export interface ArtifactDeletion extends ArtifactLookup {
  readonly actor: string;
  readonly reason: string;
}

/** `archived` counts the raw rows a deletion archived. */
export interface EventMarked {
  readonly duplicate: boolean;
  readonly archived: number;
}

// Tenant routing

/** A webhook's routing key: a Slack team, or a GitHub installation, else its repository. */
export type RouteQuery =
  | { readonly connector: 'slack'; readonly teamId: string }
  | {
      readonly connector: 'github';
      readonly installationId?: string | null;
      readonly repoFullName?: string | null;
    };

/** `routes` counts the rows a match could have come from: Slack's workspaces, GitHub's
 * installations when one is named, else its installations and repositories. None is a
 * single-tenant install. */
export type TenantRoute =
  | { readonly tenantId: string }
  | { readonly tenantId: null; readonly routes: number };

/** One payload a webhook could not use, already redacted, for the dead-letter queue of
 * its connector. */
export type ConnectorDeadLetter =
  | ({ readonly connector: 'slack' } & SlackDlqInsert)
  | ({ readonly connector: 'github' } & GitHubDlqInsert);

/** One row to park; the two Slack-only columns are stored NULL when left out. */
export interface SlackDlqInsert {
  tenantId: string;
  teamId?: string | null;
  rawPayload: string;
  error: string;
  bucket: SlackDlqBucket;
  signature: string | null;
  slackTimestamp?: string | null;
}

// Dead-letter queue

export type SlackDlqBucket = 'parse_error' | 'unroutable' | 'signature_fail';

/** One github_dlq row to write, already redacted by the caller; the four GitHub-only columns are
 * stored NULL when left out. */
export interface GitHubDlqInsert {
  tenantId: string;
  rawPayload: string;
  error: string;
  eventName?: string | null;
  deliveryId?: string | null;
  signature: string | null;
  installationId?: string | null;
  repoFullName?: string | null;
  bucket: GitHubDlqBucket;
}

export type GitHubDlqBucket = 'parse_error' | 'unroutable' | 'signature_failed' | 'unhandled';

export type DeadLetterConnector = keyof DeadLetterRows;

/** A page of one queue, or one row by id. */
export type DeadLetterQuery = { readonly limit: number } | { readonly id: number };

export interface DeadLetterRows {
  readonly slack: SlackDlqItem;
  readonly github: GitHubDlqItem;
}

export interface SlackDlqItem {
  id: number;
  tenantId: string;
  teamId: string | null;
  rawPayload: string;
  error: string;
  receivedAt: string;
  retriedAt: string | null;
  bucket: SlackDlqBucket | string;
  retryCount: number;
  signature: string | null;
  slackTimestamp: string | null;
}

export interface GitHubDlqItem {
  id: number;
  tenantId: string;
  rawPayload: string;
  error: string;
  eventName: string | null;
  deliveryId: string | null;
  signature: string | null;
  installationId: string | null;
  repoFullName: string | null;
  retryCount: number;
  receivedAt: string;
  retriedAt: string | null;
  bucket: GitHubDlqBucket | string;
}

// Backfill cursors

/** The three GitHub streams a backfill drains, each with its own high-water mark. */
export type GitHubStream = 'issues' | 'issueComments' | 'prReviewComments';

/** What a backfill drains: a Slack channel, or one GitHub stream of a repository. */
export type BackfillStream =
  | { readonly connector: 'slack'; readonly channelId: string }
  | { readonly connector: 'github'; readonly repo: string; readonly stream: GitHubStream };

/** Where a backfill resumes, per tenant: a Slack channel's newest timestamp, or one GitHub
 * stream's high-water mark. */
export type CursorKey = BackfillStream & { readonly tenantId: string };

export interface SlackWorkspace {
  teamId: string;
  tenantId: string;
  addedAt: string; // ISO timestamp
}

/** A connector's writes with the rows that must commit with them: the event log row that turns a
 * redelivery into a no-op, and the quarantine record of flagged content. */
export interface ConnectorWrites {
  /** entryWrites.writeEntry plus, in its transaction: with `quarantine`, one pending record and
   * quarantine row; with `event`, one log row. All commit or none. A key logged before resolves
   * 'duplicate' and stores nothing (never a rejection); every other refusal is writeEntry's own,
   * decided first. */
  writeConnectorEntry(write: ConnectorWrite): Promise<ConnectorWriteOutcome>;
  /** entryWrites.archiveRaw plus, in its transaction, one log row for `event` naming the
   * archived id, so a redelivery finds it logged; a failed log write undoes the archive. A key
   * logged before keeps its row and does not stop the archive. Reach and every rejection are
   * archiveRaw's own. */
  archiveConnectorEntry(archive: ConnectorArchive): Promise<string>;
}

/** An entry a connector brings in. `quarantine` is the review record of flagged content, whose
 * entry already carries its quarantine scope. */
export interface ConnectorWrite extends EntryWrite {
  readonly event?: ConnectorEvent;
  readonly quarantine?: { readonly originalScope: string | null; readonly reason: string };
}

/** 'duplicate': the event's key was logged before; `memoryId` is the id its log row holds, null
 * for an event logged with no memory. */
export type ConnectorWriteOutcome =
  | { readonly outcome: 'written' }
  | { readonly outcome: 'duplicate'; readonly memoryId: string | null };

export interface ConnectorArchive extends RawArchive {
  readonly event: ConnectorEvent;
}
