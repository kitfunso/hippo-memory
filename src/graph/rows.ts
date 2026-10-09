import type { GraphQueueStatus, SourceKind, GraphQueueItem } from './types.js';

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

export interface QueueRow {
  id: number;
  tenant_id: string;
  memory_id: string;
  kind: string;
  status: string;
  enqueued_at: string;
  processed_at: string | null;
}

export function rowToQueueItem(row: QueueRow): GraphQueueItem {
  // SAFETY: kind/status are DB CHECK-constrained (see db.ts CREATE TABLE
  // graph_extraction_queue) to exactly the SourceKind/GraphQueueStatus enum
  // values, so the row's column values match those types.
  return {
    id: row.id,
    tenantId: row.tenant_id,
    memoryId: row.memory_id,
    kind: row.kind as SourceKind,
    status: row.status as GraphQueueStatus,
    enqueuedAt: row.enqueued_at,
    processedAt: row.processed_at,
  };
}

export const QUEUE_COLS = `id, tenant_id, memory_id, kind, status, enqueued_at, processed_at`;

// ---------------------------------------------------------------------------
// Guard helper: resolve a consolidated source memory or throw
// ---------------------------------------------------------------------------

export interface DbLike {
  prepare(sql: string): { get<T>(...params: unknown[]): T };
}
