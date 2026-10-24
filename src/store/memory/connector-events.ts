// The in-memory ConnectorEvents group: tenant routing, both dead-letter queues, the backfill cursors and delivery
// holds, sharing the event log with ConnectorWrites.
import type {
  ArtifactDeletion,
  ArtifactLookup,
  ConnectorDeadLetter,
  ConnectorEvent,
  ConnectorEvents,
  CursorKey,
  DeadLetterConnector,
  DeadLetterRows,
  DeliveryClaim,
  EventMarked,
  RouteQuery,
  TenantRoute,
} from '../port/connectors.js';
import { NotFoundError } from '../../base/errors/api-errors.js';
import { byBytes } from '../rules/order.js';
import { archiveRow, stage } from './staged.js';
import { eventSlot, logOnce } from './connector-writes.js';
import type { MemoryTables, ParkedLetter } from './tables.js';

const key = (...parts: string[]): string => parts.join('\u0000');

/** The cursors table's key: one key space per connector, then tenant, then the channel or the repository's stream. */
export const cursorSlot = (at: CursorKey): string =>
  at.connector === 'slack'
    ? key(at.connector, at.tenantId, at.channelId)
    : key(at.connector, at.tenantId, at.repo, at.stream);

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
function rawIdsFor(t: MemoryTables, { artifactRef, tenantId }: ArtifactLookup): string[] {
  return [...t.entries.values()]
    .filter((e) => e.artifactRef === artifactRef && e.tenantId === tenantId && e.kind === 'raw')
    .map((e) => e.id);
}

/** Every raw row of the artifact in one staged write with the log row: no reach check, one failed id drops them all. */
function markSeenIn(t: MemoryTables, event: ConnectorEvent, deleted?: ArtifactDeletion): EventMarked {
  if (t.connectorLog.has(eventSlot(event))) return { duplicate: true, archived: 0 };
  const ids = deleted === undefined ? [] : rawIdsFor(t, deleted);
  if (deleted === undefined || ids.length === 0) {
    logOnce(t, event, null);
    return { duplicate: false, archived: 0 };
  }
  const { actor, reason } = deleted;
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

function routeIn(t: MemoryTables, query: RouteQuery): TenantRoute {
  if (query.connector === 'slack') {
    const tenantId = t.slackWorkspaces.get(query.teamId)?.tenantId;
    return tenantId ? { tenantId } : { tenantId: null, routes: t.slackWorkspaces.size };
  }
  const { installationId, repoFullName } = query;
  if (installationId) {
    const tenantId = t.githubInstallations.get(installationId);
    return tenantId ? { tenantId } : { tenantId: null, routes: t.githubInstallations.size };
  }
  // The rows are held oldest first, then by tenant, so a repo two tenants installed routes to the first.
  const match = repoFullName ? t.githubRepositories.find((row) => row.repoFullName === repoFullName) : undefined;
  if (match?.tenantId) return { tenantId: match.tenantId };
  return { tenantId: null, routes: t.githubInstallations.size + t.githubRepositories.length };
}

type Workspaces = Pick<ConnectorEvents, 'slackWorkspaces' | 'registerSlackWorkspace' | 'removeSlackWorkspace'>;

function workspacesOn(t: MemoryTables): Workspaces {
  return {
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

type Letters = Pick<ConnectorEvents, 'parkDeadLetter' | 'deadLetters' | 'markDeadLetterRetried'>;

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
    async deadLetters(connector, tenantId, which) {
      if ('id' in which) {
        const row = find(connector, tenantId, which.id);
        return row ? [rowOf(row)] : [];
      }
      const rows = t.deadLetters.filter((row) => row.connector === connector && row.tenantId === tenantId);
      const ordered = rows.sort((a, b) => byBytes(a.receivedAt, b.receivedAt) || a.id - b.id);
      return ordered.slice(0, which.limit).map((row) => rowOf(row));
    },
    async markDeadLetterRetried(connector, tenantId, id) {
      const row = find(connector, tenantId, id);
      if (!row) return;
      const retried = { ...row, retryCount: row.retryCount + 1, retriedAt: new Date().toISOString() };
      t.deadLetters.splice(t.deadLetters.indexOf(row), 1, retried);
    },
  };
}

export function memoryConnectorEvents(t: MemoryTables): ConnectorEvents {
  return {
    async eventRecord(event, artifact) {
      const row = t.connectorLog.get(eventSlot(event));
      if (row) return { seen: true, memoryId: row.memoryId };
      return artifact ? { seen: false, memoryId: rawIdsFor(t, artifact)[0] ?? null } : { seen: false };
    },
    markEventSeen: async (event, deleted) => markSeenIn(t, event, deleted),
    claimDelivery: async (claim) => claimIn(t, claim),
    async releaseDelivery(connector, deliveryKey) {
      t.deliveryClaims.delete(key(connector, deliveryKey));
    },
    route: async (query) => routeIn(t, query),
    cursor: async (at) => t.cursors.get(cursorSlot(at)) ?? null,
    async saveCursor(at, value, opts) {
      if (opts?.keepSaved !== true || !t.cursors.has(cursorSlot(at))) t.cursors.set(cursorSlot(at), value);
    },
    ...workspacesOn(t),
    ...lettersOn(t),
  };
}
