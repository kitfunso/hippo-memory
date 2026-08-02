/**
 * LC1 — retrieval-trace persistence
 * (docs/plans/2026-08-02-lc1-recall-trace-persistence.md).
 *
 * Single producer for the `recall_traces` / `recall_trace_results` /
 * `recall_trace_outcomes` tables (schema v40). Every recall on the three
 * wired paths (api.recall, api.getContext, CLI cmdRecall) writes a trace
 * row: the ids + ranks + scores actually returned. Outcome events that
 * resolve their targets from last-retrieval state link back to the trace
 * they judge via `recordTraceOutcome`. This is the (query, shown, outcome)
 * training triple every Track LC learned component needs.
 *
 * All writes here are fail-soft: a broken trace write must never break the
 * surrounding recall or outcome call. Failures are logged to stderr and
 * swallowed (matches the api.ts ~2843 "audit emit failed" precedent — no
 * new debug env var).
 */

import { createHash } from 'node:crypto';
import { openHippoDb, closeHippoDb, getMeta, setMeta, type DatabaseSyncLike } from './db.js';
import type { RerankStep } from './search.js';

/** One ranked result to persist alongside its trace row. */
export interface RecallTraceResultInput {
  memoryId: string;
  score: number;
  /** Per-stage rerank steps when the caller ran with explain/--why; omitted
   *  (or empty) persists `rerank_json` as NULL. */
  rerankSteps?: RerankStep[];
}

/** Input to `writeRecallTrace` / `writeRecallTraceAtRoot`. */
export interface RecallTraceInput {
  tenantId: string;
  sessionId?: string | null;
  pipeline: 'api' | 'cli' | 'context' | 'mcp';
  /** Raw query text. NEVER persisted — only its sha256/16 hash + length are
   *  stored (GDPR Path A / audit convention, cli.ts:1532). */
  query: string;
  /** True when the caller ran with explain/--why (per-result rerank steps
   *  may be present). Defaults to false. */
  explainMode?: boolean;
  /** Results in returned rank order (index 0 = rank 1). */
  results: RecallTraceResultInput[];
}

/**
 * Insert a `recall_traces` row + its `recall_trace_results` rows in ONE
 * transaction, on the connection handed in. Fail-soft: never throws —
 * logs to stderr and returns null on any failure.
 *
 * Connection policy (per the plan): api.recall calls this directly on its
 * own already-open handle. api.getContext and CLI cmdRecall go through
 * `writeRecallTraceAtRoot` instead, since their audit handles are already
 * closed by the time tracing runs.
 */
export function writeRecallTrace(db: DatabaseSyncLike, input: RecallTraceInput): number | null {
  try {
    const queryHash = createHash('sha256').update(input.query).digest('hex').slice(0, 16);
    const ts = new Date().toISOString();
    db.exec('BEGIN');
    try {
      const insertTrace = db.prepare(`
        INSERT INTO recall_traces (ts, tenant_id, session_id, pipeline, query_hash, query_length, result_count, explain_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
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

      const insertResult = db.prepare(`
        INSERT INTO recall_trace_results (trace_id, tenant_id, memory_id, result_rank, score, rerank_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      input.results.forEach((r, i) => {
        insertResult.run(
          traceId,
          input.tenantId,
          r.memoryId,
          i + 1,
          r.score,
          r.rerankSteps && r.rerankSteps.length > 0 ? JSON.stringify(r.rerankSteps) : null,
        );
      });

      db.exec('COMMIT');
      return traceId;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[hippo] recall trace write failed: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Convenience wrapper: opens a fresh short-lived connection at `root`,
 * writes the trace, and (by default) stamps the `last_trace_id` meta key,
 * then closes.
 *
 * Used at api.getContext and CLI cmdRecall — sites where the block's own
 * convention is per-call handles (writeEntry, saveIndex) and the earlier
 * audit handles are already closed. NOT used by api.recall, which must
 * reuse the caller's open handle and must NOT touch `last_trace_id`
 * (v1.11.5 no-side-effects contract, tests/api-recall-no-side-effects.test.ts).
 *
 * `opts.stampLastTraceId` (default true, independent-review-critic
 * must-fix): pass `false` at any call site that traces a recall WITHOUT
 * also advancing `last_retrieval_ids` — e.g. CLI cmdRecall's zero-result
 * path, which still writes an (empty) trace for training-corpus coverage
 * but does not touch `last_retrieval_ids` (nothing to update). LOCKSTEP
 * INVARIANT: `last_trace_id` must only ever advance when
 * `last_retrieval_ids` also advances in the SAME call. Stamping it from a
 * trace that isn't paired with a `last_retrieval_ids` update would let a
 * later `hippo outcome` link the OLD (stale) last_retrieval_ids against
 * the NEW, unrelated trace — a silent mislinkage in the training data.
 *
 * Fail-soft: never throws, including on connection failure.
 */
export function writeRecallTraceAtRoot(
  root: string,
  input: RecallTraceInput,
  opts?: { stampLastTraceId?: boolean },
): number | null {
  const stampLastTraceId = opts?.stampLastTraceId ?? true;
  let db: DatabaseSyncLike;
  try {
    db = openHippoDb(root);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[hippo] recall trace connection failed: ${(error as Error).message}`);
    return null;
  }
  try {
    const traceId = writeRecallTrace(db, input);
    if (stampLastTraceId) {
      try {
        if (traceId !== null) {
          setMeta(db, 'last_trace_id', String(traceId));
        } else {
          // Failed trace write: CLEAR the key so a later outcome cannot link
          // this recall's ids against the previous, unrelated trace.
          setMeta(db, 'last_trace_id', '');
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`[hippo] last_trace_id write failed: ${(error as Error).message}`);
      }
    }
    return traceId;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Read the `last_trace_id` meta key at `root`. Returns null when unset
 * (fresh store, pre-v40 flow, or a store whose last recall went through
 * api.recall only — api.recall never sets this key). Fail-soft like the
 * writers: a broken connection returns null rather than breaking the
 * surrounding outcome call.
 */
export function readLastTraceId(root: string): number | null {
  try {
    const db = openHippoDb(root);
    try {
      // Strict parse (independent-review-critic MED finding): a bare
      // Number(raw) turns '', whitespace, or garbage into 0/NaN handling
      // that let a whitespace-only meta value parse as 0 — outcome() would
      // then INSERT recall_trace_outcomes.trace_id=0, a masked FK
      // violation (no row id 0 ever exists). Require a clean positive
      // integer string; anything else is treated as unset.
      const raw = getMeta(db, 'last_trace_id', '').trim();
      if (!/^\d+$/.test(raw)) return null;
      const n = Number(raw);
      return n > 0 ? n : null;
    } finally {
      closeHippoDb(db);
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[hippo] last_trace_id read failed: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Write the `last_trace_id` meta key at `root` on its own short-lived
 * connection.
 */
export function writeLastTraceId(root: string, traceId: number): void {
  const db = openHippoDb(root);
  try {
    setMeta(db, 'last_trace_id', String(traceId));
  } finally {
    closeHippoDb(db);
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

/**
 * Record an outcome event against a trace, linking the (query, shown,
 * outcome) triple. Called ONLY where the credited ids actually come from
 * the last-retrieval mechanism (api.outcomeForLastRecall and any outcome
 * flow that resolves its targets from last-retrieval state) or from an
 * SDK caller's explicit `traceId` opt — never unconditionally from
 * api.outcome, which would mislink an explicit-id caller to a stale,
 * unrelated trace.
 *
 * Lives in its own append-only table, not audit_log metadata: audit_log is
 * pruned by `pruneAuditLog`, and pruning must never erase training data.
 *
 * Fail-soft: never throws.
 */
export function recordTraceOutcome(db: DatabaseSyncLike, input: RecordTraceOutcomeInput): void {
  try {
    db.prepare(`
      INSERT INTO recall_trace_outcomes (trace_id, ts, tenant_id, outcome, memory_ids_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.traceId, new Date().toISOString(), input.tenantId, input.outcome, JSON.stringify(input.memoryIds));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[hippo] recall trace outcome write failed: ${(error as Error).message}`);
  }
}
