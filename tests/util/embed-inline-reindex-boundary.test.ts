// A model change reindexes inline at 256 rows and leaves the rebuild to `hippo embed` at 257, on a real SQLite store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isJsonObject, type JsonValue } from '../../src/util/json.js';
import { batchWriteAndDelete } from '../../src/store/delete-and-batch.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../../src/core/memory.js';
import { embedMemory } from '../../src/search/embed-memories.js';
import { embeddingIndexIdentity } from '../../src/embeddings/index-identity.js';
import { saveStoredEmbeddingModel } from '../../src/store/vector-index.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { saveStoredVectors } from '../_helpers/root-forms.js';
import { handlesOf } from '../../src/store/open.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const KEY_ENV = 'OPENAI_API_KEY';
let root: string;

beforeEach(() => {
  root = makeRoot('inline-reindex');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: 'new-m' } }), 'utf8');
  vi.stubEnv(KEY_ENV, ['sk', 'test'].join('-'));
  vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
    // SAFETY: the stub only receives the embeddings request body, which is JSON.
    const body = JSON.parse(String(init?.body)) as JsonValue;
    const input = isJsonObject(body) && Array.isArray(body.input) ? body.input : [];
    return new Response(JSON.stringify({ data: input.map((_text, index) => ({ index, embedding: [1, 0] })) }));
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function seed(rows: number): MemoryEntry {
  // One transaction: a write per row timed out on the Windows runner at 257 rows.
  const entries = Array.from({ length: rows }, (_row, i) =>
    createMemory(`inline reindex boundary row ${i}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
  batchWriteAndDelete(root, entries, []);
  const last = entries[rows - 1]!;
  saveStoredVectors(root, [[last.id, [0, 1]]], embeddingIndexIdentity('old-m'));
  saveStoredEmbeddingModel(handlesOf(root).on, 'old-m');
  return last;
}

describe('inline reindex row cap', () => {
  it('rebuilds inline at 256 rows', async () => {
    await expect(embedMemory(sqliteSyncStore(root).localFiles, seed(256))).resolves.toBe('indexed');
  });

  it('leaves the rebuild to hippo embed at 257 rows', async () => {
    await expect(embedMemory(sqliteSyncStore(root).localFiles, seed(257))).resolves.toBe('failed');
  });
});
