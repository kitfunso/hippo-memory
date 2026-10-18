// Reads the delivery ledger back for tests: the store only writes it, and the pilot's report reads it with its own SQL.
import type { DatabaseSyncLike } from '../../src/db/index.js';

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
  tool_use_id: string | null;
  failure_id: number | null;
  candidates: DeliveryCandidateRow[];
}

/** A session's delivery events in write order, each with its candidate rows; `sessionId` null reads session-less
 * events. Two queries, however many events. */
export function readDeliveryEvents(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string | null,
): DeliveryEventRow[] {
  // SAFETY: SELECT * over delivery_events returns exactly the columns DeliveryEventRow names, less `candidates`.
  const events = db
    .prepare(`SELECT * FROM delivery_events WHERE tenant_id = ? AND session_id IS ? ORDER BY id`)
    .all(tenantId, sessionId) as Array<Omit<DeliveryEventRow, 'candidates'>>;
  // SAFETY: SELECT c.* over delivery_candidates returns exactly the columns DeliveryCandidateRow names.
  const candidates = db
    .prepare(
      `SELECT c.* FROM delivery_candidates c JOIN delivery_events e ON e.id = c.event_id
       WHERE e.tenant_id = ? AND e.session_id IS ?
       ORDER BY c.event_id, c.outcome = 'rejected', c.cand_rank, c.memory_id`,
    )
    .all(tenantId, sessionId) as DeliveryCandidateRow[];
  const byEvent = new Map<number, DeliveryCandidateRow[]>();
  for (const c of candidates) byEvent.set(c.event_id, [...(byEvent.get(c.event_id) ?? []), c]);
  return events.map((e) => ({ ...e, candidates: byEvent.get(e.id) ?? [] }));
}
