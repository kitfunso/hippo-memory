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
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from './db.js';
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
 * Strip a RerankStep down to {stage, multiplier, scoreBefore, scoreAfter}
 * before persisting (F3 privacy fix, codex cross-model finding). `note` is
 * free-form human text — the CLI's goal-boost step embeds matched goal tag
 * text there, so persisting it verbatim would leak raw user content into
 * training data via `rerank_json`. Only the four structured fields survive;
 * any other/future free-form field is dropped by construction (allowlist,
 * not a denylist).
 */
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
          r.rerankSteps && r.rerankSteps.length > 0 ? JSON.stringify(sanitizeRerankSteps(r.rerankSteps)) : null,
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
    console.error(`[hippo] recall trace write failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Convenience wrapper: opens a fresh short-lived connection at `root`,
 * writes the trace, and closes. Returns the new trace id, or null on any
 * failure (fail-soft).
 *
 * Used at api.getContext and CLI cmdRecall — sites where the block's own
 * convention is per-call handles (writeEntry, saveIndex) and the earlier
 * audit handles are already closed. NOT used by api.recall, which must
 * reuse the caller's open handle (v1.11.5 no-side-effects contract,
 * tests/api-recall-no-side-effects.test.ts).
 *
 * F1 structural fix (replaces the earlier stamp-then-clear design): this
 * function does NOT touch the `last_trace_id` meta key. Stamping lived here
 * originally, on its own connection, separate from the `last_retrieval_ids`
 * write in `saveIndex` — two connections meant two commits, so a crash or
 * a failed second write could advance one without the other. LOCKSTEP
 * INVARIANT: `last_trace_id` must only ever advance in the SAME write as
 * `last_retrieval_ids`. The caller now does: call this function FIRST, set
 * `localIndex.last_trace_id` from the returned id, THEN call `saveIndex`
 * once — `saveIndex` persists both meta keys in one transaction
 * (store.ts). Call sites that trace WITHOUT advancing `last_retrieval_ids`
 * (CLI cmdRecall's zero-result path, getContext's empty-result path) simply
 * never touch `localIndex` at all — they can't desync by construction.
 *
 * Fail-soft: never throws, including on connection failure.
 */
export function writeRecallTraceAtRoot(root: string, input: RecallTraceInput): number | null {
  let db: DatabaseSyncLike;
  try {
    db = openHippoDb(root);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[hippo] recall trace connection failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  try {
    return writeRecallTrace(db, input);
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
 * F4 validation (codex cross-model finding): `traceId`/`memoryIds` reach
 * this function from caller-side state (`last_trace_id` / applied outcome
 * ids) that can go stale relative to the trace it names — a forgotten
 * memory, a tenant switch mid-session, or a race between two callers. Two
 * checks run before the insert, both skip silently (console.error one
 * line) rather than throw:
 *   1. The named trace must exist and belong to `input.tenantId` — a
 *      tenant mismatch or a dangling id (deleted trace) skips.
 *   2. `input.memoryIds` is intersected against the trace's OWN
 *      `recall_trace_results.memory_id` set — only ids that trace actually
 *      returned are recorded. An id that was never in this trace's result
 *      set (stale caller state) is silently dropped rather than recorded
 *      as a false credit. If the intersection is empty, no row is written.
 *
 * Fail-soft: never throws.
 */
export function recordTraceOutcome(db: DatabaseSyncLike, input: RecordTraceOutcomeInput): void {
  try {
    // SAFETY: row shape matches the single `tenant_id` column named in the
    // SELECT above; sqlite returns undefined when no row matches.
    const trace = db.prepare(`SELECT tenant_id FROM recall_traces WHERE id = ?`).get(input.traceId) as
      | { tenant_id?: string }
      | undefined;
    if (!trace || trace.tenant_id !== input.tenantId) {
      // eslint-disable-next-line no-console
      console.error(`[hippo] recall trace outcome skipped: trace ${input.traceId} missing or tenant mismatch`);
      return;
    }

    // SAFETY: row shape matches the single `memory_id` column named in the
    // SELECT above.
    const memberRows = db
      .prepare(`SELECT memory_id FROM recall_trace_results WHERE trace_id = ?`)
      .all(input.traceId) as Array<{ memory_id: string }>;
    const members = new Set(memberRows.map((r) => r.memory_id));
    const credited = input.memoryIds.filter((id) => members.has(id));
    if (credited.length === 0) {
      // eslint-disable-next-line no-console
      console.error(`[hippo] recall trace outcome skipped: no credited ids intersect trace ${input.traceId}'s results`);
      return;
    }

    db.prepare(`
      INSERT INTO recall_trace_outcomes (trace_id, ts, tenant_id, outcome, memory_ids_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.traceId, new Date().toISOString(), input.tenantId, input.outcome, JSON.stringify(credited));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[hippo] recall trace outcome write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
