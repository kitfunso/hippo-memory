// Superseded rows must not use up the recall candidate window, and a superseded
// summary must never stand in for its children in recall overflow or assemble.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';
import { initStore, writeEntry, loadRecallSearchEntries } from '../src/store.js';
import { assemble, recall, supersede, type Context } from '../src/api.js';

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hippo-superseded-window-'));
  roots.push(root);
  initStore(root);
  return root;
}

const ctxFor = (hippoRoot: string): Context =>
  ({ hippoRoot, tenantId: 'default', actor: { subject: 'superseded-window-test', role: 'admin' } });

afterEach(() => {
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function seedVersions(root: string, oldCreatedFirst: boolean) {
  const [early, late] = ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'];
  const current = { ...createMemory('deploy on friday'), created: oldCreatedFirst ? late : early };
  const old = { ...createMemory('deploy deploy deploy on monday'), created: oldCreatedFirst ? early : late, superseded_by: current.id };
  writeEntry(root, current);
  writeEntry(root, old);
  return { current, old };
}

function summaryWithChildren(root: string, childText: string, leafOptions: Parameters<typeof createMemory>[1]): MemoryEntry {
  const summary = createMemory('a rollup of three older rows', { layer: Layer.Semantic, confidence: 'inferred', dag_level: 2, tags: ['dag-summary'] });
  writeEntry(root, summary);
  for (let i = 0; i < 3; i++) {
    const leaf = createMemory(`${childText} ${i}`, { ...leafOptions, layer: Layer.Buffer, dag_level: 1, dag_parent_id: summary.id });
    writeEntry(root, { ...leaf, created: `2026-01-1${i}T00:00:00.000Z` });
  }
  return summary;
}

const LOADER_PATHS: Array<[string, string, boolean, boolean]> = [
  ['FTS', 'deploy', false, false],
  ['LIKE', 'deploy', false, true],
  ['empty-query', '', true, false],
  ['no-match fallback', 'zebra', true, false],
];

describe('the recall candidate window drops superseded rows before its LIMIT', () => {
  it.each(LOADER_PATHS)('%s path', (_path, query, oldCreatedFirst, forceLike) => {
    if (forceLike) vi.stubEnv('HIPPO_FORCE_LIKE_PATH', '1');
    const root = newRoot();
    const { current, old } = seedVersions(root, oldCreatedFirst);
    const windowIds = (includeSuperseded: boolean): string[] =>
      loadRecallSearchEntries(root, query, 1, 'default', undefined, 'exact', includeSuperseded).map((e) => e.id);

    expect(windowIds(true)).toEqual([old.id]);
    expect(windowIds(false)).toEqual([current.id]);
  });

  it('api.recall finds the current version when an old one outranks it', () => {
    const root = newRoot();
    const { current } = seedVersions(root, false);

    expect(recall(ctxFor(root), { query: 'deploy', limit: 1, scorerWindow: 1 }).results.map((r) => r.id)).toEqual([current.id]);
  });
});

describe('a superseded summary never stands in for its children', () => {
  it('in recall overflow', () => {
    const root = newRoot();
    const summary = summaryWithChildren(root, 'invoice detail', {});
    const summaryIds = (): string[] =>
      recall(ctxFor(root), { query: 'invoice detail', limit: 1 }).results.filter((r) => r.isSummary).map((r) => r.id);

    expect(summaryIds()).toEqual([summary.id]);
    supersede(ctxFor(root), summary.id, 'billing rollup, revised');
    expect(summaryIds()).toEqual([]);
  });

  it('in assemble', () => {
    const root = newRoot();
    const summary = summaryWithChildren(root, 'older detail', { kind: 'raw', source_session_id: 'sess-s' });
    const summaryIds = (): string[] =>
      assemble(ctxFor(root), 'sess-s', { freshTailCount: 1, budget: 100000 }).items.filter((it) => it.isSummary).map((it) => it.id);

    expect(summaryIds()).toEqual([summary.id]);
    supersede(ctxFor(root), summary.id, 'session rollup, revised');
    expect(summaryIds()).toEqual([]);
  });
});
