// The connector groups of the store port and the rows they read and write.
import type { EntryWrite, RawArchive } from './entry-writes.js';

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
  /** Holds a signed delivery's key from `nowMs` for `ttlMs`; false when a hold on it has not run out. A hold outlives a
   * restart and covers every process on the store. */
  claimDelivery(claim: DeliveryClaim): Promise<boolean>;
  /** Frees a hold whose delivery failed, so the sender's retry gets through. */
  releaseDelivery(connector: ConnectorEvent['connector'], key: string): Promise<void>;
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
  /** The tenant's rows in one queue, oldest first. */
  deadLetters<C extends DeadLetterConnector>(
    connector: C,
    tenantId: string,
    limit: number,
  ): Promise<DeadLetterRows[C][]>;
  deadLetter<C extends DeadLetterConnector>(connector: C, id: number): Promise<DeadLetterRows[C] | null>;
  /** Adds one to the row's retry count and stamps its retry time. */
  markDeadLetterRetried(connector: DeadLetterConnector, id: number): Promise<void>;
  slackCursor(tenantId: string, channelId: string): Promise<string | null>;
  saveSlackCursor(tenantId: string, channelId: string, latestTs: string): Promise<void>;
  githubCursors(tenantId: string, repo: string): Promise<StoredCursors>;
  saveGitHubHwm(tenantId: string, repo: string, column: HwmColumn, value: string): Promise<void>;
  /** Sets each high-water mark the repository has not saved yet to `since`. */
  seedGitHubCursors(tenantId: string, repo: string, since: string): Promise<void>;
  slackWorkspaces(): Promise<SlackWorkspace[]>;
  /** Maps the team to the tenant, replacing any mapping it had. */
  registerSlackWorkspace(teamId: string, tenantId: string): Promise<SlackWorkspace>;
  /** False when the team had no mapping. */
  removeSlackWorkspace(teamId: string): Promise<boolean>;
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

/** One signed delivery to hold, by the key its connector signs: Slack's signature, GitHub's delivery id. */
export interface DeliveryClaim {
  readonly connector: ConnectorEvent['connector'];
  readonly key: string;
  readonly nowMs: number;
  readonly ttlMs: number;
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

// Workspace routing

/** The tenant a team maps to, or how many workspaces are registered when it maps to none. */
export type SlackTeamRoute = { tenantId: string } | { tenantId: null; workspaceCount: number };

/** What the routing tables say about one webhook; `tenant` is the installation match, or the repo match when no
 * installation was sent. */
export interface GitHubRouting {
  installations: number;
  repositories: number;
  tenant: string | null;
}

/** One payload a webhook could not use, already redacted, for the dead-letter queue of its connector. */
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

/** One github_dlq row to write, already redacted by the caller; the four GitHub-only columns are stored NULL when left
 * out. */
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

export interface StoredCursors {
  issues: string | null;
  issueComments: string | null;
  prReviewComments: string | null;
}

export type HwmColumn = 'issues_hwm' | 'issue_comments_hwm' | 'pr_review_comments_hwm';

export interface SlackWorkspace {
  teamId: string;
  tenantId: string;
  addedAt: string; // ISO timestamp
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
