// Sleep keeps a row tagged with a NO_MERGE_TAGS member as written: the merge pass and LLM extraction both read the set.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { consolidate } from '../src/consolidate/sleep.js';
import { Layer} from '../src/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { NO_MERGE_TAGS } from '../src/shared.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';

const PROBE = 'no-merge-probe';
const BASE = 'Fixed the server crash due to memory overflow in the worker process `pool.ts`';

let tmp: string;
let hippoRoot: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-no-merge-'));
  hippoRoot = path.join(tmp, '.hippo');
  initStore(hippoRoot);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function sleepOver(tags: string[]) {
  for (const content of [BASE, `${BASE} again today`, `${BASE} once more`]) {
    writeEntry(hippoRoot, createMemory(content, { layer: Layer.Episodic, tenantId: 'default', tags }));
  }
  return consolidate(hippoRoot, { dryRun: false, now: new Date() });
}

describe('NO_MERGE_TAGS', () => {
  it('holds extracted and session-digest', () => {
    expect([...NO_MERGE_TAGS]).toEqual(expect.arrayContaining(['extracted', 'session-digest']));
  });

  it('control: untagged rows are extraction candidates and merge', async () => {
    const result = await sleepOver([]);
    expect(result.extractionCandidates).toBe(3);
    expect(result.merged).toBeGreaterThan(0);
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
      expect(loadAllEntries(hippoRoot).filter((e) => e.layer === Layer.Semantic)).toEqual([]);
    } finally {
      if (probe) tags.delete(tag);
    }
  });
});
