// Pins exact scores, order and breakdowns for every ranking path in the search modules, so a structural move cannot shift a result.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, CHURN_STALE_TAG, type MemoryEntry } from '../src/memory.js';
import { saveEmbeddingIndex, saveStoredEmbeddingModel } from '../src/embeddings.js';
import { resolveEmbeddingProvider } from '../src/embedding-provider.js';
import { insertEntity, insertRelation } from '../src/graph.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { savePhysicsState } from '../src/physics-state.js';
import { search } from '../src/search/bm25-search.js';
import { hybridSearch } from '../src/search/hybrid.js';
import { physicsSearch } from '../src/search/physics-search.js';
import type { SearchResult } from '../src/search/types.js';
import type { RerankerFn } from '../src/rerankers/types.js';

const NOW = new Date('2026-09-01T12:00:00.000Z');
const TENANT = 'default';
const DAY = 86_400_000;

const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

function mk(id: string, content: string, ageDays: number, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const base = createMemory(content, { baseHalfLifeDays: 30, tenantId: TENANT });
  const t = ago(ageDays);
  return { ...base, id, created: t, last_retrieved: t, valid_from: t, ...extra };
}

const ENTRIES: MemoryEntry[] = [
  mk('d1', 'deploy pipeline uses blue green rollout', 2),
  mk('d2', 'deploy checklist says run migrations before every deploy', 10, { tags: ['decision'] }),
  mk('d3', 'rollback the deploy when health checks fail twice', 40, { outcome_positive: 3 }),
  mk('d4', 'pipeline caching speeds up the nightly builds', 1, { tags: [CHURN_STALE_TAG] }),
  mk('d5', 'deploy pipeline secrets live in the team vault', 5, { tags: ['scope:team-a'] }),
  mk('d6', 'deploy pipeline secrets live in the shared vault', 5, { tags: ['scope:team-b'], outcome_negative: 2 }),
  mk('d7', 'long thread: the deploy pipeline requires approval from ops before release', 12),
  mk('x1', 'deploy pipeline requires ops approval', 11, { tags: ['extracted'], extracted_from: 'd7', dag_level: 1 }),
  mk('s1', 'deploy pipeline summary topic', 3, { tags: ['dag-summary'], dag_level: 2, descendant_count: 2, last_rebuilt_at: ago(2), rebuild_count: 4 }),
  mk('c1', 'child note about the weekend freeze', 3, { dag_parent_id: 's1' }),
  mk('o1', 'old deploy pipeline used jenkins', 100, { superseded_by: 'n1' }),
  mk('n1', 'new deploy pipeline uses github actions', 20, { valid_from: ago(20) }),
  mk('z1', 'lunch menu on fridays has tacos', 4),
  mk('z2', 'ship to production with zero downtime', 6),
];

/** Query vector is [1,0,0]: z2 matches it exactly with no shared word, d1 and s1 sit close, noise is orthogonal. */
const VECTORS = {
  d1: [0.9, 0.1, 0], d2: [0.6, 0.8, 0], d3: [0.5, 0.5, 0.5], d4: [0.2, 0.9, 0.1], d5: [0.7, 0.7, 0],
  d6: [0.7, 0.69, 0.1], d7: [0.4, 0.4, 0.8], x1: [0.8, 0.2, 0.1], s1: [0.88, 0.12, 0], c1: [0.3, 0, 0.9],
  o1: [0.5, 0.1, 0.8], n1: [0.6, 0.3, 0.3], z1: [0, 0, 1], z2: [1, 0, 0],
} satisfies Record<string, number[]>;

/** Rows only the vector arm can add: in the store, absent from the caller's pool. */
const OUTSIDE: MemoryEntry[] = [
  mk('v1', 'release trains leave every tuesday morning', 7),
  mk('v2', 'canary hosts get the build first', 8),
];
const OUTSIDE_VECTORS = { v1: [0.99, 0.05, 0], v2: [0.95, 0.2, 0.1] } satisfies Record<string, number[]>;

type Pinned = Omit<SearchResult, 'entry' | 'rerankTrace'> & { id: string };

function pin(results: SearchResult[]): Pinned[] {
  return results.map(({ entry, rerankTrace: _t, ...rest }) => ({ id: entry.id, ...rest }));
}

const clone = (): MemoryEntry[] => ENTRIES.map((e) => ({ ...e, tags: [...e.tags] }));

describe('search ranking characterization: sync BM25 search', () => {
  const base = { now: NOW, budget: 100_000 };
  for (const q of ['deploy pipeline', 'latest deploy pipeline', 'first deploy', 'weekend freeze summary topic']) {
    it(`query "${q}"`, () => expect(pin(search(q, clone(), base))).toMatchSnapshot());
  }
  it('asOf before the successor took over', () => {
    expect(pin(search('deploy pipeline', clone(), { ...base, asOf: ago(50) }))).toMatchSnapshot();
  });
  it('includeSuperseded', () => {
    expect(pin(search('deploy pipeline', clone(), { ...base, includeSuperseded: true }))).toMatchSnapshot();
  });
  it('budget and minResults', () => {
    expect(pin(search('deploy pipeline', clone(), { now: NOW, budget: 20, minResults: 2 }))).toMatchSnapshot();
  });
});

describe('search ranking characterization: hybrid without vectors', () => {
  const base = { now: NOW, budget: 100_000, explain: true, scope: 'team-a' };
  it('explain breakdown with scope, outcome and summary boosts', async () => {
    expect(pin(await hybridSearch('deploy pipeline', clone(), base))).toMatchSnapshot();
  });
  it('temporal cue, per-call summary deboost, no freshness', async () => {
    const opts = { ...base, summaryDeboost: 0.5, summaryFreshness: false };
    expect(pin(await hybridSearch('latest deploy pipeline', clone(), opts))).toMatchSnapshot();
  });
  it('asOf and includeSuperseded', async () => {
    expect(pin(await hybridSearch('deploy pipeline', clone(), { ...base, asOf: ago(50) }))).toMatchSnapshot();
    expect(pin(await hybridSearch('deploy pipeline', clone(), { ...base, includeSuperseded: true }))).toMatchSnapshot();
  });
});

function seedStore(): string {
  const root = mkdtempSync(join(tmpdir(), 'hippo-rank-char-'));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: 'text-embedding-3-small' } }), 'utf8');
  initStore(root);
  for (const e of [...ENTRIES, ...OUTSIDE]) writeEntry(root, e);
  process.env.OPENAI_API_KEY = 'sk-test';
  saveEmbeddingIndex(root, { ...VECTORS, ...OUTSIDE_VECTORS });
  saveStoredEmbeddingModel(root, resolveEmbeddingProvider(root).id);
  const entity = (memoryId: string): number =>
    insertEntity(root, TENANT, { entityType: 'decision', name: memoryId.toUpperCase(), memoryId }).id;
  for (const [from, to] of [['z2', 'c1'], ['x1', 'd4'], ['d1', 'd3']]) {
    insertRelation(root, TENANT, { fromEntityId: entity(from), toEntityId: entity(to), relType: 'supersedes', memoryId: from });
  }
  const db = openHippoDb(root);
  try {
    savePhysicsState(db, (['d1', 'd2', 'd3', 's1', 'z2', 'n1'] as const).map((id, i) => ({
      memoryId: id, position: VECTORS[id], velocity: [0.01 * i, 0, 0], mass: 1 + i / 4, charge: 0, temperature: 0.5,
      lastSimulation: NOW.toISOString(),
    })));
  } finally {
    closeHippoDb(db);
  }
  return root;
}

describe('search ranking characterization: hybrid and physics with a store', () => {
  let root: string;

  beforeAll(() => {
    root = seedStore();
  });

  afterAll(() => {
    delete process.env.OPENAI_API_KEY;
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      // SAFETY: body is the OpenAI embeddings request the provider just serialised.
      const body = JSON.parse(init.body) as { input: string[] };
      return new Response(JSON.stringify({ data: body.input.map(() => ({ embedding: [1, 0, 0] })) }), { status: 200 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const opts = () => ({ now: NOW, budget: 100_000, hippoRoot: root, explain: true, scope: null });

  it('blend with MMR', async () => {
    expect(pin(await hybridSearch('deploy pipeline', clone(), opts()))).toMatchSnapshot();
  });
  it('blend without MMR, custom weight', async () => {
    expect(pin(await hybridSearch('deploy pipeline', clone(), { ...opts(), mmr: false, embeddingWeight: 0.3 }))).toMatchSnapshot();
  });
  it('rrf', async () => {
    expect(pin(await hybridSearch('deploy pipeline', clone(), { ...opts(), scoring: 'rrf' }))).toMatchSnapshot();
  });
  it('rrf with the graph stream', async () => {
    const graphStream = { weight: 0.5, tenantId: TENANT, seedCount: 3 };
    expect(pin(await hybridSearch('deploy pipeline', clone(), { ...opts(), scoring: 'rrf', graphStream }))).toMatchSnapshot();
  });
  it('reranker reverses the head', async () => {
    const reranker: RerankerFn = async (_q, items) =>
      [...items].reverse().map((r, i) => ({ ...r, rerankScore: i, preRerankRank: r.preRerankRank ?? 0, postRerankRank: i + 1 }));
    const res = await hybridSearch('deploy pipeline', clone(), { ...opts(), reranker, rerankerOptions: { topK: 3 } });
    expect(pin(res)).toMatchSnapshot();
  });
  it('vector candidates join the pool', async () => {
    const vectorCandidates = { tenantId: TENANT, includeSuperseded: false, limit: 5 };
    expect(pin(await hybridSearch('deploy pipeline', clone(), { ...opts(), vectorCandidates }))).toMatchSnapshot();
  });
  it('physics pool merged with the classic pool', async () => {
    const res = await physicsSearch('deploy pipeline', clone(), { ...opts(), queryEmbedding: [1, 0, 0] });
    expect(pin(res)).toMatchSnapshot();
  });
  it('physics with asOf, summary deboost and vector candidates', async () => {
    const vectorCandidates = { tenantId: TENANT, includeSuperseded: false, limit: 5 };
    const res = await physicsSearch('deploy pipeline', clone(), {
      ...opts(), asOf: ago(50), summaryDeboost: 0.6, vectorCandidates,
    });
    expect(pin(res)).toMatchSnapshot();
  });
  it('physics falls back to hybrid when no provider is available', async () => {
    delete process.env.OPENAI_API_KEY;
    expect(pin(await physicsSearch('deploy pipeline', clone(), opts()))).toMatchSnapshot();
  });
});
