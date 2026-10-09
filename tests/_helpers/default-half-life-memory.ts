import { DEFAULT_HALF_LIFE_DAYS, createMemory as createMemoryWithHalfLife, type CreateMemoryOptions, type MemoryEntry } from '../../src/core/memory.js';

/** createMemory for tests that do not care about the half-life: the compiled default stands in for the store config the writers pass. */
export function createMemory(content: string, options: Partial<CreateMemoryOptions> = {}): MemoryEntry {
  return createMemoryWithHalfLife(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, ...options });
}
