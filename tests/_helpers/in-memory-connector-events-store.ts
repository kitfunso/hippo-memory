// A store other than hippo.db for the ConnectorEvents group, built on the in-memory connector-writes store: it copies tenant routing,
// both dead-letter queues and the backfill cursors out of hippo.db once, then answers from memory and shares the write group's event log.
import type { EntryWrites, HippoStore } from '../../src/entry/store-kit.js';
import type {
  ConnectorDeadLetter,
  ConnectorEvents,
  ConnectorWrites,
  DeadLetterConnector,
  DeadLetterRows,
} from '../../src/store/port.js';
import {
  inMemoryConnectorWritesStore,
  rowsOf,
  sqliteConnectorSide,
  type ConnectorSide,
} from './in-memory-connector-writes-store.js';
import type { StoredCursors, SlackWorkspace } from '../../src/store/port/connectors.js';

/** One dead-letter row of either queue; the columns only the other connector's table has are null. */
export interface ParkedLetter {
  readonly connector: ConnectorDeadLetter['connector'];
  readonly id: number;
  readonly tenantId: string;
  readonly rawPayload: string;
  readonly error: string;
  readonly bucket: string;
  readonly signature: string | null;
  readonly receivedAt: string;
  readonly teamId: string | null;
  readonly slackTimestamp: string | null;
  readonly eventName: string | null;
  readonly deliveryId: string | null;
  readonly installationId: string | null;
  readonly repoFullName: string | null;
  readonly retryCount: number;
  readonly retriedAt: string | null;
}

/** A store under test with a read of both dead-letter queues, Slack's first, each oldest first. */
export interface ConnectorEventsSide extends ConnectorSide {
  readonly letters: () => readonly ParkedLetter[];
}

export interface InMemoryConnectorEventsStore extends ConnectorEventsSide {
  readonly store: HippoStore & {
    readonly entryWrites: EntryWrites;
    readonly connectorWrites: ConnectorWrites;
    readonly connectorEvents: ConnectorEvents;
  };
  readonly forgotten: () => number;
}

interface RepoRoute {
  readonly repoFullName: string;
  readonly tenantId: string;
  readonly addedAt: string;
}

const LETTERS_SQL = `SELECT 'slack' AS connector, id, tenant_id AS tenantId, raw_payload AS rawPayload, error, bucket, signature, received_at AS receivedAt,
    team_id AS teamId, slack_timestamp AS slackTimestamp, NULL AS eventName, NULL AS deliveryId, NULL AS installationId, NULL AS repoFullName,
    retry_count AS retryCount, retried_at AS retriedAt FROM slack_dlq
  UNION ALL SELECT 'github', id, tenant_id, raw_payload, error, bucket, signature, received_at, NULL, NULL, event_name, delivery_id, installation_id, repo_full_name,
    retry_count, retried_at FROM github_dlq
  ORDER BY connector DESC, id`;
const WORKSPACES_SQL = 'SELECT team_id AS teamId, tenant_id AS tenantId, added_at AS addedAt FROM slack_workspaces';
const SLACK_CURSORS_SQL =
  'SELECT tenant_id AS tenantId, channel_id AS channelId, latest_ts AS latestTs FROM slack_cursors';
const GITHUB_CURSORS_SQL = `SELECT tenant_id AS tenantId, repo_full_name AS repo, issues_hwm AS issues, issue_comments_hwm AS issueComments,
  pr_review_comments_hwm AS prReviewComments FROM github_cursors`;
const INSTALLATIONS_SQL = 'SELECT installation_id AS id, tenant_id AS tenantId FROM github_installations';
const REPOSITORIES_SQL =
  'SELECT repo_full_name AS repoFullName, tenant_id AS tenantId, added_at AS addedAt FROM github_repositories ORDER BY added_at, tenant_id';

const lettersAt = (hippoRoot: string): ParkedLetter[] => rowsOf<ParkedLetter>(hippoRoot, LETTERS_SQL);
const tenantById = (hippoRoot: string, sql: string): Map<string, string> =>
  new Map(
    rowsOf<{ id: string; tenantId: string }>(hippoRoot, sql).map((row): [string, string] => [row.id, row.tenantId]),
  );

/** hippo.db's store with the same reads, straight from its tables. */
export function sqliteConnectorEventsSide(hippoRoot: string): ConnectorEventsSide {
  return { ...sqliteConnectorSide(hippoRoot), letters: () => lettersAt(hippoRoot) };
}

function parked(letter: ConnectorDeadLetter, id: number): ParkedLetter {
  const slack = letter.connector === 'slack' ? letter : null;
  const github = letter.connector === 'github' ? letter : null;
  return {
    connector: letter.connector,
    id,
    tenantId: letter.tenantId,
    rawPayload: letter.rawPayload,
    error: letter.error,
    bucket: letter.bucket,
    signature: letter.signature,
    receivedAt: new Date().toISOString(),
    teamId: slack?.teamId ?? null,
    slackTimestamp: slack?.slackTimestamp ?? null,
    eventName: github?.eventName ?? null,
    deliveryId: github?.deliveryId ?? null,
    installationId: github?.installationId ?? null,
    repoFullName: github?.repoFullName ?? null,
    retryCount: 0,
    retriedAt: null,
  };
}

/** A parked row as its own queue's reads answer it. */
function rowOf<C extends DeadLetterConnector>(letter: ParkedLetter): DeadLetterRows[C] {
  const {
    connector: _c,
    teamId,
    slackTimestamp,
    eventName,
    deliveryId,
    installationId,
    repoFullName,
    ...common
  } = letter;
  const own =
    letter.connector === 'slack' ? { teamId, slackTimestamp } : { eventName, deliveryId, installationId, repoFullName };
  // SAFETY: the connector tag picks the columns that queue holds, so the row has exactly that queue's fields.
  return { ...common, ...own } as DeadLetterRows[C];
}

const key = (...parts: string[]): string => parts.join('\u0000');
const HWM_FIELD = {
  issues_hwm: 'issues',
  issue_comments_hwm: 'issueComments',
  pr_review_comments_hwm: 'prReviewComments',
} as const;
type StateMethods = Omit<
  ConnectorEvents,
  | 'eventRecord'
  | 'markEventSeen'
  | 'claimDelivery'
  | 'releaseDelivery'
  | 'deletionTarget'
  | 'archiveDeletedArtifact'
  | 'slackTeamRoute'
  | 'githubRouting'
  | 'parkDeadLetter'
>;

/** The dead-letter reads, backfill cursors and workspace registry, over rows copied once from hippo.db. */
function stateOn(hippoRoot: string, letters: ParkedLetter[], workspaces: Map<string, SlackWorkspace>): StateMethods {
  const slackCursors = new Map(
    rowsOf<{ tenantId: string; channelId: string; latestTs: string }>(hippoRoot, SLACK_CURSORS_SQL).map(
      (r): [string, string] => [key(r.tenantId, r.channelId), r.latestTs],
    ),
  );
  const githubCursors = new Map(
    rowsOf<StoredCursors & { tenantId: string; repo: string }>(hippoRoot, GITHUB_CURSORS_SQL).map(
      ({ tenantId, repo, ...hwm }): [string, StoredCursors] => [key(tenantId, repo), hwm],
    ),
  );
  const none: StoredCursors = { issues: null, issueComments: null, prReviewComments: null };
  const find = (connector: DeadLetterConnector, id: number) =>
    letters.find((row) => row.connector === connector && row.id === id);
  return {
    async deadLetters(connector, tenantId, limit) {
      const rows = letters.filter((row) => row.connector === connector && row.tenantId === tenantId);
      return rows
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id - b.id)
        .slice(0, limit)
        .map((row) => rowOf(row));
    },
    async deadLetter(connector, tenantId, id) {
      const row = find(connector, id);
      return row && row.tenantId === tenantId ? rowOf(row) : null;
    },
    async markDeadLetterRetried(connector, tenantId, id) {
      const row = find(connector, id);
      if (row && row.tenantId === tenantId) {
        letters.splice(letters.indexOf(row), 1, {
          ...row,
          retryCount: row.retryCount + 1,
          retriedAt: new Date().toISOString(),
        });
      }
    },
    slackCursor: async (tenantId, channelId) => slackCursors.get(key(tenantId, channelId)) ?? null,
    async saveSlackCursor(tenantId, channelId, latestTs) {
      slackCursors.set(key(tenantId, channelId), latestTs);
    },
    githubCursors: async (tenantId, repo) => ({ ...(githubCursors.get(key(tenantId, repo)) ?? none) }),
    async saveGitHubHwm(tenantId, repo, column, value) {
      githubCursors.set(key(tenantId, repo), {
        ...(githubCursors.get(key(tenantId, repo)) ?? none),
        [HWM_FIELD[column]]: value,
      });
    },
    async seedGitHubCursors(tenantId, repo, since) {
      const held = githubCursors.get(key(tenantId, repo)) ?? none;
      githubCursors.set(key(tenantId, repo), {
        issues: held.issues ?? since,
        issueComments: held.issueComments ?? since,
        prReviewComments: held.prReviewComments ?? since,
      });
    },
    slackWorkspaces: async () =>
      [...workspaces.values()].sort((a, b) => (a.teamId < b.teamId ? -1 : 1)).map((w) => ({ ...w })),
    async registerSlackWorkspace(teamId, tenantId) {
      const workspace = { teamId, tenantId, addedAt: new Date().toISOString() };
      workspaces.set(teamId, workspace);
      return { ...workspace };
    },
    removeSlackWorkspace: async (teamId) => workspaces.delete(teamId),
  };
}

export function inMemoryConnectorEventsStore(hippoRoot: string): InMemoryConnectorEventsStore {
  const base = inMemoryConnectorWritesStore(hippoRoot);
  const workspaces = new Map(
    rowsOf<SlackWorkspace>(hippoRoot, WORKSPACES_SQL).map((w): [string, SlackWorkspace] => [w.teamId, w]),
  );
  const installations = tenantById(hippoRoot, INSTALLATIONS_SQL);
  const repositories = rowsOf<RepoRoute>(hippoRoot, REPOSITORIES_SQL);
  const letters = lettersAt(hippoRoot);
  const held = new Map<string, number>();

  const connectorEvents: ConnectorEvents = {
    async eventRecord(event) {
      const row = base.logged(event);
      return row ? { seen: true, memoryId: row.memoryId } : { seen: false };
    },
    async markEventSeen(event) {
      base.logOnce(event, null);
    },
    async claimDelivery({ connector, key: deliveryKey, nowMs, ttlMs }) {
      for (const [heldKey, expires] of held) if (expires <= nowMs) held.delete(heldKey);
      const heldKey = key(connector, deliveryKey);
      if (held.has(heldKey)) return false;
      held.set(heldKey, nowMs + ttlMs);
      return true;
    },
    async releaseDelivery(connector, deliveryKey) {
      held.delete(key(connector, deliveryKey));
    },
    async deletionTarget({ event, artifactRef, tenantId }) {
      if (base.logged(event)) return { seen: true };
      return { seen: false, memoryId: base.rawIdsFor(artifactRef, tenantId)[0] ?? null };
    },
    async archiveDeletedArtifact({ tenantId, actor, artifactRef, reason, event }) {
      if (base.logged(event)) return { duplicate: true, archived: 0 };
      const ids = base.rawIdsFor(artifactRef, tenantId);
      if (ids.length === 0) base.logOnce(event, null);
      else await base.archiveAllWith(ids, { actor, reason }, () => base.logOnce(event, ids[0] ?? null));
      return { duplicate: false, archived: ids.length };
    },
    async slackTeamRoute(teamId) {
      const tenantId = workspaces.get(teamId)?.tenantId;
      return tenantId ? { tenantId } : { tenantId: null, workspaceCount: workspaces.size };
    },
    async githubRouting({ installationId, repoFullName }) {
      const counts = { installations: installations.size, repositories: repositories.length };
      if (installationId) return { ...counts, tenant: installations.get(installationId) ?? null };
      // The rows are held oldest first, then by tenant, so the first match is the one hippo.db answers.
      return {
        ...counts,
        tenant: (repoFullName && repositories.find((row) => row.repoFullName === repoFullName)?.tenantId) || null,
      };
    },
    async parkDeadLetter(letter) {
      const id = 1 + Math.max(0, ...letters.filter((row) => row.connector === letter.connector).map((row) => row.id));
      letters.push(parked(letter, id));
      return id;
    },
    ...stateOn(hippoRoot, letters, workspaces),
  };

  return {
    store: { ...base.store, connectorEvents },
    auditRows: base.auditRows,
    events: base.events,
    records: base.records,
    forgotten: base.forgotten,
    letters: () =>
      letters.filter((row) => row.connector === 'slack').concat(letters.filter((row) => row.connector === 'github')),
  };
}
