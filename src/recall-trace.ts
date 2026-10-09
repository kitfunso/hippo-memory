/**
 * Retrieval-trace persistence.
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
import { openHippoDb, closeHippoDb, rethrowIfSqliteBlocked, type DatabaseSyncLike } from './db.js';
import type { RerankStep } from './search/types.js';
import { DELIVERY_LEDGER_VERSION, type DeliveryEventInput } from './delivery-recorder.js';
import { log } from './log.js';

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
 * before persisting. `note` is
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
    db.exec('BEGIN IMMEDIATE');
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
      try { db.exec('ROLLBACK'); } catch { /* already rolled back; keep the original error */ }
      throw error;
    }
  } catch (error) {
    log.error(`recall trace write failed: ${error instanceof Error ? error.message : String(error)}`);
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
 * reuse the caller's open handle (no-side-effects contract,
 * tests/api-recall-no-side-effects.test.ts).
 *
 * This function does NOT touch the `last_trace_id` meta key: its own connection
 * would commit apart from `saveIndex`, so a crash could advance one key alone. LOCKSTEP
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
    rethrowIfSqliteBlocked(error);
    log.error(`recall trace connection failed: ${error instanceof Error ? error.message : String(error)}`);
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
 * Validation: `traceId`/`memoryIds` reach
 * this function from caller-side state (`last_trace_id` / applied outcome
 * ids) that can go stale relative to the trace it names — a forgotten
 * memory, a tenant switch mid-session, or a race between two callers. Two
 * checks run before the insert, both skip with one log.warn line
 * rather than throw:
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
      log.warn(`recall trace outcome skipped: trace ${input.traceId} missing or tenant mismatch`);
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
      log.warn(`recall trace outcome skipped: no credited ids intersect trace ${input.traceId}'s results`);
      return;
    }

    db.prepare(`
      INSERT INTO recall_trace_outcomes (trace_id, ts, tenant_id, outcome, memory_ids_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.traceId, new Date().toISOString(), input.tenantId, input.outcome, JSON.stringify(credited));
  } catch (error) {
    log.error(`recall trace outcome write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Pruned on write, counted back from the event's ts capped at the real clock, so a far-future fake time spares real rows. */
export const DELIVERY_LEDGER_RETENTION_DAYS = 90;
/** Lock wait for the ledger's own connection: a busy store drops the row rather than slow the hook. */
export const DELIVERY_LEDGER_WAIT_MS = 50;
/** Two prompt-identical events without a host turn id, or two boundary events of one type, this close are one fire twice. */
export const DELIVERY_DUPLICATE_WINDOW_MS = 2000;

const DELIVERY_EVENT_COLUMNS = [
  'ts', 'ledger_version', 'tenant_id', 'runtime', 'event_type', 'surface', 'store_hash', 'write_store', 'project_hash',
  'session_id', 'session_state', 'host_turn_id', 'turn_seq', 'duplicate_of', 'prompt_hash', 'prompt_length', 'query_hash',
  'recall_trace_id', 'block_state', 'prompt_recall', 'considered_count', 'filtered_count', 'selected_count', 'emitted_count',
  'rejected_count', 'rejected_unlisted', 'sections_shown', 'sections_dropped', 'budget_tokens', 'selected_tokens',
  'injected_tokens', 'static_hash', 'recall_hash', 'emitted_hash', 'elapsed_ms',
] as const;

/** One stored `delivery_candidates` row. */
export interface DeliveryCandidateRow {
  event_id: number;
  tenant_id: string;
  memory_id: string;
  source_store: string;
  pool: string;
  stage: string;
  outcome: string;
  reason: string | null;
  cand_rank: number | null;
  score: number | null;
  tokens: number | null;
}

/** One stored `delivery_events` row with its candidate rows. */
export interface DeliveryEventRow {
  id: number;
  ts: string;
  ledger_version: number;
  tenant_id: string;
  runtime: string;
  event_type: string;
  surface: string;
  store_hash: string;
  write_store: string;
  project_hash: string | null;
  session_id: string | null;
  session_state: string;
  host_turn_id: string | null;
  turn_seq: number | null;
  duplicate_of: number | null;
  prompt_hash: string | null;
  prompt_length: number;
  query_hash: string | null;
  recall_trace_id: number | null;
  block_state: string;
  prompt_recall: number;
  considered_count: number;
  filtered_count: number;
  selected_count: number;
  emitted_count: number;
  rejected_count: number;
  rejected_unlisted: number;
  sections_shown: number;
  sections_dropped: number;
  budget_tokens: number;
  selected_tokens: number;
  injected_tokens: number;
  static_hash: string | null;
  recall_hash: string | null;
  emitted_hash: string | null;
  elapsed_ms: number;
  candidates: DeliveryCandidateRow[];
}

function findDuplicateBoundary(db: DatabaseSyncLike, input: DeliveryEventInput): number | null {
  // SAFETY: rows carry exactly the `id` and `ts` columns selected.
  const rows = db.prepare(`
    SELECT id, ts FROM delivery_events
    WHERE tenant_id = ? AND session_id = ? AND event_type = ? AND turn_seq IS NOT NULL
    ORDER BY id
  `).all(input.tenantId, input.sessionId, input.eventType) as Array<{ id: number; ts: string }>;
  const at = Date.parse(input.ts);
  return rows.find((r) => Math.abs(Date.parse(r.ts) - at) <= DELIVERY_DUPLICATE_WINDOW_MS)?.id ?? null;
}

function findDuplicateTurn(db: DatabaseSyncLike, input: DeliveryEventInput): number | null {
  // A boundary has no prompt, and two compactions of one session never start within the window, so time alone decides.
  if (input.eventType === 'pre-compact' || input.eventType === 'compact-resume') return findDuplicateBoundary(db, input);
  if (input.hostTurnId !== null) {
    // SAFETY: a single `id` column, undefined when no row matches.
    const row = db.prepare(`
      SELECT id FROM delivery_events
      WHERE tenant_id = ? AND session_id = ? AND event_type = ? AND host_turn_id = ? AND turn_seq IS NOT NULL
      ORDER BY id LIMIT 1
    `).get(input.tenantId, input.sessionId, input.eventType, input.hostTurnId) as { id: number } | undefined;
    return row?.id ?? null;
  }
  if (input.promptHash === null) return null;
  // SAFETY: rows carry exactly the `id` and `ts` columns selected.
  const rows = db.prepare(`
    SELECT id, ts FROM delivery_events
    WHERE tenant_id = ? AND session_id = ? AND event_type = ? AND prompt_hash = ? AND host_turn_id IS NULL AND turn_seq IS NOT NULL
    ORDER BY id
  `).all(input.tenantId, input.sessionId, input.eventType, input.promptHash) as Array<{ id: number; ts: string }>;
  const at = Date.parse(input.ts);
  // Absolute difference: two hook processes can commit out of ts order.
  return rows.find((r) => Math.abs(Date.parse(r.ts) - at) <= DELIVERY_DUPLICATE_WINDOW_MS)?.id ?? null;
}

function nextTurnSeq(db: DatabaseSyncLike, input: DeliveryEventInput): number {
  // SAFETY: a single MAX aggregate aliased `m`, NULL when the session has no turns yet.
  const row = db.prepare(`
    SELECT MAX(turn_seq) AS m FROM delivery_events
    WHERE tenant_id = ? AND session_id = ? AND event_type = ? AND turn_seq IS NOT NULL
  `).get(input.tenantId, input.sessionId, input.eventType) as { m: number | null };
  return (row.m ?? 0) + 1;
}

/** One event plus its candidates in one write transaction, then prune; fail-soft. The caller must not hold a transaction on `db`. */
export function writeDeliveryEvent(db: DatabaseSyncLike, input: DeliveryEventInput): number | null {
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Missing-session and sub-agent events are not turns of a session, so they get no number and no duplicate check.
      const isTurn = input.sessionId !== null && (input.sessionState === 'payload' || input.sessionState === 'env');
      const duplicateOf = isTurn ? findDuplicateTurn(db, input) : null;
      const turnSeq = isTurn && duplicateOf === null ? nextTurnSeq(db, input) : null;
      const values = [
        input.ts, DELIVERY_LEDGER_VERSION, input.tenantId, input.runtime, input.eventType, input.surface, input.storeHash,
        input.writeStore, input.projectHash, input.sessionId, input.sessionState, input.hostTurnId, turnSeq, duplicateOf,
        input.promptHash, input.promptLength, input.queryHash, input.recallTraceId, input.blockState, input.promptRecall ? 1 : 0,
        input.consideredCount, input.filteredCount, input.selectedCount, input.emittedCount, input.rejectedCount,
        input.rejectedUnlisted, input.sectionsShown, input.sectionsDropped, input.budgetTokens, input.selectedTokens,
        input.injectedTokens, input.staticHash, input.recallHash, input.emittedHash, Math.round(input.elapsedMs),
      ];
      const eventId = Number(db.prepare(`
        INSERT INTO delivery_events (${DELIVERY_EVENT_COLUMNS.join(', ')})
        VALUES (${DELIVERY_EVENT_COLUMNS.map(() => '?').join(', ')})
      `).run(...values).lastInsertRowid);
      const insertCandidate = db.prepare(`
        INSERT INTO delivery_candidates (event_id, tenant_id, memory_id, source_store, pool, stage, outcome, reason, cand_rank, score, tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const c of input.candidates) {
        insertCandidate.run(eventId, input.tenantId, c.memoryId, c.sourceStore, c.pool, c.stage, c.outcome, c.reason, c.rank, c.score, c.tokens);
      }
      const pruneFrom = Math.min(Date.parse(input.ts), Date.now());
      const cutoff = new Date(pruneFrom - DELIVERY_LEDGER_RETENTION_DAYS * 86_400_000).toISOString();
      db.prepare(`DELETE FROM delivery_events WHERE ts < ?`).run(cutoff);
      db.exec('COMMIT');
      return eventId;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back (SQLITE_FULL, IOERR); keep the original error */ }
      throw error;
    }
  } catch (error) {
    // The prompt hook's stderr shows this exact `[hippo] delivery ledger` line, so it stays off the logger's format.
    console.error(`[hippo] delivery ledger write failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Write on the request's handle, or a short-lived one, waiting at most {@link DELIVERY_LEDGER_WAIT_MS} for the lock. Fail-soft. */
export function writeDeliveryEventAtRoot(root: string, input: DeliveryEventInput): number | null {
  let db: DatabaseSyncLike;
  try {
    db = openHippoDb(root);
  } catch (error) {
    // Same hook stderr line as writeDeliveryEvent above.
    console.error(`[hippo] delivery ledger write failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  try {
    return writeDeliveryEventOnHandle(db, input);
  } finally {
    closeHippoDb(db);
  }
}

/** On a caller's open handle, which saves a second open and close per turn; the handle's own lock wait comes back after. */
export function writeDeliveryEventOnHandle(db: DatabaseSyncLike, input: DeliveryEventInput): number | null {
  const prior = Math.trunc(Number(db.prepare('PRAGMA busy_timeout').get<{ timeout: number }>().timeout));
  db.exec(`PRAGMA busy_timeout = ${DELIVERY_LEDGER_WAIT_MS}`);
  try {
    return writeDeliveryEvent(db, input);
  } finally {
    db.exec(`PRAGMA busy_timeout = ${prior}`);
  }
}

/** A session's delivery events in write order, each with its candidate rows; `sessionId` null reads session-less events. */
export function readDeliveryEvents(db: DatabaseSyncLike, tenantId: string, sessionId: string | null): DeliveryEventRow[] {
  // SAFETY: SELECT * over delivery_events returns exactly the columns DeliveryEventRow names, less `candidates`.
  const events = db.prepare(`SELECT * FROM delivery_events WHERE tenant_id = ? AND session_id IS ? ORDER BY id`)
    .all(tenantId, sessionId) as Array<Omit<DeliveryEventRow, 'candidates'>>;
  const candidates = db.prepare(`
    SELECT * FROM delivery_candidates WHERE event_id = ?
    ORDER BY outcome = 'rejected', cand_rank, memory_id
  `);
  return events.map((e) => ({
    ...e,
    // SAFETY: SELECT * over delivery_candidates returns exactly the columns DeliveryCandidateRow names.
    candidates: candidates.all(e.id) as DeliveryCandidateRow[],
  }));
}
