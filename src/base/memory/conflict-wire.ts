// A memory conflict as the store returns it, and the snake_case keys every file and wire format prints it with:
// `hippo conflicts --json` and the conflict markdown mirrors. The type renames its fields freely; these names stay.

/** A detected contradiction between two memories; the pair is stored with the smaller id as `memoryAId`. */
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

/** A conflict as files and wire formats name it. */
export interface ConflictWire {
  id: number;
  memory_a_id: string;
  memory_b_id: string;
  reason: string;
  score: number;
  status: string;
  detected_at: string;
  updated_at: string;
}

/** Keys in the order 2.x printed them, so `hippo conflicts --json` keeps its bytes. */
export function conflictToWire(c: MemoryConflict): ConflictWire {
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
