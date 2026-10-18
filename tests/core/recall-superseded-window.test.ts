// Superseded rows must not use up the recall candidate window, and a superseded
// summary must never stand in for its children in recall overflow or assemble.
import type { FullContext } from '../_helpers/api-ctx.js';
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { Layer, type MemoryEntry } from '../../src/core/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { loadRecallSearchEntries } from '../../src/store/search-rows.js';
import { assemble, retrieve, supersede } from '../../src/api/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

const roots: string[] = [];

function newRoot(): string {
  const root = makeRoot('superseded-window');
  roots.push(root);
  return root;
}

const ctxFor = (hippoRoot: string): FullContext =>
  apiCtx(hippoRoot, 'default', { subject: 'superseded-window-test', role: 'admin' });

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function seedVersions(root: string, oldCreatedFirst: boolean) {
  const [early, late] = ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'];
  const current = { ...createMemory('deploy on friday'), created: oldCreatedFirst ? late : early };
  const old = {
    ...createMemory('deploy deploy deploy on monday'),
    created: oldCreatedFirst ? early : late,
    superseded_by: current.id,
  };
  writeEntry(root, current);
  writeEntry(root, old);
  return { current, old };
}

function summaryWithChildren(
  root: string,
  childText: string,
  leafOptions: Parameters<typeof createMemory>[1],
): MemoryEntry {
  const summary = createMemory('a rollup of three older rows', {
    layer: Layer.Semantic,
    confidence: 'inferred',
    dagLevel: 2,
    tags: ['dag-summary'],
  });
  writeEntry(root, summary);
  for (let i = 0; i < 3; i++) {
    const leaf = createMemory(`${childText} ${i}`, {
      ...leafOptions,
      layer: Layer.Buffer,
      dagLevel: 1,
      dagParentId: summary.id,
    });
    writeEntry(root, { ...leaf, created: `2026-01-1${i}T00:00:00.000Z` });
  }
  return summary;
}

const LOADER_PATHS: Array<[string, string, boolean]> = [
  ['FTS', 'deploy', false],
  ['LIKE', 'deplo', false],
  ['empty-query', '', true],
  ['no-match fallback', 'zebra', true],
];

describe('the recall candidate window drops superseded rows before its LIMIT', () => {
  it.each(LOADER_PATHS)('%s path', (_path, query, oldCreatedFirst) => {
    const root = newRoot();
    const { current, old } = seedVersions(root, oldCreatedFirst);
    const windowIds = (includeSuperseded: boolean): string[] =>
      loadRecallSearchEntries(root, query, 1, 'default', undefined, 'exact', includeSuperseded).map((e) => e.id);

    expect(windowIds(true)).toEqual([old.id]);
    expect(windowIds(false)).toEqual([current.id]);
  });

  it('api.recall finds the current version when an old one outranks it', async () => {
    const root = newRoot();
    const { current } = seedVersions(root, false);

    expect(
      (await retrieve(ctxFor(root), { query: 'deploy', window: { limit: 1, scorerWindow: 1 } })).results.map(
        (r) => r.id,
      ),
    ).toEqual([current.id]);
  });
});

describe('a superseded summary never stands in for its children', () => {
  it('in recall overflow', async () => {
    const root = newRoot();
    const summary = summaryWithChildren(root, 'invoice detail', {});
    const summaryIds = async (): Promise<string[]> =>
      (await retrieve(ctxFor(root), { query: 'invoice detail', window: { limit: 1 } })).results
        .filter((r) => r.isSummary)
        .map((r) => r.id);

    expect(await summaryIds()).toEqual([summary.id]);
    await supersede(ctxFor(root), summary.id, 'billing rollup, revised');
    expect(await summaryIds()).toEqual([]);
  });

  it('in assemble', async () => {
    const root = newRoot();
    const summary = summaryWithChildren(root, 'older detail', { kind: 'raw', sourceSessionId: 'sess-s' });
    const summaryIds = async (): Promise<string[]> =>
      (await assemble(ctxFor(root), 'sess-s', { freshTailCount: 1, budget: 100000 })).items
        .filter((it) => it.isSummary)
        .map((it) => it.id);

    expect(await summaryIds()).toEqual([summary.id]);
    await supersede(ctxFor(root), summary.id, 'session rollup, revised');
    expect(await summaryIds()).toEqual([]);
  });
});
