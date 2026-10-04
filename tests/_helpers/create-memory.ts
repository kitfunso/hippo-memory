import { createMemory as createMemoryWithHalfLife, DEFAULT_HALF_LIFE_DAYS } from '../../src/memory.js';
import type { CreateMemoryOptions, MemoryEntry } from '../../src/memory.js';

// Tests that do not pin a half-life get the shipped default, as an untyped caller would.
export function createMemory(content: string, options: Partial<CreateMemoryOptions> = {}): MemoryEntry {
  return createMemoryWithHalfLife(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, ...options });
}
