/** Retrieval-trace persistence: the single producer for `recall_traces`, `recall_trace_results` and `recall_trace_outcomes`.
 * One trace row per recall on api.recall, api.getContext and CLI cmdRecall: the (query, shown, outcome) triple the learned components train on.
 * All writes are fail-soft: a failed trace write is logged to stderr and swallowed, never breaking the surrounding call. */

import { openHippoDb, closeHippoDb, rethrowIfSqliteBlocked, withWriteScope, type DatabaseSyncLike } from '../db/index.js';
import type { RerankStep } from '../core/search-types.js';
import { DELIVERY_LEDGER_VERSION, isBoundaryEvent, type DeliveryEventInput } from './delivery-recorder.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import { DAY_MS } from '../util/time.js';
import { blockHash } from '../util/token-text.js';

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
   *  stored (GDPR Path A / audit convention, CLI). */
  query: string;
  /** True when the caller ran with explain/--why (per-result rerank steps
   *  may be present). Defaults to false. */
  explainMode?: boolean;
  /** Results in returned rank order (index 0 = rank 1). */
  results: RecallTraceResultInput[];
}

/** Strip a RerankStep to {stage, multiplier, scoreBefore, scoreAfter}: `note` is free-form (the CLI goal-boost step embeds goal tag text) and would leak
 * user content into `rerank_json`; an allowlist, so any future free-form field is dropped too. */
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

/** Insert a `recall_traces` row and its results rows in ONE transaction on the given connection. Fail-soft: logs to stderr and returns null on failure.
 * api.recall/getContext reach this via `finishRecallAt` on their own handle; CLI cmdRecall uses `writeRecallTraceAtRoot` (its audit handle is closed). */
export function writeRecallTrace(db: DatabaseSyncLike, input: RecallTraceInput): number | null {
  try {
    const queryHash = blockHash(input.query);
    const ts = new Date().toISOString();
    return withWriteScope(db, 'write_recall_trace', () => {
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

      return traceId;
    });
  } catch (error) {
    log.error(`recall trace write failed: ${errorMessage(error)}`, errorFields(error));
    return null;
  }
}

/** Short-lived connection at `root`: writes the trace, closes; returns the id or null (fail-soft). For CLI cmdRecall; api.recall must reuse its open handle.
 * LOCKSTEP: never touches `last_trace_id`, which advances only in the same `saveIndex` write as `last_retrieval_ids`; the caller sets it from the id. */
export function writeRecallTraceAtRoot(root: string, input: RecallTraceInput): number | null {
  let db: DatabaseSyncLike;
  try {
    db = openHippoDb(root);
  } catch (error) {
    rethrowIfSqliteBlocked(error);
    log.error(`recall trace connection failed: ${errorMessage(error)}`, errorFields(error));
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

/** Record an outcome against a trace; call ONLY with ids from last-retrieval state or an SDK `traceId`, never from api.outcome (stale-trace mislink).
 * Skips (log.warn) unless the trace is in `input.tenantId`; keeps only memoryIds it returned. Own table so `pruneAuditLog` cannot erase training data. */
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
    log.error(`recall trace outcome write failed: ${errorMessage(error)}`, errorFields(error));
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
  if (isBoundaryEvent(input.eventType)) return findDuplicateBoundary(db, input);
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
    return withWriteScope(db, 'write_delivery_event', () => {
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
      const cutoff = new Date(pruneFrom - DELIVERY_LEDGER_RETENTION_DAYS * DAY_MS).toISOString();
      db.prepare(`DELETE FROM delivery_events WHERE ts < ?`).run(cutoff);
      return eventId;
    });
  } catch (error) {
    log.error(`delivery ledger write failed: ${errorMessage(error)}`);
    return null;
  }
}

/** Write on the request's handle, or a short-lived one, waiting at most {@link DELIVERY_LEDGER_WAIT_MS} for the lock. Fail-soft. */
export function writeDeliveryEventAtRoot(root: string, input: DeliveryEventInput): number | null {
  let db: DatabaseSyncLike;
  try {
    db = openHippoDb(root);
  } catch (error) {
    log.error(`delivery ledger write failed: ${errorMessage(error)}`);
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
