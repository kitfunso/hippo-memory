// Reads of one memory by id, so a CLI verb asks the api instead of opening the store itself.
import type { MemoryEntry } from '../core/memory.js';
import { storeFor } from '../store/index.js';
import type { Context } from './types.js';

/** The row `id` in the caller's tenant, or null when it is missing or another tenant's. */
export async function getMemory(ctx: Context, id: string): Promise<MemoryEntry | null> {
  const [entry] = await storeFor(ctx).entriesByIds([id], ctx.tenantId);
  return entry ?? null;
}
