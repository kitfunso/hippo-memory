// The vector arm of hybrid recall applies tenant, scope and superseded rules before its top-k cut.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore } from '../src/store/open.js';
import { batchWriteAndDelete } from '../src/store/delete-and-batch.js';
import { loadVectorCandidateEntries, recallScopeFilter } from '../src/store/search-rows.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry, type CreateMemoryOptions } from '../src/memory.js';
import { saveEmbeddingIndex } from '../src/embeddings.js';

const QUERY = [1, 0, 0];
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-vec-filters-'));
  initStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function seed(rows: ReadonlyArray<{ content: string; vector: number[]; opts?: Partial<CreateMemoryOptions>; supersededBy?: string; origin?: string | null }>): MemoryEntry[] {
  const entries = rows.map((r) => {
    const entry = { ...createMemory(r.content, { tenantId: 'default', ...r.opts, baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), superseded_by: r.supersededBy ?? null };
    if ('origin' in r) entry.origin_project = r.origin;
    return entry;
  });
  batchWriteAndDelete(root, entries, []);
  saveEmbeddingIndex(root, Object.fromEntries(entries.map((e, i) => [e.id, rows[i]!.vector])));
  return entries;
}

const contents = (entries: readonly MemoryEntry[]): string[] => entries.map((e) => e.content);

describe('vector candidates', () => {
  it('never return another tenant\'s rows', async () => {
    seed([
      { content: 'ours', vector: [0.8, 0.2, 0] },
      { content: 'theirs', vector: QUERY, opts: { tenantId: 'other' } },
    ]);
    expect(contents(await loadVectorCandidateEntries(root, QUERY, { tenantId: 'default', includeSuperseded: false }))).toEqual(['ours']);
    expect(contents(await loadVectorCandidateEntries(root, QUERY, { tenantId: 'other', includeSuperseded: false }))).toEqual(['theirs']);
  });

  it('denied scopes nearer the query cannot push an admitted row out of the top k', async () => {
    const denied = Array.from({ length: 60 }, (_, i) => ({
      content: `denied ${i}`, vector: QUERY, opts: { scope: i % 2 === 0 ? 'slack:private:c9' : 'unknown:legacy' },
    }));
    seed([...denied, { content: 'admitted', vector: [0.5, 0.5, 0] }]);
    const spec = { tenantId: 'default', scope: recallScopeFilter(undefined, 'exact'), includeSuperseded: false, limit: 10 };
    expect(contents(await loadVectorCandidateEntries(root, QUERY, spec))).toEqual(['admitted']);
  });

  it('an additive request unlocks exactly the requested private scope', async () => {
    seed([
      { content: 'requested', vector: QUERY, opts: { scope: 'slack:private:c1' } },
      { content: 'other private', vector: QUERY, opts: { scope: 'slack:private:c2' } },
      { content: 'plain', vector: [0.5, 0.5, 0] },
    ]);
    const spec = { tenantId: 'default', scope: recallScopeFilter('slack:private:c1', 'additive'), includeSuperseded: false };
    expect(contents(await loadVectorCandidateEntries(root, QUERY, spec))).toEqual(['requested', 'plain']);
  });

  it('another project\'s nearer rows cannot push the caller\'s row out of the top k', async () => {
    seed([
      ...Array.from({ length: 20 }, (_, i) => ({ content: `beta ${i}`, vector: QUERY, origin: 'beta' })),
      { content: 'no project', vector: QUERY, origin: null },
      { content: 'acme', vector: [0.6, 0.8, 0], origin: 'acme' },
      { content: 'user-global', vector: [0.5, 0.5, 0], origin: '' },
    ]);
    const spec = { tenantId: 'default', scope: recallScopeFilter(undefined, 'exact'), includeSuperseded: false, limit: 5, origin: ['acme'] };
    expect(contents(await loadVectorCandidateEntries(root, QUERY, spec))).toEqual(['user-global', 'acme']);
    const unfiltered = { ...spec, origin: undefined };
    expect(contents(await loadVectorCandidateEntries(root, QUERY, unfiltered))).not.toContain('acme');
  });

  it('skip superseded rows unless asked for them, and return nearest first', async () => {
    seed([
      { content: 'old', vector: QUERY, supersededBy: 'mem_newer' },
      { content: 'near', vector: [0.9, 0.1, 0] },
      { content: 'far', vector: [0.1, 0.9, 0] },
    ]);
    expect(contents(await loadVectorCandidateEntries(root, QUERY, { tenantId: 'default', includeSuperseded: false }))).toEqual(['near', 'far']);
    expect(contents(await loadVectorCandidateEntries(root, QUERY, { tenantId: 'default', includeSuperseded: true }))).toEqual(['old', 'near', 'far']);
  });
});
