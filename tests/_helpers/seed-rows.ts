import type { MemoryEntry } from '../../src/base/memory/memory.js';
import { createMemory } from './default-half-life-memory.js';
import { writeEntry } from './root-forms.js';

/** `count` default-tenant rows whose text is `content(i)`, with `extra(i)` laid over each; not written anywhere. */
export function memoryRows(
  count: number,
  content: (i: number) => string,
  extra: (i: number) => Partial<MemoryEntry> = () => ({}),
): MemoryEntry[] {
  return Array.from({ length: count }, (_, i) => ({ ...createMemory(content(i)), ...extra(i) }));
}

/** `memoryRows`, written to the store at `root` one row at a time. */
export function seedRows(
  root: string,
  count: number,
  content: (i: number) => string,
  extra?: (i: number) => Partial<MemoryEntry>,
): MemoryEntry[] {
  const rows = memoryRows(count, content, extra);
  for (const row of rows) writeEntry(root, row);
  return rows;
}
