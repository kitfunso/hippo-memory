import type { EntryWrite, RawArchive, SupersedeWrite } from './entry-writes.js';
import type { MethodEffects } from './effects.js';

/** What a connector delivery reads and writes beside connectorWrites, one method family per
 * concept: the event log, delivery holds, tenant routing, dead letters, backfill cursors and the
 * Slack workspace registry. */
export interface ConnectorEvents {
  eventRecord(event: ConnectorEvent, artifact?: ArtifactLookup): Promise<ConnectorEventRecord>;
  markEventSeen(event: ConnectorEvent, deleted?: ArtifactDeletion): Promise<EventMarked>;
  claimDelivery(claim: DeliveryClaim): Promise<boolean>;
  releaseDelivery(connector: ConnectorEvent['connector'], key: string): Promise<void>;
  route(query: RouteQuery): Promise<TenantRoute>;
  parkDeadLetter(letter: ConnectorDeadLetter): Promise<number>;
  deadLetters<C extends DeadLetterConnector>(
    connector: C,
    tenantId: string,
    which: DeadLetterQuery,
  ): Promise<DeadLetterRows[C][]>;
  markDeadLetterRetried(
    connector: DeadLetterConnector,
    tenantId: string,
    id: number,
  ): Promise<void>;
  cursor(key: CursorKey): Promise<string | null>;
  saveCursor(key: CursorKey, value: string, opts?: { readonly keepSaved?: boolean }): Promise<void>;
  slackWorkspaces(): Promise<SlackWorkspace[]>;
  registerSlackWorkspace(teamId: string, tenantId: string): Promise<SlackWorkspace>;
  removeSlackWorkspace(teamId: string): Promise<boolean>;
}

/** What each ConnectorEvents method does to the store; every adapter honours it. */
export const CONNECTOR_EVENTS_EFFECTS = {
  eventRecord: 'read',
  markEventSeen: 'write',
  claimDelivery: 'write',
  releaseDelivery: 'write',
  route: 'read',
  parkDeadLetter: 'write',
  deadLetters: 'read',
  markDeadLetterRetried: 'write',
  cursor: 'read',
  saveCursor: 'write',
  slackWorkspaces: 'read',
  registerSlackWorkspace: 'write',
  removeSlackWorkspace: 'write',
} as const satisfies MethodEffects<ConnectorEvents>;

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

/** One signed delivery to hold, by the key its connector signs: Slack's signature, GitHub's body
 * signature. */
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
  readonly legacyArtifactRef?: string;
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

/** One payload a webhook could not use, already redacted, for the dead-letter queue of its
 * connector. */
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

export type GitHubDlqBucket =
  | 'parse_error'
  | 'unroutable'
  | 'signature_failed'
  | 'unhandled'
  | 'host_mismatch';

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

/** The three GitHub streams a backfill drains, each with its own high-water mark. */
export type GitHubStream = 'issues' | 'issueComments' | 'prReviewComments';

/** Where a backfill resumes: a Slack channel's newest timestamp, or one GitHub stream's
 * high-water mark. */
export type CursorKey =
  | { readonly connector: 'slack'; readonly tenantId: string; readonly channelId: string }
  | {
      readonly connector: 'github';
      readonly tenantId: string;
      readonly repo: string;
      readonly stream: GitHubStream;
    };

export interface SlackWorkspace {
  teamId: string;
  tenantId: string;
  addedAt: string;
}

/** Writes with the rows that must commit with them: the event log row that turns a redelivery into a no-op, and
 * the review record of a held row. */
export interface ConnectorWrites {
  writeConnectorEntry(write: ConnectorWrite): Promise<ConnectorWriteOutcome>;
  archiveConnectorEntry(archive: ConnectorArchive): Promise<string>;
  supersedeHeld?(write: HeldSupersede): Promise<void>;
}

/** What each ConnectorWrites method does to the store; every adapter honours it. */
export const CONNECTOR_WRITES_EFFECTS = {
  writeConnectorEntry: 'write',
  archiveConnectorEntry: 'write',
  supersedeHeld: 'write',
} as const satisfies MethodEffects<ConnectorWrites>;

/** An entry a connector brings in, or a member's write held for review. `quarantine` is the review record, whose
 * entry already carries its quarantine scope. */
export interface ConnectorWrite extends EntryWrite {
  readonly event?: ConnectorEvent;
  readonly quarantine?: { readonly originalScope: string | null; readonly reason: string };
}

/** A member's supersede whose successor waits for review; `quarantine` is its review record. */
export interface HeldSupersede extends SupersedeWrite {
  readonly quarantine: NonNullable<ConnectorWrite['quarantine']>;
}

/** 'duplicate': the event's key was logged before; `memoryId` is the id its log row holds, null
 * for an event logged with no memory. */
export type ConnectorWriteOutcome =
  | { readonly outcome: 'written' }
  | { readonly outcome: 'duplicate'; readonly memoryId: string | null };

export interface ConnectorArchive extends RawArchive {
  readonly event: ConnectorEvent;
}
