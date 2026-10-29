// A memory conflict as the store returns it, and the snake_case keys every file and wire format
// prints it with: `hippo conflicts --json` and the conflict markdown mirrors. The type renames its
// fields freely; these names stay.

/** A detected contradiction between two memories; the pair is stored with the smaller id as
 * `memoryAId`. */
export interface MemoryConflict {
  id: number;
  memoryAId: string;
  memoryBId: string;
  reason: string;
  score: number;
  status: string;
  detectedAt: string;
  updatedAt: string;
}

/** Keys in the order 2.x printed them, so `hippo conflicts --json` keeps its bytes. */
export function conflictToWire(c: MemoryConflict) {
  return {
    id: c.id,
    memory_a_id: c.memoryAId,
    memory_b_id: c.memoryBId,
    reason: c.reason,
    score: c.score,
    status: c.status,
    detected_at: c.detectedAt,
    updated_at: c.updatedAt,
  };
}

// SAFETY: a memory_conflicts row in hippo.db carries these keys; scripts/checks/check-row-casts.mjs
// proves each read cast to this type selects them.
export type ConflictWire = ReturnType<typeof conflictToWire>;
