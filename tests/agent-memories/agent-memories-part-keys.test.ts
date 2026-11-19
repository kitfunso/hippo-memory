// The part keys of a long note: a text-keyed item's key holds a hash of its whole text, so a part
// key built from it would change with every edit.
import { describe, expect, it } from 'vitest';
import { itemHash, textItemKeys } from '../../src/domain/agent-memories/keys.js';
import { planContainer, type LiveRow, type PlanItem } from '../../src/domain/agent-memories/plan.js';
import { fileOfKey } from '../../src/domain/agent-memories/source.js';
import type { MemoryItem } from '../../src/domain/agent-memories/types.js';
import { container, partsOf } from '../_helpers/agent-memories-parts.js';

/** A text-keyed item as an adapter builds it: `<heading slug>/<12 hex of the whole text>`. */
const textKeyedItem = (text: string): MemoryItem => ({
  key: textItemKeys([{ headingSlug: 'user-profile', text }])[0],
  text,
  updatedAt: 0,
});

const checklist = (last: string): string =>
  [
    'User Profile: The release checklist, step by step:',
    ...Array.from({ length: 59 }, (_, i) => `  sub-line ${i}: the release checklist runs the smoke test first.`),
    `  ${last}`,
  ].join('\n');

describe('part keys of a text-keyed container', () => {
  const before = partsOf(container([textKeyedItem(checklist('END OF THE CHECKLIST'))], true));
  const after = partsOf(container([textKeyedItem(checklist('END OF THE NEW CHECKLIST'))], true));

  it('an edit to the last part leaves the keys of the other parts as they were', () => {
    expect(before).toHaveLength(3);
    expect(after).toHaveLength(3);
    expect(after[0].key).toBe(before[0].key);
    expect(after[1].key).toBe(before[1].key);
    expect(after[2].key).not.toBe(before[2].key);
  });

  it('every part of the note answers to the one note, edited or not', () => {
    const notes = new Set([...before, ...after].map((p) => fileOfKey(p.key)));
    expect(notes.size).toBe(1);
  });

  it('the plan keeps parts 1 and 2 and pairs the edited part with its old row', () => {
    const row = (p: MemoryItem, id: string): LiveRow => ({
      id,
      key: p.key,
      hash: itemHash(p.text),
      tagged: true,
      created: '2026-09-01T00:00:00.000Z',
    });
    const plan = planContainer({
      textKeyed: true,
      items: after.map((p): PlanItem => ({ key: p.key, hash: itemHash(p.text), refused: false })),
      skipped: [],
      live: before.map((p, i) => row(p, `r${i}`)),
      dormant: [],
      isDuplicate: () => false,
    });
    expect(plan.unchanged).toBe(2);
    expect(plan.setAside).toEqual([]);
    expect(plan.writes).toEqual([{ key: after[2].key, hash: itemHash(after[2].text), supersedes: ['r2'] }]);
  });

  it('two long items under one heading keep distinct part keys', () => {
    const keys = partsOf(
      container([textKeyedItem(checklist('END OF THE FIRST')), textKeyedItem(checklist('END OF THE SECOND'))], true),
    ).map((p) => p.key);
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(6);
  });
});

describe('part keys of a folder store', () => {
  it('a part keeps its file key before the mark', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Line ${i}: the cache lives on the D drive.`).join('\n\n');
    const parts = partsOf(container([{ key: 'sub/long.md', text, updatedAt: 0 }], false));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.key.startsWith('sub/long.md::top/')).toBe(true);
  });
});
