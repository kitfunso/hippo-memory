// The in-memory ConnectorEvents group: tenant routing, both dead-letter queues, the backfill cursors and delivery
// holds, sharing the event log with ConnectorWrites.
import type {
  ArtifactArchive,
  ConnectorDeadLetter,
  ConnectorEvents,
  DeadLetterConnector,
  DeadLetterRows,
  DeliveryClaim,
  StoredCursors,
} from '../port/connectors.js';
import { NotFoundError } from '../../base/errors/api-errors.js';
import { byBytes } from '../rules/order.js';
import { archiveRow, stage } from './staged.js';
import { eventSlot, logOnce } from './connector-writes.js';
import type { MemoryTables, ParkedLetter } from './tables.js';

const key = (...parts: string[]): string => parts.join('\u0000');
const HWM_FIELD = {
  issues_hwm: 'issues',
  issue_comments_hwm: 'issueComments',
  pr_review_comments_hwm: 'prReviewComments',
} as const;
const NO_CURSORS: StoredCursors = { issues: null, issueComments: null, prReviewComments: null };

function parked(letter: ConnectorDeadLetter, id: number): ParkedLetter {
  const slack = letter.connector === 'slack' ? letter : null;
  const github = letter.connector === 'github' ? letter : null;
  const { connector, tenantId, rawPayload, error, bucket, signature } = letter;
  return {
    connector,
    id,
    tenantId,
    rawPayload,
    error,
    bucket,
    signature,
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

/** The ids of the raw rows the tenant holds under the ref, in the order they were written. */
function rawIdsFor(t: MemoryTables, artifactRef: string, tenantId: string): string[] {
  return [...t.entries.values()]
    .filter((e) => e.artifactRef === artifactRef && e.tenantId === tenantId && e.kind === 'raw')
    .map((e) => e.id);
}

/** Every raw row of the artifact in one staged write with the log row: no reach check, one failed id drops them all. */
function archiveArtifactIn(t: MemoryTables, archive: ArtifactArchive) {
  const { tenantId, actor, artifactRef, reason, event } = archive;
  if (t.connectorLog.has(eventSlot(event))) return { duplicate: true, archived: 0 };
  const ids = rawIdsFor(t, artifactRef, tenantId);
  if (ids.length === 0) {
    logOnce(t, event, null);
    return { duplicate: false, archived: 0 };
  }
  const rows = stage(t, actor, (tx) => {
    const done = ids.map((id) => {
      const row = tx.rows.get(id);
      if (!row) throw new NotFoundError(`memory not found: ${id}`);
      return archiveRow(tx, row, { actor, reason });
    });
    logOnce(t, event, ids[0] ?? null);
    return done;
  });
  t.rawArchive.push(...rows);
  return { duplicate: false, archived: ids.length };
}

function claimIn(t: MemoryTables, { connector, key: deliveryKey, nowMs, ttlMs }: DeliveryClaim): boolean {
  for (const [held, expires] of t.deliveryClaims) if (expires <= nowMs) t.deliveryClaims.delete(held);
  const held = key(connector, deliveryKey);
  if (t.deliveryClaims.has(held)) return false;
  t.deliveryClaims.set(held, nowMs + ttlMs);
  return true;
}

type Routing = Pick<
  ConnectorEvents,
  'slackTeamRoute' | 'githubRouting' | 'slackWorkspaces' | 'registerSlackWorkspace' | 'removeSlackWorkspace'
>;

function routingOn(t: MemoryTables): Routing {
  return {
    async slackTeamRoute(teamId) {
      const tenantId = t.slackWorkspaces.get(teamId)?.tenantId;
      return tenantId ? { tenantId } : { tenantId: null, workspaceCount: t.slackWorkspaces.size };
    },
    async githubRouting({ installationId, repoFullName }) {
      const counts = { installations: t.githubInstallations.size, repositories: t.githubRepositories.length };
      if (installationId) return { ...counts, tenant: t.githubInstallations.get(installationId) ?? null };
      // The rows are held oldest first, then by tenant, so a repo two tenants installed routes to the first.
      const match = repoFullName ? t.githubRepositories.find((row) => row.repoFullName === repoFullName) : undefined;
      return { ...counts, tenant: match?.tenantId || null };
    },
    slackWorkspaces: async () =>
      [...t.slackWorkspaces.values()].sort((a, b) => byBytes(a.teamId, b.teamId)).map((w) => ({ ...w })),
    async registerSlackWorkspace(teamId, tenantId) {
      const workspace = { teamId, tenantId, addedAt: new Date().toISOString() };
      t.slackWorkspaces.set(teamId, workspace);
      return { ...workspace };
    },
    removeSlackWorkspace: async (teamId) => t.slackWorkspaces.delete(teamId),
  };
}

type Letters = Pick<ConnectorEvents, 'parkDeadLetter' | 'deadLetters' | 'deadLetter' | 'markDeadLetterRetried'>;

function lettersOn(t: MemoryTables): Letters {
  const find = (connector: DeadLetterConnector, tenantId: string, id: number): ParkedLetter | undefined =>
    t.deadLetters.find((row) => row.connector === connector && row.tenantId === tenantId && row.id === id);
  return {
    async parkDeadLetter(letter) {
      const ids = t.deadLetters.filter((row) => row.connector === letter.connector).map((row) => row.id);
      const id = 1 + Math.max(0, ...ids);
      t.deadLetters.push(parked(letter, id));
      return id;
    },
    async deadLetters(connector, tenantId, limit) {
      const rows = t.deadLetters.filter((row) => row.connector === connector && row.tenantId === tenantId);
      const ordered = rows.sort((a, b) => byBytes(a.receivedAt, b.receivedAt) || a.id - b.id);
      return ordered.slice(0, limit).map((row) => rowOf(row));
    },
    async deadLetter(connector, tenantId, id) {
      const row = find(connector, tenantId, id);
      return row ? rowOf(row) : null;
    },
    async markDeadLetterRetried(connector, tenantId, id) {
      const row = find(connector, tenantId, id);
      if (!row) return;
      const retried = { ...row, retryCount: row.retryCount + 1, retriedAt: new Date().toISOString() };
      t.deadLetters.splice(t.deadLetters.indexOf(row), 1, retried);
    },
  };
}

type Cursors = Pick<
  ConnectorEvents,
  'slackCursor' | 'saveSlackCursor' | 'githubCursors' | 'saveGitHubHwm' | 'seedGitHubCursors'
>;

function cursorsOn(t: MemoryTables): Cursors {
  const held = (tenantId: string, repo: string): StoredCursors =>
    t.githubCursors.get(key(tenantId, repo)) ?? NO_CURSORS;
  return {
    slackCursor: async (tenantId, channelId) => t.slackCursors.get(key(tenantId, channelId)) ?? null,
    async saveSlackCursor(tenantId, channelId, latestTs) {
      t.slackCursors.set(key(tenantId, channelId), latestTs);
    },
    githubCursors: async (tenantId, repo) => ({ ...held(tenantId, repo) }),
    async saveGitHubHwm(tenantId, repo, column, value) {
      t.githubCursors.set(key(tenantId, repo), { ...held(tenantId, repo), [HWM_FIELD[column]]: value });
    },
    async seedGitHubCursors(tenantId, repo, since) {
      const { issues, issueComments, prReviewComments } = held(tenantId, repo);
      const seeded = {
        issues: issues ?? since,
        issueComments: issueComments ?? since,
        prReviewComments: prReviewComments ?? since,
      };
      t.githubCursors.set(key(tenantId, repo), seeded);
    },
  };
}

export function memoryConnectorEvents(t: MemoryTables): ConnectorEvents {
  return {
    async eventRecord(event) {
      const row = t.connectorLog.get(eventSlot(event));
      return row ? { seen: true, memoryId: row.memoryId } : { seen: false };
    },
    markEventSeen: async (event) => logOnce(t, event, null),
    claimDelivery: async (claim) => claimIn(t, claim),
    async releaseDelivery(connector, deliveryKey) {
      t.deliveryClaims.delete(key(connector, deliveryKey));
    },
    async deletionTarget({ event, artifactRef, tenantId }) {
      if (t.connectorLog.has(eventSlot(event))) return { seen: true };
      return { seen: false, memoryId: rawIdsFor(t, artifactRef, tenantId)[0] ?? null };
    },
    archiveDeletedArtifact: async (archive) => archiveArtifactIn(t, archive),
    ...routingOn(t),
    ...lettersOn(t),
    ...cursorsOn(t),
  };
}
