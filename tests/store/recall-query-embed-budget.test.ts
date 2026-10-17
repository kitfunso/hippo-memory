// A recall waits a bounded time for its query vector: a stalled API provider costs one budget, then BM25 ranks alone and one line says why.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeEntry } from '../../src/store/entry-writes.js';
import { loadAllEntries } from '../../src/store/entry-reads.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../../src/core/memory.js';
import { saveStoredEmbeddingModel } from '../../src/store/embeddings/index.js';
import { embedMemory } from '../../src/search/embed-memories.js';
import { loadEmbeddingIndex, saveEmbeddingIndex } from '../../src/store/vector-index.js';
import { resolveEmbeddingProvider, type EmbeddingProvider } from '../../src/embeddings/provider.js';
import { retrieve } from '../../src/api/index.js';
import { physicsSearch } from '../../src/entry/folder-search.js';
import { embedQueryBy } from '../../src/search/vector.js';
import { searchBothHybrid } from '../../src/sharing/search-both.js';
import { _resetLogOnceForTests } from '../../src/util/log.js';
import { hashedVector, startHashedEmbeddings, type HashedEmbeddings } from '../_helpers/hashed-embedding-server.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { loadConfig } from '../../src/core/config.js';
import { sharingStores } from '../_helpers/sharing-stores.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';

const TENANT = 'default';
const QUERY = 'deploy';
const BUDGET_MS = 300;
const LEXICAL = 'deploy pipeline uses blue green rollout';
// Shares no word with the query, so only the vector arm can return it.
const VECTOR_ONLY = 'ship to production with zero downtime';

let embeddings: HashedEmbeddings;
let stderr: MockInstance<typeof process.stderr.write>;
const dirs: string[] = [];

function seedStore(): string {
  const root = makeRoot('query-embed-budget');
  dirs.push(root);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: 'hashed-16', apiBaseUrl: embeddings.url } }));
  const index: Record<string, number[]> = {};
  for (const [content, vector] of [[LEXICAL, hashedVector(LEXICAL)], [VECTOR_ONLY, hashedVector(QUERY)]] as const) {
    const entry = createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: TENANT });
    writeEntry(root, entry);
    index[entry.id] = vector;
  }
  saveEmbeddingIndex(root, index);
  saveStoredEmbeddingModel(root, resolveEmbeddingProvider(loadConfig(root).embeddings).id);
  return root;
}

async function recall(root: string): Promise<string[]> {
  const reply = await retrieve(apiCtx(root, TENANT, { subject: 'cli', role: 'admin' }), { query: QUERY, mode: 'hybrid', window: { limit: 20 } });
  return reply.results.map((r) => r.content);
}

const fallbackLines = (): string[] => stderr.mock.calls.map((c) => String(c[0])).filter((line) => line.includes('fell back to BM25'));

beforeAll(async () => {
  embeddings = await startHashedEmbeddings();
});

afterAll(async () => {
  await embeddings.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret');
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  _resetLogOnceForTests();
});

afterEach(() => {
  embeddings.setStatus(200);
  embeddings.setFault(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("a recall's query embedding", () => {
  it('ranks with vectors when the provider answers in time', async () => {
    const root = seedStore();
    const before = embeddings.requests();

    expect(await recall(root)).toEqual(expect.arrayContaining([LEXICAL, VECTOR_ONLY]));
    expect(embeddings.requests() - before).toBe(1);
    expect(fallbackLines()).toEqual([]);
  });

  it('falls back to BM25 within the budget when the provider never answers, and says so once', async () => {
    const root = seedStore();
    vi.stubEnv('HIPPO_QUERY_EMBED_TIMEOUT_MS', String(BUDGET_MS));
    embeddings.setFault('stall');

    const before = embeddings.requests();

    // The provider never answers, so a recall that returns at all returned at its deadline.
    const shown = await recall(root);
    const sent = embeddings.requests() - before;
    await recall(root);

    expect(shown).toEqual([LEXICAL]);
    expect(sent).toBe(1);
    expect(fallbackLines()).toHaveLength(1);
    expect(fallbackLines()[0]).toMatch(new RegExp(`^\\[hippo\\] warn: .*the openai embedding provider gave no query vector within ${BUDGET_MS} ms`));
    expect(fallbackLines()[0]).not.toContain(QUERY);
  });

  it('falls back to BM25 with one warning when the provider answers 503 on every attempt', async () => {
    const root = seedStore();
    embeddings.setStatus(503);
    const before = embeddings.requests();

    expect(await recall(root)).toEqual([LEXICAL]);
    await recall(root);

    expect(embeddings.requests() - before).toBe(6);
    expect(fallbackLines()).toHaveLength(1);
    expect(fallbackLines()[0]).toMatch(/^\[hippo\] warn: .*openai embeddings HTTP 503/);
  });

  it('ends within the budget when it runs out during the wait a 503 asked for', async () => {
    const root = seedStore();
    vi.stubEnv('HIPPO_QUERY_EMBED_TIMEOUT_MS', String(BUDGET_MS));
    // Two seconds is the longest wait the provider accepts under a deadline, far past the budget.
    embeddings.setStatus(503, 2);
    const before = embeddings.requests();
    const fetched = vi.spyOn(globalThis, 'fetch');

    const shown = await recall(root);

    expect(shown).toEqual([LEXICAL]);
    // A wait that outlasted the deadline would go on to a second attempt, which the dead signal ends before it reaches the server.
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(embeddings.requests() - before).toBe(1);
    expect(fallbackLines()).toHaveLength(1);
    expect(fallbackLines()[0]).toContain(`the openai embedding provider gave no query vector within ${BUDGET_MS} ms`);
  });

  it('sends the request again after a dropped connection, and ranks with vectors', async () => {
    const root = seedStore();
    embeddings.setFault('reset');
    const before = embeddings.requests();

    expect(await recall(root)).toEqual(expect.arrayContaining([LEXICAL, VECTOR_ONLY]));
    expect(embeddings.requests() - before).toBe(2);
    expect(fallbackLines()).toEqual([]);
  });

  it('spends one budget, not two, when physics search hands a stalled query to hybrid search', async () => {
    const root = seedStore();
    vi.stubEnv('HIPPO_QUERY_EMBED_TIMEOUT_MS', String(BUDGET_MS));
    embeddings.setFault('stall');
    const before = embeddings.requests();

    const ranked = await physicsSearch(QUERY, loadAllEntries(root, 'default'), { hippoRoot: root, budget: 1_000_000 });

    expect(ranked.map((r) => r.entry.content)).toEqual([LEXICAL]);
    expect(embeddings.requests() - before).toBe(1);
    expect(fallbackLines()).toHaveLength(1);
  });

  it('spends one budget, not two, across the local and the global store', async () => {
    const local = seedStore();
    const global = seedStore();
    vi.stubEnv('HIPPO_QUERY_EMBED_TIMEOUT_MS', String(BUDGET_MS));
    embeddings.setFault('stall');
    const before = embeddings.requests();

    const ranked = await searchBothHybrid(QUERY, ...sharingStores(local, global), { budget: 1_000_000, tenantId: TENANT, recallScope: {}, scope: null });

    expect([...new Set(ranked.map((r) => r.entry.content))]).toEqual([LEXICAL]);
    expect(embeddings.requests() - before).toBe(1);
  });

  it('hands an API provider the deadline as its abort signal, and reads the abort as no vector', async () => {
    const deadline = AbortSignal.timeout(20);
    const given: (AbortSignal | undefined)[] = [];
    const untilAbort = new Promise<number[][]>((_resolve, reject) => deadline.addEventListener('abort', () => reject(deadline.reason)));
    const api: EmbeddingProvider = {
      kind: 'openai', model: 'stub', id: 'openai:stub', isAvailable: () => true,
      embed: (_texts, _role, call) => { given.push(call?.signal); return untilAbort; },
    };

    expect(await embedQueryBy(deadline, api, QUERY)).toBeNull();
    expect(given).toEqual([deadline]);
  });

  it('keeps a vector that arrives after the deadline, as a loaded in-process model gives one', async () => {
    const local: EmbeddingProvider = { kind: 'local', model: 'in-process', id: 'in-process', isAvailable: () => true, embed: async () => [[1, 0]] };

    expect(await embedQueryBy(AbortSignal.abort(), local, QUERY)).toEqual([1, 0]);
  });
});

describe('the write-side embedding', () => {
  it('keeps its own long timeout: a provider slower than the recall budget still gets the memory embedded', async () => {
    const root = seedStore();
    vi.stubEnv('HIPPO_QUERY_EMBED_TIMEOUT_MS', '50');
    embeddings.setFault(250);
    const entry: MemoryEntry = createMemory('the release train leaves on tuesdays', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: TENANT });
    writeEntry(root, entry);

    await embedMemory(sqliteSyncStore(root).localFiles, entry);

    expect(loadEmbeddingIndex(root)[entry.id]).toHaveLength(16);
    expect(await recall(root)).not.toContain(VECTOR_ONLY);
  });
});
