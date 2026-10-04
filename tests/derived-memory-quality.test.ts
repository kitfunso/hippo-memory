import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { consolidate } from '../src/consolidate/sleep.js';
import { storeExtractedFacts } from '../src/extract.js';
import { generateDagSummary } from '../src/dag.js';
import { Layer } from '../src/memory.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-derived-quality-'));
  initStore(root);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ replay: { count: 0 }, extraction: { enabled: false } }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('quality at automatic derivation boundaries', () => {
  it('keeps incomplete sources out of both merge and extraction without deleting them', async () => {
    const inputs = ['bump build 78 for codemagic deploy', 'bump build 79 for codemagic deploy'];
    for (const content of inputs) writeEntry(root, createMemory(content, { layer: Layer.Episodic }));
    const result = await consolidate(root);
    expect(result.merged).toBe(0);
    expect(result.extractionCandidates).toBe(0);
    expect(loadAllEntries(root).map((entry) => entry.content)).toEqual(inputs);
  });

  it('admits complete configuration lessons into consolidation', async () => {
    for (const content of [
      'Production migrations must exclude test schema setup because sorted filenames control application order.',
      'Production migrations must exclude test schema setup because deployment applies the sorted filenames in order.',
    ]) writeEntry(root, createMemory(content, { layer: Layer.Episodic }));
    const result = await consolidate(root);
    expect(result.merged).toBe(2);
    expect(result.extractionCandidates).toBe(2);
  });

  it('writes complete extracted facts while refusing returned fragments per fact', () => {
    const source = createMemory('A discussion about the production migration deployment ordering.');
    writeEntry(root, source);
    const facts = storeExtractedFacts(root, source, [
      { content: 'Found local migration files to be', tags: [], valence: 'neutral' },
      { content: 'Production migration files must exclude test schema setup because sorted filenames control application order.', tags: [], valence: 'neutral' },
      { content: 'succeeds (inserts or updates)', tags: [], valence: 'neutral' },
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toContain('must exclude test schema setup');
    expect(loadAllEntries(root)).toHaveLength(2);
  });

  it('refuses incomplete generated summary prose through the shared new/rebuild summary boundary', async () => {
    const errors: string[] = [];
    const result = await generateDagSummary('migration rules', ['a supported source lesson'], {
      apiKey: 'test', onError: (message) => errors.push(message),
      fetcher: async () => new Response(JSON.stringify({ content: [{ text: 'Found local migration files to be' }] }), { status: 200 }),
    });
    expect(result).toBeNull();
    expect(errors).toEqual([expect.stringContaining('summary quality refused')]);
  });
});
