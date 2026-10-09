// A store other than hippo.db for the ConnectorEvents group, built on the in-memory connector-writes store: it copies tenant routing
// and both dead-letter queues out of hippo.db once, then answers from memory and shares the event log the write group keeps.
import type { EntryWrites, HippoStore } from '../../src/server.js';
import type { ConnectorDeadLetter, ConnectorEvents, ConnectorWrites } from '../../src/store/port.js';
import { inMemoryConnectorWritesStore, rowsOf, sqliteConnectorSide, type ConnectorSide } from './in-memory-connector-writes-store.js';

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
}

/** A store under test with a read of both dead-letter queues, Slack's first, each oldest first. */
export interface ConnectorEventsSide extends ConnectorSide {
  readonly letters: () => readonly ParkedLetter[];
}

export interface InMemoryConnectorEventsStore extends ConnectorEventsSide {
  readonly store: HippoStore & { readonly entryWrites: EntryWrites; readonly connectorWrites: ConnectorWrites; readonly connectorEvents: ConnectorEvents };
  readonly forgotten: () => number;
}

interface RepoRoute {
  readonly repoFullName: string;
  readonly tenantId: string;
  readonly addedAt: string;
}

const LETTERS_SQL = `SELECT 'slack' AS connector, id, tenant_id AS tenantId, raw_payload AS rawPayload, error, bucket, signature, received_at AS receivedAt,
    team_id AS teamId, slack_timestamp AS slackTimestamp, NULL AS eventName, NULL AS deliveryId, NULL AS installationId, NULL AS repoFullName FROM slack_dlq
  UNION ALL SELECT 'github', id, tenant_id, raw_payload, error, bucket, signature, received_at, NULL, NULL, event_name, delivery_id, installation_id, repo_full_name FROM github_dlq
  ORDER BY connector DESC, id`;
const WORKSPACES_SQL = 'SELECT team_id AS id, tenant_id AS tenantId FROM slack_workspaces';
const INSTALLATIONS_SQL = 'SELECT installation_id AS id, tenant_id AS tenantId FROM github_installations';
const REPOSITORIES_SQL = 'SELECT repo_full_name AS repoFullName, tenant_id AS tenantId, added_at AS addedAt FROM github_repositories ORDER BY added_at, tenant_id';

const lettersAt = (hippoRoot: string): ParkedLetter[] => rowsOf<ParkedLetter>(hippoRoot, LETTERS_SQL);
const tenantById = (hippoRoot: string, sql: string): Map<string, string> =>
  new Map(rowsOf<{ id: string; tenantId: string }>(hippoRoot, sql).map((row): [string, string] => [row.id, row.tenantId]));

/** hippo.db's store with the same reads, straight from its tables. */
export function sqliteConnectorEventsSide(hippoRoot: string): ConnectorEventsSide {
  return { ...sqliteConnectorSide(hippoRoot), letters: () => lettersAt(hippoRoot) };
}

function parked(letter: ConnectorDeadLetter, id: number): ParkedLetter {
  const slack = letter.connector === 'slack' ? letter : null;
  const github = letter.connector === 'github' ? letter : null;
  return {
    connector: letter.connector, id, tenantId: letter.tenantId, rawPayload: letter.rawPayload, error: letter.error, bucket: letter.bucket,
    signature: letter.signature, receivedAt: new Date().toISOString(), teamId: slack?.teamId ?? null, slackTimestamp: slack?.slackTimestamp ?? null,
    eventName: github?.eventName ?? null, deliveryId: github?.deliveryId ?? null, installationId: github?.installationId ?? null, repoFullName: github?.repoFullName ?? null,
  };
}

export function inMemoryConnectorEventsStore(hippoRoot: string): InMemoryConnectorEventsStore {
  const base = inMemoryConnectorWritesStore(hippoRoot);
  const workspaces = tenantById(hippoRoot, WORKSPACES_SQL);
  const installations = tenantById(hippoRoot, INSTALLATIONS_SQL);
  const repositories = rowsOf<RepoRoute>(hippoRoot, REPOSITORIES_SQL);
  const letters = lettersAt(hippoRoot);

  const connectorEvents: ConnectorEvents = {
    async eventRecord(event) {
      const row = base.logged(event);
      return row ? { seen: true, memoryId: row.memoryId } : { seen: false };
    },
    async markEventSeen(event) {
      base.logOnce(event, null);
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
      const tenantId = workspaces.get(teamId);
      return tenantId ? { tenantId } : { tenantId: null, workspaceCount: workspaces.size };
    },
    async githubRouting({ installationId, repoFullName }) {
      const counts = { installations: installations.size, repositories: repositories.length };
      if (installationId) return { ...counts, tenant: installations.get(installationId) ?? null };
      // The rows are held oldest first, then by tenant, so the first match is the one hippo.db answers.
      return { ...counts, tenant: (repoFullName && repositories.find((row) => row.repoFullName === repoFullName)?.tenantId) || null };
    },
    async parkDeadLetter(letter) {
      const id = 1 + Math.max(0, ...letters.filter((row) => row.connector === letter.connector).map((row) => row.id));
      letters.push(parked(letter, id));
      return id;
    },
  };

  return {
    store: { ...base.store, connectorEvents },
    auditRows: base.auditRows,
    events: base.events,
    records: base.records,
    forgotten: base.forgotten,
    letters: () => letters.filter((row) => row.connector === 'slack').concat(letters.filter((row) => row.connector === 'github')),
  };
}
