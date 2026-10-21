// Sleep keeps a row tagged with a NO_MERGE_TAGS member as written: the merge pass and LLM extraction both read the set.
import { beforeEach, describe, expect, it } from 'vitest';
import { consolidate } from '../../src/index.js';
import { Layer } from '../../src/base/memory/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { NO_MERGE_TAGS } from '../../src/domain/sharing/share.js';
import { makeStore } from '../_helpers/make-root.js';
import { writeEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';
import { FIXED_NOW, pinClock } from '../_helpers/fixed-clock.js';

pinClock();

oneRequestPerTest();

const PROBE = 'no-merge-probe';
const BASE = 'Fixed the server crash due to memory overflow in the worker process `pool.ts`';

let hippoRoot: string;

beforeEach(() => {
  ({ root: hippoRoot } = makeStore('no-merge'));
});

async function sleepOver(tags: string[]) {
  for (const content of [BASE, `${BASE} again today`, `${BASE} once more`]) {
    writeEntry(hippoRoot, createMemory(content, { layer: Layer.Episodic, tenantId: 'default', tags }));
  }
  return consolidate(hippoRoot, { dryRun: false, now: FIXED_NOW });
}

describe('NO_MERGE_TAGS', () => {
  it('holds extracted and session-digest', () => {
    expect([...NO_MERGE_TAGS]).toEqual(expect.arrayContaining(['extracted', 'session-digest']));
  });

  it('control: untagged rows are extraction candidates and merge', async () => {
    const result = await sleepOver([]);
    expect(result.extractionCandidates).toBe(3);
    // Each pair overlaps well past the 0.35 Jaccard bar, so the first row's cluster takes all three.
    expect(result.merged).toBe(3);
  });

  it.each([...NO_MERGE_TAGS, PROBE])('a row tagged %s is neither sent to extraction nor merged', async (tag) => {
    // SAFETY: a tag added at run time proves both call sites read the set, not a copied list.
    const tags = NO_MERGE_TAGS as Set<string>;
    const probe = !tags.has(tag);
    if (probe) tags.add(tag);
    try {
      const result = await sleepOver([tag]);
      expect(result.extractionCandidates).toBe(0);
      expect(result.merged).toBe(0);
      expect(loadAllEntries(hippoRoot, 'default').filter((e) => e.layer === Layer.Semantic)).toEqual([]);
    } finally {
      if (probe) tags.delete(tag);
    }
  });
});
