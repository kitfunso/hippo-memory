// The delivery ledger's prune also deletes recall traces past its 90 days that no outcome names and that are not the
// last recall's, with their results; it reads the same rows whatever the table's size.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeHippoDb, openHippoDb, setMeta, type DatabaseSyncLike } from '../../src/db/index.js';
import {
  recordTraceOutcome,
  writeDeliveryEventOnHandle,
  writeRecallTrace,
} from '../../src/store/sqlite/recall-trace.js';
import type { DeliveryEventInput } from '../../src/base/session/delivery.js';
import { memoryStore } from '../../src/store/memory/store.js';
import { emptyTables } from '../../src/store/memory/tables.js';
import { countMatching, recordStatements } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';

const DAY_MS = 86_400_000;
// The prune counts back from the real clock, so the seeds are stamped from it too.
const daysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();
const TRACE_PRUNE = /^\s*DELETE FROM recall_traces/;

function event(): DeliveryEventInput {
  return {
    ts: new Date().toISOString(),
    tenantId: 'default',
    runtime: 'claude-code',
    eventType: 'prompt-submit',
    surface: 'hook',
    storeHash: 'aaaaaaaaaaaaaaaa',
    writeStore: 'local',
    projectHash: null,
    sessionId: 'sess-1',
    sessionState: 'payload',
    hostTurnId: null,
    promptHash: null,
    promptLength: 10,
    queryHash: null,
    recallTraceId: null,
    blockState: 'sent',
    promptRecall: false,
    consideredCount: 0,
    filteredCount: 0,
    selectedCount: 0,
    emittedCount: 0,
    rejectedCount: 0,
    rejectedUnlisted: 0,
    sectionsShown: 0,
    sectionsDropped: 0,
    budgetTokens: 1500,
    selectedTokens: 0,
    injectedTokens: 0,
    staticHash: null,
    recallHash: null,
    emittedHash: null,
    elapsedMs: 1,
    candidates: [],
  };
}

let root: string;
let db: DatabaseSyncLike;

beforeEach(() => {
  root = makeRoot('trace-prune');
  db = openHippoDb(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  closeHippoDb(db);
});

/** One trace of two results, stamped `ts`. */
function trace(ts: string): number {
  const id = writeRecallTrace(db, {
    tenantId: 'default',
    sessionId: 'sess-1',
    pipeline: 'context',
    query: 'deploy',
    results: [
      { memoryId: 'm1', score: 1 },
      { memoryId: 'm2', score: 0.5 },
    ],
  });
  if (id === null) throw new Error('the trace write failed');
  db.prepare(`UPDATE recall_traces SET ts = ? WHERE id = ?`).run(ts, id);
  return id;
}

/** `n` traces stamped `ts`, each with two results, in two statements so 10,000 seed in well under a second. */
function traces(n: number, ts: string): void {
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  const { top } = db.prepare(`SELECT COALESCE(MAX(id), 0) AS top FROM recall_traces`).get() as { top: number };
  db.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) ` +
      `INSERT INTO recall_traces (ts, tenant_id, session_id, pipeline, query_hash, query_length, result_count) ` +
      `SELECT ?, 'default', 'sess-1', 'context', 'qh', 6, 2 FROM n`,
  ).run(n, ts);
  db.prepare(
    `INSERT INTO recall_trace_results (trace_id, tenant_id, memory_id, result_rank, score) ` +
      `SELECT t.id, 'default', 'm' || r.k, r.k, 1.0 FROM recall_traces t, (SELECT 1 AS k UNION ALL SELECT 2) r ` +
      `WHERE t.id > ?`,
  ).run(top);
}

function ids(sql: string): number[] {
  // SAFETY: each caller's SQL selects one INTEGER column named `id`.
  return (db.prepare(sql).all() as Array<{ id: number }>).map((r) => r.id);
}

const traceIds = (): number[] => ids(`SELECT id FROM recall_traces ORDER BY id`);
const resultTraceIds = (): number[] => ids(`SELECT DISTINCT trace_id AS id FROM recall_trace_results ORDER BY id`);

function count(table: string): number {
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** An old trace with an outcome, an old trace that is the last recall's, and an old one with neither. */
function oldSet() {
  const outcome = trace(daysAgo(120));
  recordTraceOutcome(db, { traceId: outcome, tenantId: 'default', outcome: 'positive', memoryIds: ['m1'] });
  const last = trace(daysAgo(120));
  setMeta(db, 'last_trace_id', String(last));
  return { outcome, last, expired: trace(daysAgo(91)) };
}

describe('the recall trace prune', () => {
  it('deletes only old traces with no outcome that are not the last recall, with their results', () => {
    const { outcome, last, expired } = oldSet();
    const recent = trace(daysAgo(89));
    expect(writeDeliveryEventOnHandle(db, event())).not.toBeNull();
    expect(traceIds()).toEqual([outcome, last, recent]);
    expect(resultTraceIds()).toEqual([outcome, last, recent]);
    expect(count('recall_trace_outcomes')).toBe(1);
    expect(expired).toBeLessThan(recent);
  });

  it('leaves recordTraceOutcome working on the traces it keeps, and skipping one it deleted', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { outcome, last, expired } = oldSet();
    writeDeliveryEventOnHandle(db, event());
    recordTraceOutcome(db, { traceId: last, tenantId: 'default', outcome: 'negative', memoryIds: ['m2'] });
    recordTraceOutcome(db, { traceId: expired, tenantId: 'default', outcome: 'negative', memoryIds: ['m2'] });
    expect(ids(`SELECT trace_id AS id FROM recall_trace_outcomes ORDER BY id`)).toEqual([outcome, last]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(`trace ${expired} missing or tenant mismatch`);
  });

  it('runs the same statements and reads the same rows at 1,000 and 10,000 traces, through the ts index', () => {
    const runs = [1000, 10_000].map((size) => {
      closeHippoDb(db);
      root = makeRoot('trace-prune-flat');
      db = openHippoDb(root);
      traces(size, daysAgo(10));
      oldSet();
      const log = recordStatements(() => writeDeliveryEventOnHandle(db, event()));
      const prune = log.statements.find((sql) => TRACE_PRUNE.test(sql));
      if (prune === undefined) throw new Error('the write did not prune traces');
      // SAFETY: EXPLAIN QUERY PLAN rows carry a TEXT `detail` column.
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${prune}`).all() as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join(' | ');
      return { statements: log.statements, rowsRead: log.rowsRead, plan, left: count('recall_traces') };
    });
    expect(runs.map((r) => r.left)).toEqual([1002, 10_002]);
    expect(runs[1].statements).toEqual(runs[0].statements);
    expect(runs[1].rowsRead).toBe(runs[0].rowsRead);
    expect(countMatching(runs[0].statements, TRACE_PRUNE)).toBe(1);
    for (const { plan } of runs) {
      expect(plan).toMatch(/SEARCH t USING (COVERING )?INDEX idx_recall_traces_ts \(ts<\?\)/);
      expect(plan).not.toMatch(/SCAN (t|recall_traces)\b/);
    }
  });

  it('deletes at most 1,000 traces a prune, and the next prune takes the rest', () => {
    traces(1005, daysAgo(200));
    writeDeliveryEventOnHandle(db, event());
    expect(count('recall_traces')).toBe(5);
    writeDeliveryEventOnHandle(db, event());
    expect(count('recall_traces')).toBe(0);
    expect(count('recall_trace_results')).toBe(0);
  });
});

describe('the memory store', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops traces past 90 days when it writes a trace, and keeps the rest', async () => {
    const tables = emptyTables();
    const store = memoryStore(tables);
    const recallAt = async (ms: number): Promise<void> => {
      vi.setSystemTime(ms);
      await store.finishRecall({
        goalLog: [],
        audit: [],
        trace: { tenantId: 'default', pipeline: 'context', query: 'deploy', results: [{ memoryId: 'm1', score: 1 }] },
      });
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    await recallAt(now - 91 * DAY_MS);
    await recallAt(now - 89 * DAY_MS);
    expect(tables.recallTraces.map((r) => r.id)).toEqual([1, 2]);
    await recallAt(now);
    expect(tables.recallTraces.map((r) => r.id)).toEqual([2, 3]);
  });
});
