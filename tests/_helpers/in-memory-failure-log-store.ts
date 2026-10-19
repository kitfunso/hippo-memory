// A store other than hippo.db for the FailureLog group and lessonWrites.contentsWithTag, built on the in-memory entry-writes
// store: it copies the failure log out of hippo.db once and answers from memory with only what hippo-memory/store-kit exports.
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { ConflictError } from '../../src/server.js';
import {
  RECALL_DEFAULT_DENY_SCOPES,
  type FailureEvent,
  type FailureLog,
  type FailureOutcome,
  type HippoStore,
} from '../../src/entry/store-kit.js';
import { inMemoryEntryWritesStore } from './in-memory-entry-writes-store.js';
import type { StoreSide } from './store-conformance.js';

export interface InMemoryFailureLogStore extends StoreSide {
  readonly store: HippoStore;
}

interface LoggedFailure {
  readonly id: number;
  readonly ts: string;
  readonly tenantId: string;
  readonly sessionId: string | null;
  readonly requestId: string | null;
  outcome: FailureOutcome;
}

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_FIELD = 128;
const deny: readonly string[] = RECALL_DEFAULT_DENY_SCOPES;

interface CopiedLog {
  readonly rows: LoggedFailure[];
  readonly lastId: number;
}

function copyLog(hippoRoot: string): CopiedLog {
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: the SELECT aliases its six columns to LoggedFailure's fields.
    const rows = db
      .prepare(`SELECT id, ts, tenant_id AS tenantId, session_id AS sessionId, request_id AS requestId, outcome
      FROM failure_log ORDER BY id`)
      .all() as LoggedFailure[];
    const seq = db
      .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'failure_log'`)
      .get<{ seq: number } | undefined>();
    return { rows: rows.map((r) => ({ ...r })), lastId: Number(seq?.seq ?? 0) };
  } finally {
    closeHippoDb(db);
  }
}

function failureLogOn(hippoRoot: string): FailureLog {
  const copied = copyLog(hippoRoot);
  let rows = copied.rows;
  let lastId = copied.lastId;
  const byRequest = (tenantId: string, requestId: string) =>
    rows.find((r) => r.tenantId === tenantId && r.requestId === requestId);
  return {
    async record(event: FailureEvent) {
      const ts = new Date(event.now ?? Date.now()).toISOString();
      const cutoff = new Date(Date.parse(ts) - RETENTION_MS).toISOString();
      rows = rows.filter((r) => r.ts >= cutoff);
      const requestId = event.requestId ?? null;
      if (requestId !== null && byRequest(event.tenantId, requestId)) {
        throw new Error('UNIQUE constraint failed: failure_log.tenant_id, failure_log.request_id');
      }
      lastId += 1;
      rows.push({
        id: lastId,
        ts,
        tenantId: event.tenantId,
        sessionId: event.sessionId?.slice(0, MAX_FIELD) ?? null,
        requestId,
        outcome: event.outcome,
      });
      return lastId;
    },
    async requestOutcome(tenantId, requestId, sessionId) {
      const row = byRequest(tenantId, requestId);
      if (row === undefined) return null;
      if (row.sessionId !== sessionId.slice(0, MAX_FIELD)) {
        throw new ConflictError('request id belongs to another session');
      }
      return row.outcome;
    },
    async settleOutcome(tenantId, requestId, outcome) {
      const row = byRequest(tenantId, requestId);
      if (row) row.outcome = outcome;
    },
  };
}

export function inMemoryFailureLogStore(hippoRoot: string): InMemoryFailureLogStore {
  const base = inMemoryEntryWritesStore(hippoRoot);
  const lessonWrites: HippoStore['lessonWrites'] = {
    ...base.store.lessonWrites,
    async contentsWithTag(tenantId, tag, origins) {
      const inProject = (origin: string | null | undefined): boolean =>
        origins === undefined || origin === '' || (origin != null && origins.includes(origin));
      const admitted = (scope: string | null | undefined): boolean =>
        scope == null || (!deny.includes(scope) && !/:private:/i.test(scope));
      return base
        .allRows()
        .filter(
          (e) => e.tenantId === tenantId && e.tags.includes(tag) && inProject(e.originProject) && admitted(e.scope),
        )
        .map((e) => e.content);
    },
  };
  return { store: { ...base.store, failureLog: failureLogOn(hippoRoot), lessonWrites }, auditRows: base.auditRows };
}
