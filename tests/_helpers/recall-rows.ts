// The rows a recall leaves, cut to the parts a surface or a branch changes: timestamps, query hashes and float scores
// are dropped, so a test asserts which rows were written and never the bytes of one.
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { rowsOf } from './recall-golden-seed.js';

interface AuditRow {
  actor: string;
  op: string;
  target_id: string | null;
  metadata_json: string;
}

/** Each recall audit row as `actor op [target] [results]`. */
export function recallAuditOps(root: string): string[] {
  const db = openHippoDb(root);
  try {
    // SAFETY: the SELECT names exactly the four audit_log columns AuditRow declares.
    const rows = db
      .prepare("SELECT actor, op, target_id, metadata_json FROM audit_log WHERE op LIKE 'recall%' ORDER BY id")
      .all() as AuditRow[];
    return rows.map((a) => {
      // SAFETY: recall audit metadata is the object recallAuditMetadata or a hint helper wrote (src/api/recall/finish.ts).
      const { results } = JSON.parse(a.metadata_json) as { results?: number };
      return [a.actor, a.op, a.target_id, results].filter((part) => part != null).join(' ');
    });
  } finally {
    closeHippoDb(db);
  }
}

export interface RecallWrites {
  /** meta total_recalled. */
  recalled: string;
  /** Each recall_traces row as `pipeline result_count session`. */
  traces: string[];
  /** recall_trace_results memory ids in rank order. */
  ranked: string[];
  /** Each token_ledger row as `surface items session`. */
  ledger: string[];
  /** retrieval_count of every memory recalled at least once. */
  bumped: Record<string, number>;
  /** Each goal_recall_log row as `memory session`. */
  goalLog: string[];
}

/** The columns recallWrites reads from each rowsOf table. */
interface RecallTables {
  stats: { key: string; value: string }[];
  traces: { session_id: string | null; pipeline: string; result_count: number }[];
  traceResults: { memory_id: string }[];
  ledger: { session_id: string | null; surface: string; items: number }[];
  retrieved: { id: string; retrieval_count: number }[];
  goalRecallLog: { memory_id: string; session_id: string }[];
}

export function recallWrites(root: string): RecallWrites {
  const all = rowsOf(root);
  // SAFETY: each array holds the rows of the SELECT rowsOf runs for it (tests/_helpers/recall-golden-seed.ts).
  const rows: RecallTables = {
    stats: all.stats as RecallTables['stats'],
    traces: all.traces as RecallTables['traces'],
    traceResults: all.traceResults as RecallTables['traceResults'],
    ledger: all.ledger as RecallTables['ledger'],
    retrieved: all.retrieved as RecallTables['retrieved'],
    goalRecallLog: all.goalRecallLog as RecallTables['goalRecallLog'],
  };
  return {
    recalled: rows.stats.find((r) => r.key === 'total_recalled')!.value,
    traces: rows.traces.map((t) => `${t.pipeline} ${t.result_count} ${t.session_id ?? '-'}`),
    ranked: rows.traceResults.map((t) => t.memory_id),
    ledger: rows.ledger.map((l) => `${l.surface} ${l.items} ${l.session_id ?? '-'}`),
    bumped: Object.fromEntries(rows.retrieved.map((r) => [r.id, r.retrieval_count])),
    goalLog: rows.goalRecallLog.map((g) => `${g.memory_id} ${g.session_id}`),
  };
}
