/** Retrieval-trace persistence: the single producer for `recall_traces`, `recall_trace_results`
 * and `recall_trace_outcomes`. One trace row per recall on api.recall, api.contextGet and
 * printRecall: the (query, shown, outcome) triple the learned components train on. All writes
 * are fail-soft: a failed trace write is logged to stderr and swallowed, never breaking the
 * surrounding call. */

import { getMeta, withWriteScope, type DatabaseSyncLike } from '../../../db/index.js';
import type { RerankStep } from '../../../base/rank/search-types.js';
import { errorFields, errorMessage, log } from '../../../base/util/log.js';
import { blockHash } from '../../../base/util/token-text.js';
import type { RecallTraceInput } from '../../../base/ports/store/recall-writes.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { parseLastTraceId } from '../runtime/rows.js';
import { META_KEY } from '../../../db/meta.js';
import { handleStamp } from '../runtime/handle-clock.js';

/** Strip a RerankStep to {stage, multiplier, scoreBefore, scoreAfter}: `note` is free-form (the
 * CLI goal-boost step embeds goal tag text) and would leak user content into `rerank_json`; an
 * allowlist, so any future free-form field is dropped too. */
function sanitizeRerankSteps(
  steps: RerankStep[],
): Array<Pick<RerankStep, 'stage' | 'multiplier' | 'scoreBefore' | 'scoreAfter'>> {
  return steps.map((s) => ({
    stage: s.stage,
    multiplier: s.multiplier,
    scoreBefore: s.scoreBefore,
    scoreAfter: s.scoreAfter,
  }));
}

const INSERT_TRACE_SQL = `
  INSERT INTO recall_traces (ts, tenant_id, session_id, pipeline, query_hash, query_length, result_count,
  explain_mode)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

// Six binds a row, so this many rows stay under the 999 floor of SQLite's bound-parameter limit.
const RESULT_ROWS_PER_INSERT = 100;

/** Insert a `recall_traces` row and its results rows in ONE transaction on the given connection.
 * Fail-soft: logs to stderr and returns null on failure. api.recall/contextGet reach this via
 * `finishRecall` on their own handle. */
export function writeRecallTrace(db: DatabaseSyncLike, input: RecallTraceInput): number | null {
  try {
    const queryHash = blockHash(input.query);
    const ts = handleStamp(db);
    return withWriteScope(db, 'write_recall_trace', () => {
      const insertTrace = cachedStatement(db, INSERT_TRACE_SQL);
      const traceResult = insertTrace.run(
        ts,
        input.tenantId,
        input.sessionId ?? null,
        input.pipeline,
        queryHash,
        input.query.length,
        input.results.length,
        input.explainMode ? 1 : 0,
      );
      const traceId = Number(traceResult.lastInsertRowid);
      insertTraceResults(db, traceId, input);
      return traceId;
    });
  } catch (error) {
    log.error(`recall trace write failed: ${errorMessage(error)}`, errorFields(error));
    return null;
  }
}

function insertTraceResults(db: DatabaseSyncLike, traceId: number, input: RecallTraceInput): void {
  for (let from = 0; from < input.results.length; from += RESULT_ROWS_PER_INSERT) {
    const chunk = input.results.slice(from, from + RESULT_ROWS_PER_INSERT);
    const binds = chunk.flatMap((r, i) => [
      traceId,
      input.tenantId,
      r.memoryId,
      from + i + 1,
      r.score,
      r.rerankSteps && r.rerankSteps.length > 0
        ? JSON.stringify(sanitizeRerankSteps(r.rerankSteps))
        : null,
    ]);
    cachedStatement(
      db,
      `
          INSERT INTO recall_trace_results (trace_id, tenant_id, memory_id, result_rank, score, rerank_json)
          VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}
        `,
    ).run(...binds);
  }
}

/** Input to `recordTraceOutcome`. */
export interface RecordTraceOutcomeInput {
  traceId: number;
  tenantId: string;
  outcome: 'positive' | 'negative';
  /** Ids actually credited by this outcome event (post tenant-filtering). */
  memoryIds: string[];
}

/** Record an outcome against a trace; call ONLY with ids from last-retrieval state or an SDK
 * `traceId`, never from api.outcome (stale-trace mislink). Skips (log.warn) unless the trace is
 * in `input.tenantId`; keeps only memoryIds it returned. Own table so `auditPrune` cannot erase
 * training data. */
export function recordTraceOutcome(db: DatabaseSyncLike, input: RecordTraceOutcomeInput): void {
  try {
    const trace = cachedStatement(db, `SELECT tenant_id FROM recall_traces WHERE id = ?`).get(
      input.traceId,
    ) as { tenant_id?: string } | undefined;
    if (!trace || trace.tenant_id !== input.tenantId) {
      log.warn(`recall trace outcome skipped: trace ${input.traceId} missing or tenant mismatch`);
      return;
    }

    const memberRows = cachedStatement(
      db,
      `SELECT memory_id FROM recall_trace_results WHERE trace_id = ?`,
    ).all(input.traceId) as Array<{ memory_id: string }>;
    const members = new Set(memberRows.map((r) => r.memory_id));
    const credited = input.memoryIds.filter((id) => members.has(id));
    if (credited.length === 0) {
      log.warn(
        `recall trace outcome skipped: no credited ids intersect trace ${input.traceId}'s results`,
      );
      return;
    }

    cachedStatement(
      db,
      `
      INSERT INTO recall_trace_outcomes (trace_id, ts, tenant_id, outcome, memory_ids_json)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run(input.traceId, handleStamp(db), input.tenantId, input.outcome, JSON.stringify(credited));
  } catch (error) {
    log.error(`recall trace outcome write failed: ${errorMessage(error)}`, errorFields(error));
  }
}

/** Traces before `cutoff` that no outcome names and that are not the last recall's, with their
 * results through the v40 cascade; a trace with an outcome is training data, and the last one
 * may still get its outcome. */
export function pruneRecallTraces(db: DatabaseSyncLike, cutoff: string, limit: number): void {
  const last = parseLastTraceId(getMeta(db, META_KEY.lastTraceId));
  cachedStatement(
    db,
    `
    DELETE FROM recall_traces WHERE id IN (
      SELECT id FROM recall_traces t
      WHERE ts < ? AND id IS NOT ? AND NOT EXISTS (SELECT 1 FROM recall_trace_outcomes o WHERE o.trace_id = t.id)
      ORDER BY ts LIMIT ?
    )
  `,
  ).run(cutoff, last === null ? null : Number(last), limit);
}
