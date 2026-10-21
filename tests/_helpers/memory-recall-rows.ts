// The rows a recall leaves in memoryStore's tables, in the shape rowsOf and contextRowsOf read them from hippo.db, so a
// parity test compares the two stores' writes row for row.
import type { MemoryTables } from '../../src/store/memory/tables.js';

const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** As tests/_helpers/recall-golden-seed.ts rowsOf: audit, goal log, stats, traces, token ledger and counters. */
export function memoryRowsOf(t: MemoryTables) {
  const byId = [...t.entries.values()].sort((a, b) => byBytes(a.id, b.id));
  return {
    audit: t.audit
      .filter((e) => e.op.startsWith('recall'))
      .map((e) => ({
        ts: e.ts,
        tenant_id: e.tenantId,
        actor: e.actor,
        op: e.op,
        target_id: e.targetId,
        metadata_json: JSON.stringify(e.metadata),
      })),
    goalRecallLog: [...t.goalRecallLog]
      .sort((a, b) => byBytes(a.memoryId, b.memoryId))
      .map((g) => ({ goal_id: g.goalId, memory_id: g.memoryId, session_id: g.sessionId, score: g.score })),
    stats: [...t.meta]
      .filter(([key]) => key.startsWith('total_'))
      .sort(([a], [b]) => byBytes(a, b))
      .map(([key, value]) => ({ key, value })),
    traces: t.recallTraces.map((r) => ({
      id: r.id,
      tenant_id: r.tenantId,
      session_id: r.sessionId,
      pipeline: r.pipeline,
      result_count: r.results.length,
      explain_mode: r.explainMode ? 1 : 0,
    })),
    traceResults: t.recallTraces.flatMap((r) =>
      r.results.map((x) => ({ trace_id: r.id, memory_id: x.memoryId, result_rank: x.rank, score: x.score })),
    ),
    ledger: t.tokenLedger.map((l) => ({
      tenant_id: l.tenantId,
      session_id: l.sessionId,
      surface: l.surface,
      event: l.event,
      items: l.items,
      tokens: l.tokens,
    })),
    retrieved: byId
      .filter((e) => e.retrievalCount > 0)
      .map((e) => ({ id: e.id, retrieval_count: e.retrievalCount, strength: e.strength })),
  };
}

/** As tests/_helpers/context-fixture.ts contextRowsOf: memoryRowsOf, plus every column a retrieval strengthens. */
export function memoryContextRowsOf(t: MemoryTables) {
  const rows = memoryRowsOf(t);
  return {
    ...rows,
    audit: rows.audit.map((row) => ({ ...row, ts: 'stamped' })),
    strengthened: [...t.entries.values()]
      .sort((a, b) => byBytes(a.id, b.id))
      .map((e) => ({
        id: e.id,
        retrieval_count: e.retrievalCount,
        last_retrieved: e.lastRetrieved,
        half_life_days: e.halfLifeDays,
        strength: e.strength,
      })),
  };
}
