import { beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { consolidate } from '../../src/index.js';
import { storeExtractedFacts } from '../../src/domain/learn/extract.js';
import { generateDagSummary } from '../../src/domain/consolidate/dag-summary.js';
import { Layer } from '../../src/base/memory/memory.js';
import { assessAutomaticMemory } from '../../src/base/memory/memory-quality.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const captured = { layer: Layer.Episodic, source: 'capture', confidence: 'observed' } as const;
let root: string;
beforeEach(() => {
  root = makeRoot('derived-quality');
  writeFileSync(join(root, 'config.json'), JSON.stringify({ replay: { count: 0 }, extraction: { enabled: false } }));
});

describe('quality at automatic derivation boundaries', () => {
  it('keeps incomplete sources out of both merge and extraction without deleting them', async () => {
    const inputs = ['bump build 78 for testflight deploy', 'bump build 79 for testflight deploy'];
    for (const content of inputs) writeEntry(root, createMemory(content, captured));
    const result = await consolidate(root);
    expect(result.merged).toBe(0);
    expect(result.extractionCandidates).toBe(0);
    expect(loadAllEntries(root, 'default').map((entry) => entry.content)).toEqual(inputs);
  });

  it("derives from a person's rows whatever the automatic check says of the text", async () => {
    for (const content of ['bump build 78 for testflight deploy', 'bump build 79 for testflight deploy']) {
      writeEntry(root, createMemory(content, { layer: Layer.Episodic }));
    }
    const result = await consolidate(root);
    expect(result.merged).toBe(2);
    expect(result.extractionCandidates).toBe(2);
  });

  it('admits complete configuration lessons into consolidation', async () => {
    for (const content of [
      'Production migrations must exclude test schema setup because sorted filenames control application order.',
      'Production migrations must exclude test schema setup because deployment applies the sorted filenames in order.',
    ]) {
      writeEntry(root, createMemory(content, captured));
    }
    const result = await consolidate(root);
    expect(result.merged).toBe(2);
    expect(result.extractionCandidates).toBe(2);
  });

  it('still derives from short memories the checks are only unsure about', async () => {
    const inputs = ['alice reviews every schema change', 'alice reviews every schema change now'];
    expect(inputs.map((content) => assessAutomaticMemory(content).accepted)).toEqual([false, false]);
    for (const content of inputs) writeEntry(root, createMemory(content, captured));
    const result = await consolidate(root);
    expect(result.merged).toBe(2);
    expect(result.extractionCandidates).toBe(2);
  });

  it('writes complete extracted facts while refusing returned fragments per fact', async () => {
    const source = createMemory('A discussion about the production migration deployment ordering.');
    writeEntry(root, source);
    const facts = await storeExtractedFacts(
      sqliteStore(root),
      source,
      [
        { content: 'Found local migration files to be', tags: [], valence: 'neutral' },
        {
          content:
            'Production migration files must exclude test schema setup because sorted filenames control application order.',
          tags: [],
          valence: 'neutral',
        },
        { content: 'succeeds (inserts or updates)', tags: [], valence: 'neutral' },
      ],
      DEFAULT_HALF_LIFE_DAYS,
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toContain('must exclude test schema setup');
    expect(loadAllEntries(root, 'default')).toHaveLength(2);
  });

  it('refuses incomplete generated summary prose through the shared new/rebuild summary boundary', async () => {
    const errors: string[] = [];
    const result = await generateDagSummary('migration rules', ['a supported source lesson'], {
      apiKey: 'test',
      onError: (message) => errors.push(message),
      fetcher: async () =>
        new Response(JSON.stringify({ content: [{ text: 'Found local migration files to be' }] }), { status: 200 }),
    });
    expect(result).toBeNull();
    expect(errors).toEqual([expect.stringContaining('summary quality refused')]);
  });
});
