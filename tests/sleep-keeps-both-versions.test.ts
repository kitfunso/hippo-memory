// Sleep keeps every stored version of a fact until one is retired: merge and dedup never drop a value's text.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory, Layer } from '../src/memory.js';
import { initStore, writeEntry, loadAllEntries, readEntry } from '../src/store.js';
import { consolidate } from '../src/consolidate.js';
import { deduplicateStore } from '../src/dedupe.js';

const DAY = 86_400_000;
const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hippo-keep-both-'));
  roots.push(root);
  initStore(root);
  // Replay would refresh the sources whose fade these tests watch.
  writeFileSync(join(root, 'config.json'), JSON.stringify({ replay: { count: 0 } }), 'utf8');
  return root;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// The merge and dedup phases of api.sleep, run daily for a week and once more after demoted sources have faded.
async function sleepMany(root: string): Promise<void> {
  const start = Date.now();
  for (const day of [1, 2, 3, 4, 5, 6, 7, 600]) {
    await consolidate(root, { now: new Date(start + day * DAY) });
    deduplicateStore(root);
  }
}

const activeText = (root: string): string => loadAllEntries(root).map((e) => e.content).join('\n');

describe('sleep keeps both versions', () => {
  it('a look-alike pair keeps both facts across several sleeps', async () => {
    const root = newRoot();
    const facts = ['The staging service listens on port 4400.', 'The analytics service listens on port 7700.'];
    for (const text of facts) writeEntry(root, createMemory(text, { layer: Layer.Episodic }));

    await sleepMany(root);

    for (const text of facts) expect(activeText(root)).toContain(text);
  });

  it('a correction pair keeps the current value', async () => {
    const root = newRoot();
    const corrections = [
      // The old text is longer, so a merge that kept only the longest text kept the old value.
      ['The web app dev server runs on port 3000 for local development work.', 'The web app dev server now runs on port 5173.'],
      // Same wording, so dedup saw a duplicate and kept the old value by content order.
      ['The public API rate limit is 100 requests', 'The public API rate limit is 250 requests'],
    ];
    for (const text of corrections.flat()) writeEntry(root, createMemory(text, { layer: Layer.Episodic }));

    await sleepMany(root);

    for (const [, current] of corrections) expect(activeText(root)).toContain(current);
  });

  it('repeated sleeps do not re-merge or re-fade the same sources', async () => {
    const root = newRoot();
    const a = createMemory('The staging service listens on port 4400.', { layer: Layer.Episodic });
    const b = createMemory('The analytics service listens on port 7700.', { layer: Layer.Episodic });
    writeEntry(root, a);
    writeEntry(root, b);
    const start = Date.now();

    expect((await consolidate(root, { now: new Date(start + DAY) })).semanticCreated).toBe(1);
    const derived = loadAllEntries(root).filter((e) => e.layer === Layer.Semantic);
    expect(derived).toHaveLength(1);
    expect([...derived[0].parents].sort()).toEqual([a.id, b.id].sort());
    const demoted = readEntry(root, a.id)!.half_life_days;
    expect(demoted).toBeLessThan(a.half_life_days);

    for (const day of [2, 3]) {
      const again = await consolidate(root, { now: new Date(start + day * DAY) });
      expect(again.merged).toBe(0);
      expect(again.semanticCreated).toBe(0);
    }
    expect(readEntry(root, a.id)!.half_life_days).toBe(demoted);
    expect(readEntry(root, b.id)!.half_life_days).toBe(demoted);
    expect(loadAllEntries(root).filter((e) => e.layer === Layer.Semantic)).toHaveLength(1);
  });

  it('dedup keeps a pair whose text differs in a value', () => {
    const root = newRoot();
    const pairs = [
      ['The dev server port is 3000', 'The dev server port is 5173'],
      // The overlap tokenizer drops 1-char tokens, so these two score as identical.
      ['Retry the flaky upload step 3 times', 'Retry the flaky upload step 5 times'],
      ['The team uses npm to install packages in the monorepo', 'The team uses pnpm to install packages in the monorepo'],
    ];
    for (const text of pairs.flat()) writeEntry(root, createMemory(text));

    expect(deduplicateStore(root).removed).toBe(0);
    expect(loadAllEntries(root)).toHaveLength(6);
  });
});
