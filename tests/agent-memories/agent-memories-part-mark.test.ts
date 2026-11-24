import { describe, expect, it } from 'vitest';
import { planContainer, type LiveRow, type PlanItem } from '../../src/domain/agent-memories/plan.js';
import { fileOfKey, isPartKey } from '../../src/domain/agent-memories/source.js';
import { container, partsOf } from '../_helpers/agent-memories-parts.js';

const live = (id: string, key: string): LiveRow => ({
  id,
  key,
  hash: `h-${id}`,
  tagged: true,
  created: '2026-09-01T00:00:00.000Z',
});
const read = (key: string): PlanItem => ({ key, hash: `h-new-${key}`, refused: false });

describe('a file name that holds "::"', () => {
  it('is not a part key, and its file key is the whole name', () => {
    expect(isPartKey('foo::bar.md')).toBe(false);
    expect(fileOfKey('foo::bar.md')).toBe('foo::bar.md');
    expect(isPartKey('dir/foo::bar.md')).toBe(false);
    expect(fileOfKey('dir/foo::bar.md')).toBe('dir/foo::bar.md');
  });

  it('a real part key still parses, with its repeat suffix and a name that holds "::"', () => {
    expect(fileOfKey('n.md::top/aaaaaaaaaaaa')).toBe('n.md');
    expect(isPartKey('n.md::top/aaaaaaaaaaaa')).toBe(true);
    expect(fileOfKey('n.md::state/aaaaaaaaaaaa~3')).toBe('n.md');
    expect(isPartKey('n.md::state/aaaaaaaaaaaa~3')).toBe(true);
    expect(fileOfKey('a::b.md::h-0123abcd/0123456789ab')).toBe('a::b.md');
    expect(isPartKey('a::b.md::h-0123abcd/0123456789ab')).toBe(true);
  });

  it('a note over the cap splits into parts that all name the note', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Line ${i}: the cache lives on the D drive.`).join('\n\n');
    const parts = partsOf(container([{ key: 'a::b.md', text, updatedAt: 0 }], false));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(isPartKey(part.key)).toBe(true);
      expect(fileOfKey(part.key)).toBe('a::b.md');
    }
  });

  it('a whole note is never paired with another whole note as an edit', () => {
    const plan = planContainer({
      textKeyed: false,
      items: [read('foo::baz.md')],
      skipped: [],
      live: [live('g1', 'foo::bar.md')],
      dormant: [],
      isDuplicate: () => false,
    });
    expect(plan.setAside).toEqual(['g1']);
    expect(plan.writes).toEqual([{ key: 'foo::baz.md', hash: 'h-new-foo::baz.md', supersedes: [] }]);
  });

  it('a note that was not read keeps its row', () => {
    const plan = planContainer({
      textKeyed: false,
      items: [],
      skipped: ['foo::bar.md'],
      live: [live('g1', 'foo::bar.md')],
      dormant: [],
      isDuplicate: () => false,
    });
    expect(plan.setAside).toEqual([]);
  });
});
