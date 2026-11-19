// In-memory containers for the part-splitting tests: no disk, no store.
import { splitContainer } from '../../src/domain/agent-memories/note-parts.js';
import type { Container, MemoryItem } from '../../src/domain/agent-memories/types.js';

export const container = (items: readonly MemoryItem[], textKeyed: boolean): Container => ({
  scope: 'user',
  path: '/home/u/.codex/memories/memory_summary.md',
  readable: true,
  items,
  skipped: [],
  warnings: [],
  textKeyed,
});

/** What `splitContainer` leaves of a container: each note over the cap as its parts. */
export const partsOf = (c: Container): readonly MemoryItem[] => splitContainer(c).items;
