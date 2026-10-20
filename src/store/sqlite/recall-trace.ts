/** Retrieval-trace persistence: the single producer for `recall_traces`, `recall_trace_results` and
 * `recall_trace_outcomes`. One trace row per recall on api.recall, api.contextGet and printRecall: the (query, shown,
 * outcome) triple the learned components train on. All writes are fail-soft: a failed trace write is logged to stderr
 * and swallowed, never breaking the surrounding call. */

import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import type { OnHandle } from './open.js';
import type { RerankStep } from '../../base/rank/search-types.js';
import { DELIVERY_LEDGER_VERSION, isBoundaryEvent } from '../../base/session/delivery.js';
import type { DeliveryEventInput } from '../../base/session/delivery.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { DAY_MS } from '../../base/util/time.js';
import { blockHash } from '../../base/util/token-text.js';
import { placeholders, rowsPerStatement, valuesRows } from '../../base/util/sql.js';
import { chunked } from '../../base/util/chunked.js';
import type { RecallTraceInput } from '../port/recall-writes.js';
import { cachedStatement } from '../../db/statement-cache.js';

/** Strip a RerankStep to {stage, multiplier, scoreBefore, scoreAfter}: `note` is free-form (the CLI goal-boost step
 * embeds goal tag text) and would leak user content into `rerank_json`; an allowlist, so any future free-form field is
 * dropped too. */
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

// Six binds a row; 100 rows is 600, under the 999 floor of SQLite's bound-parameter limit.
const RESULT_ROWS_PER_INSERT = 100;

/** Insert a `recall_traces` row and its results rows in ONE transaction on the given connection. Fail-soft: logs to
 * stderr and returns null on failure. api.recall/contextGet reach this via `finishRecallAt` on their own handle. */
export function writeRecallTrace(db: DatabaseSyncLike, input: RecallTraceInput): number | null {
  try {
    const queryHash = blockHash(input.query);
    const ts = new Date().toISOString();
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

      for (let from = 0; from < input.results.length; from += RESULT_ROWS_PER_INSERT) {
        const chunk = input.results.slice(from, from + RESULT_ROWS_PER_INSERT);
        const binds = chunk.flatMap((r, i) => [
          traceId,
          input.tenantId,
          r.memoryId,
          from + i + 1,
          r.score,
          r.rerankSteps && r.rerankSteps.length > 0 ? JSON.stringify(sanitizeRerankSteps(r.rerankSteps)) : null,
        ]);
        cachedStatement(
          db,
          `
          INSERT INTO recall_trace_results (trace_id, tenant_id, memory_id, result_rank, score, rerank_json)
          VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}
        `,
        ).run(...binds);
      }

      return traceId;
    });
  } catch (error) {
    log.error(`recall trace write failed: ${errorMessage(error)}`, errorFields(error));
    return null;
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

/** Record an outcome against a trace; call ONLY with ids from last-retrieval state or an SDK `traceId`, never from
 * api.outcome (stale-trace mislink). Skips (log.warn) unless the trace is in `input.tenantId`; keeps only memoryIds it
 * returned. Own table so `auditPrune` cannot erase training data. */
export function recordTraceOutcome(db: DatabaseSyncLike, input: RecordTraceOutcomeInput): void {
  try {
    const trace = cachedStatement(db, `SELECT tenant_id FROM recall_traces WHERE id = ?`).get(input.traceId) as
      | { tenant_id?: string }
      | undefined;
    if (!trace || trace.tenant_id !== input.tenantId) {
      log.warn(`recall trace outcome skipped: trace ${input.traceId} missing or tenant mismatch`);
      return;
    }

    const memberRows = cachedStatement(db, `SELECT memory_id FROM recall_trace_results WHERE trace_id = ?`).all(
      input.traceId,
    ) as Array<{ memory_id: string }>;
    const members = new Set(memberRows.map((r) => r.memory_id));
    const credited = input.memoryIds.filter((id) => members.has(id));
    if (credited.length === 0) {
      log.warn(`recall trace outcome skipped: no credited ids intersect trace ${input.traceId}'s results`);
      return;
    }

    cachedStatement(
      db,
      `
      INSERT INTO recall_trace_outcomes (trace_id, ts, tenant_id, outcome, memory_ids_json)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run(input.traceId, new Date().toISOString(), input.tenantId, input.outcome, JSON.stringify(credited));
  } catch (error) {
    log.error(`recall trace outcome write failed: ${errorMessage(error)}`, errorFields(error));
  }
}

/** Pruned by a write when the store's schedule is due, counted back from the event's ts capped at the real clock, so a
 * far-future fake time spares real rows. */
const DELIVERY_LEDGER_RETENTION_DAYS = 90;
/** Lock wait for the ledger's own connection: a busy store drops the row rather than slow the hook. */
const DELIVERY_LEDGER_WAIT_MS = 50;
/** Two prompt-identical events without a host turn id, or two boundary events of one type, this close are one fire
 * twice. */
const DELIVERY_DUPLICATE_WINDOW_MS = 2000;

const DELIVERY_EVENT_COLUMNS = [
  'ts',
  'ledger_version',
  'tenant_id',
  'runtime',
  'event_type',
  'surface',
  'store_hash',
  'write_store',
  'project_hash',
  'session_id',
  'session_state',
  'host_turn_id',
  'turn_seq',
  'duplicate_of',
  'prompt_hash',
  'prompt_length',
  'query_hash',
  'recall_trace_id',
  'block_state',
  'prompt_recall',
  'considered_count',
  'filtered_count',
  'selected_count',
  'emitted_count',
  'rejected_count',
  'rejected_unlisted',
  'sections_shown',
  'sections_dropped',
  'budget_tokens',
  'selected_tokens',
  'injected_tokens',
  'static_hash',
  'recall_hash',
  'emitted_hash',
  'elapsed_ms',
  'tool_use_id',
  'failure_id',
] as const;

function findDuplicateBoundary(db: DatabaseSyncLike, input: DeliveryEventInput): number | null {
  const rows = cachedStatement(
    db,
    `
    SELECT id, ts FROM delivery_events
    WHERE tenant_id = ? AND session_id = ? AND event_type = ? AND turn_seq IS NOT NULL
    ORDER BY id
  `,
  ).all(input.tenantId, input.sessionId, input.eventType) as Array<{ id: number; ts: string }>;
  const at = Date.parse(input.ts);
  return rows.find((r) => Math.abs(Date.parse(r.ts) - at) <= DELIVERY_DUPLICATE_WINDOW_MS)?.id ?? null;
}

function findDuplicateToolFailure(db: DatabaseSyncLike, input: DeliveryEventInput): number | null {
  // Without a call id a time window would merge parallel failures, so two such fires stay two rows.
  if (input.toolUseId === undefined || input.toolUseId === null) return null;
  const row = cachedStatement(
    db,
    `
    SELECT id FROM delivery_events
    WHERE tenant_id = ? AND session_id = ? AND event_type = ? AND tool_use_id = ? AND turn_seq IS NOT NULL
    ORDER BY id LIMIT 1
  `,
  ).get(input.tenantId, input.sessionId, input.eventType, input.toolUseId) as { id: number } | undefined;
  return row?.id ?? null;
}

function findDuplicateTurn(db: DatabaseSyncLike, input: DeliveryEventInput): number | null {
  if (input.eventType === 'tool-failure') return findDuplicateToolFailure(db, input);
  // A boundary has no prompt, and two compactions of one session never start within the window, so time alone decides.
  if (isBoundaryEvent(input.eventType)) return findDuplicateBoundary(db, input);
  if (input.hostTurnId !== null) {
    const row = cachedStatement(
      db,
      `
      SELECT id FROM delivery_events
      WHERE tenant_id = ? AND session_id = ? AND event_type = ? AND host_turn_id = ? AND turn_seq IS NOT NULL
      ORDER BY id LIMIT 1
    `,
    ).get(input.tenantId, input.sessionId, input.eventType, input.hostTurnId) as { id: number } | undefined;
    return row?.id ?? null;
  }
  if (input.promptHash === null) return null;
  const rows = cachedStatement(
    db,
    `
    SELECT id, ts FROM delivery_events
    WHERE tenant_id = ? AND session_id = ? AND event_type = ? AND prompt_hash = ? AND host_turn_id IS NULL AND turn_seq
    IS NOT NULL
    ORDER BY id
  `,
  ).all(input.tenantId, input.sessionId, input.eventType, input.promptHash) as Array<{ id: number; ts: string }>;
  const at = Date.parse(input.ts);
  // Absolute difference: two hook processes can commit out of ts order.
  return rows.find((r) => Math.abs(Date.parse(r.ts) - at) <= DELIVERY_DUPLICATE_WINDOW_MS)?.id ?? null;
}

function nextTurnSeq(db: DatabaseSyncLike, input: DeliveryEventInput): number {
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  const row = cachedStatement(
    db,
    `
    SELECT MAX(turn_seq) AS m FROM delivery_events
    WHERE tenant_id = ? AND session_id = ? AND event_type = ? AND turn_seq IS NOT NULL
  `,
  ).get(input.tenantId, input.sessionId, input.eventType) as { m: number | null };
  return (row.m ?? 0) + 1;
}

function deliveryEventValues(input: DeliveryEventInput, turnSeq: number | null, duplicateOf: number | null) {
  return [
    input.ts,
    DELIVERY_LEDGER_VERSION,
    input.tenantId,
    input.runtime,
    input.eventType,
    input.surface,
    input.storeHash,
    input.writeStore,
    input.projectHash,
    input.sessionId,
    input.sessionState,
    input.hostTurnId,
    turnSeq,
    duplicateOf,
    input.promptHash,
    input.promptLength,
    input.queryHash,
    input.recallTraceId,
    input.blockState,
    input.promptRecall ? 1 : 0,
    input.consideredCount,
    input.filteredCount,
    input.selectedCount,
    input.emittedCount,
    input.rejectedCount,
    input.rejectedUnlisted,
    input.sectionsShown,
    input.sectionsDropped,
    input.budgetTokens,
    input.selectedTokens,
    input.injectedTokens,
    input.staticHash,
    input.recallHash,
    input.emittedHash,
    Math.round(input.elapsedMs),
    input.toolUseId ?? null,
    input.failureId ?? null,
  ];
}

const DELIVERY_CANDIDATE_COLUMNS = [
  'event_id',
  'tenant_id',
  'memory_id',
  'source_store',
  'pool',
  'stage',
  'outcome',
  'reason',
  'cand_rank',
  'score',
  'tokens',
] as const;

/** VALUES binds rather than one JSON array, since a score is a float that JSON text need not give back bit for bit. */
function insertDeliveryCandidates(db: DatabaseSyncLike, eventId: number, input: DeliveryEventInput): void {
  const width = DELIVERY_CANDIDATE_COLUMNS.length;
  const columns = DELIVERY_CANDIDATE_COLUMNS.join(', ');
  for (const chunk of chunked(input.candidates, rowsPerStatement(width))) {
    // Prepared per call: the last chunk's row count differs, so a cached text per count would crowd out hot ones.
    db.prepare(`INSERT INTO delivery_candidates (${columns}) VALUES ${valuesRows(chunk.length, width)}`).run(
      ...chunk.flatMap((c) => [
        eventId,
        input.tenantId,
        c.memoryId,
        c.sourceStore,
        c.pool,
        c.stage,
        c.outcome,
        c.reason,
        c.rank,
        c.score,
        c.tokens,
      ]),
    );
  }
}

/** How often a store prunes its delivery ledger: each prune scans for expired rows, so a busy server skips most. */
const DELIVERY_PRUNE_EVERY_MS = 60_000;

/** When a store last pruned its delivery ledger; each store holds its own, so the minute is counted per store. */
export interface DeliveryPruneSchedule {
  due(nowMs: number): boolean;
  pruned(nowMs: number): void;
}

/** A schedule that has never pruned, so its first write prunes. */
export function deliveryPruneSchedule(): DeliveryPruneSchedule {
  let last = Number.NEGATIVE_INFINITY;
  return {
    // A clock set back by a minute or more prunes too, rather than waiting out the gap.
    due: (nowMs) => Math.abs(nowMs - last) >= DELIVERY_PRUNE_EVERY_MS,
    pruned: (nowMs) => {
      last = nowMs;
    },
  };
}

function pruneDeliveryEvents(db: DatabaseSyncLike, eventTs: string, nowMs: number): void {
  const pruneFrom = Math.min(Date.parse(eventTs), nowMs);
  const cutoff = new Date(pruneFrom - DELIVERY_LEDGER_RETENTION_DAYS * DAY_MS).toISOString();
  cachedStatement(db, `DELETE FROM delivery_events WHERE ts < ?`).run(cutoff);
}

/** One event plus its candidates in one write transaction, then a prune when `prune` is due; fail-soft. The caller must
 * not hold a transaction on `db`. */
function writeDeliveryEvent(
  db: DatabaseSyncLike,
  input: DeliveryEventInput,
  prune: DeliveryPruneSchedule,
): number | null {
  try {
    const now = Date.now();
    const pruning = prune.due(now);
    const eventId = withWriteScope(db, 'write_delivery_event', () => {
      // Missing-session and sub-agent events are not turns of a session, so they get no number and no duplicate check.
      const isTurn = input.sessionId !== null && (input.sessionState === 'payload' || input.sessionState === 'env');
      const duplicateOf = isTurn ? findDuplicateTurn(db, input) : null;
      const turnSeq = isTurn && duplicateOf === null ? nextTurnSeq(db, input) : null;
      const values = deliveryEventValues(input, turnSeq, duplicateOf);
      const id = Number(
        cachedStatement(
          db,
          `
        INSERT INTO delivery_events (${DELIVERY_EVENT_COLUMNS.join(', ')})
        VALUES (${placeholders(DELIVERY_EVENT_COLUMNS.length)})
      `,
        ).run(...values).lastInsertRowid,
      );
      insertDeliveryCandidates(db, id, input);
      if (pruning) pruneDeliveryEvents(db, input.ts, now);
      return id;
    });
    // Only after the commit, so a rolled-back prune leaves the next write due.
    if (pruning) prune.pruned(now);
    return eventId;
  } catch (error) {
    log.error(`delivery ledger write failed: ${errorMessage(error)}`, errorFields(error));
    return null;
  }
}

/** Write on the request's handle, or a short-lived one, waiting at most {@link DELIVERY_LEDGER_WAIT_MS} for the lock.
 * Fail-soft. */
export function writeDeliveryEventVia(
  on: OnHandle,
  input: DeliveryEventInput,
  prune: DeliveryPruneSchedule,
): number | null {
  let writing = false;
  try {
    return on((db) => {
      writing = true;
      return writeDeliveryEventOnHandle(db, input, prune);
    });
  } catch (error) {
    if (writing) throw error;
    log.error(`delivery ledger write failed: ${errorMessage(error)}`, errorFields(error));
    return null;
  }
}

/** On a caller's open handle, which saves a second open and close per turn; the handle's own lock wait comes back
 * after. A caller holding only a handle gets a fresh schedule, so each of its writes prunes. */
export function writeDeliveryEventOnHandle(
  db: DatabaseSyncLike,
  input: DeliveryEventInput,
  prune: DeliveryPruneSchedule = deliveryPruneSchedule(),
): number | null {
  const prior = Math.trunc(Number((cachedStatement(db, 'PRAGMA busy_timeout').get() as { timeout: number }).timeout));
  db.exec(`PRAGMA busy_timeout = ${DELIVERY_LEDGER_WAIT_MS}`);
  try {
    return writeDeliveryEvent(db, input, prune);
  } finally {
    db.exec(`PRAGMA busy_timeout = ${prior}`);
  }
}
