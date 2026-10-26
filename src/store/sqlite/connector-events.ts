// hippo.db's half of the ConnectorEvents store group: each call on a handle of its own.
import type { DatabaseSyncLike } from '../../db/index.js';
import { githubCursor, githubRoute, GITHUB_DLQ, saveGitHubCursor } from './connectors/github.js';
import {
  listSlackWorkspaces,
  removeSlackWorkspace,
  saveSlackCursor,
  slackCursor,
  slackTeamRoute,
  SLACK_DLQ,
  upsertSlackWorkspace,
} from './connectors/slack.js';
import { eventRecord, markEventSeen } from './connectors/events.js';
import { claimDelivery, releaseDelivery } from './connectors/replay.js';
import type { OnHandle } from './open.js';
import { answered, bound, type Bodies } from './bound.js';
import type {
  ConnectorEvents,
  CursorKey,
  DeadLetterConnector,
  DeadLetterQuery,
  DeadLetterRows,
  RouteQuery,
  TenantRoute,
} from '../../base/ports/store/connectors.js';

const queueOf = (connector: DeadLetterConnector) => (connector === 'slack' ? SLACK_DLQ : GITHUB_DLQ);

function deadLetters(db: DatabaseSyncLike, connector: DeadLetterConnector, tenantId: string, which: DeadLetterQuery) {
  const queue = queueOf(connector);
  if (!('id' in which)) return queue.list(db, tenantId, which.limit);
  const row = queue.get(db, tenantId, which.id);
  return row === null ? [] : [row];
}

function route(db: DatabaseSyncLike, query: RouteQuery): TenantRoute {
  return query.connector === 'slack' ? slackTeamRoute(db, query.teamId) : githubRoute(db, query);
}

function cursor(db: DatabaseSyncLike, key: CursorKey): string | null {
  return key.connector === 'slack'
    ? slackCursor(db, key.tenantId, key.channelId)
    : githubCursor(db, key.tenantId, key.repo, key.stream);
}

function saveCursor(db: DatabaseSyncLike, key: CursorKey, value: string, opts: { keepSaved?: boolean } = {}): void {
  const keepSaved = opts.keepSaved === true;
  if (key.connector === 'slack') saveSlackCursor(db, key.tenantId, key.channelId, value, keepSaved);
  else saveGitHubCursor(db, key, value, keepSaved);
}

const connectorBodies: Bodies<Omit<ConnectorEvents, 'deadLetters' | 'parkDeadLetter'>> = {
  eventRecord,
  markEventSeen,
  claimDelivery,
  releaseDelivery,
  route,
  markDeadLetterRetried: (db, connector, tenantId, id) => queueOf(connector).markRetried(db, tenantId, id),
  cursor,
  saveCursor,
  slackWorkspaces: listSlackWorkspaces,
  registerSlackWorkspace: upsertSlackWorkspace,
  removeSlackWorkspace,
};

export function sqliteConnectorEvents(on: OnHandle): ConnectorEvents {
  return {
    ...bound(on, connectorBodies),
    parkDeadLetter: (letter) =>
      answered(() =>
        on((db) => (letter.connector === 'slack' ? SLACK_DLQ.insert(db, letter) : GITHUB_DLQ.insert(db, letter))),
      ),
    // SAFETY: queueOf(connector) is the queue holding C's rows, so what it reads is DeadLetterRows[C].
    deadLetters: <C extends DeadLetterConnector>(connector: C, tenantId: string, which: DeadLetterQuery) =>
      answered(() => on((db) => deadLetters(db, connector, tenantId, which) as DeadLetterRows[C][])),
  };
}
