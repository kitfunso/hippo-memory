// The order and the boosts of every ranking path in the search modules over one fixed pool. Scores are held to their
// sign and their order, never to a float, so a change to a weight moves an order before it moves a test.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemory, CHURN_STALE_TAG, type MemoryEntry } from '../../src/core/memory.js';
import { saveStoredEmbeddingModel } from '../../src/store/sqlite/vector-index.js';
import { resolveEmbeddingProvider } from '../../src/embeddings/provider.js';
import { insertEntityAt, insertRelationAt } from '../_helpers/graph-seed.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { savePhysicsState } from '../../src/db/physics-state.js';
import { search } from '../../src/search/bm25-search.js';
import { hybridSearch, physicsSearch } from '../../src/entry/folder-search.js';
import type { ScoreBreakdown, SearchResult } from '../../src/core/search-types.js';
import type { RerankerFn } from '../../src/rerankers/types.js';
import { loadConfig } from '../../src/core/config.js';
import { makeRoot } from '../_helpers/make-root.js';
import { saveEmbeddingIndex, writeEntry } from '../_helpers/root-forms.js';
import { handlesOf } from '../../src/store/sqlite/handles.js';
import { initTestStore } from '../_helpers/store-template.js';

afterAll(() => {
  vi.unstubAllEnvs();
});

const NOW = new Date('2026-09-01T12:00:00.000Z');
const TENANT = 'default';
const DAY = 86_400_000;

const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

function mk(id: string, content: string, ageDays: number, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const base = createMemory(content, { baseHalfLifeDays: 30, tenantId: TENANT });
  const t = ago(ageDays);
  return { ...base, id, created: t, lastRetrieved: t, validFrom: t, ...extra };
}

const ENTRIES: MemoryEntry[] = [
  mk('d1', 'deploy pipeline uses blue green rollout', 2),
  mk('d2', 'deploy checklist says run migrations before every deploy', 10, { tags: ['decision'] }),
  mk('d3', 'rollback the deploy when health checks fail twice', 40, { outcomePositive: 3 }),
  mk('d4', 'pipeline caching speeds up the nightly builds', 1, { tags: [CHURN_STALE_TAG] }),
  mk('d5', 'deploy pipeline secrets live in the team vault', 5, { tags: ['scope:team-a'] }),
  mk('d6', 'deploy pipeline secrets live in the shared vault', 5, { tags: ['scope:team-b'], outcomeNegative: 2 }),
  mk('d7', 'long thread: the deploy pipeline requires approval from ops before release', 12),
  mk('x1', 'deploy pipeline requires ops approval', 11, { tags: ['extracted'], extractedFrom: 'd7', dagLevel: 1 }),
  mk('s1', 'deploy pipeline summary topic', 3, {
    tags: ['dag-summary'],
    dagLevel: 2,
    descendantCount: 2,
    lastRebuiltAt: ago(2),
    rebuildCount: 4,
  }),
  mk('c1', 'child note about the weekend freeze', 3, { dagParentId: 's1' }),
  mk('o1', 'old deploy pipeline used jenkins', 100, { supersededBy: 'n1' }),
  mk('n1', 'new deploy pipeline uses github actions', 20, { validFrom: ago(20) }),
  mk('z1', 'lunch menu on fridays has tacos', 4),
  mk('z2', 'ship to production with zero downtime', 6),
];

/** Query vector is [1,0,0]: z2 matches it exactly with no shared word, d1 and s1 sit close, noise is orthogonal. */
const VECTORS = {
  d1: [0.9, 0.1, 0],
  d2: [0.6, 0.8, 0],
  d3: [0.5, 0.5, 0.5],
  d4: [0.2, 0.9, 0.1],
  d5: [0.7, 0.7, 0],
  d6: [0.7, 0.69, 0.1],
  d7: [0.4, 0.4, 0.8],
  x1: [0.8, 0.2, 0.1],
  s1: [0.88, 0.12, 0],
  c1: [0.3, 0, 0.9],
  o1: [0.5, 0.1, 0.8],
  n1: [0.6, 0.3, 0.3],
  z1: [0, 0, 1],
  z2: [1, 0, 0],
} satisfies Record<string, number[]>;

/** Rows only the vector arm can add: in the store, absent from the caller's pool. */
const OUTSIDE: MemoryEntry[] = [
  mk('v1', 'release trains leave every tuesday morning', 7),
  mk('v2', 'canary hosts get the build first', 8),
];
const OUTSIDE_VECTORS = { v1: [0.99, 0.05, 0], v2: [0.95, 0.2, 0.1] } satisfies Record<string, number[]>;

const clone = (): MemoryEntry[] => ENTRIES.map((e) => ({ ...e, tags: [...e.tags] }));
const ids = (results: readonly SearchResult[]): string[] => results.map((r) => r.entry.id);

/** The order, every score above zero, and, unless a re-rank ran after scoring, scores that never rise down the list. */
function expectRanked(results: readonly SearchResult[], order: readonly string[], sorted = true): void {
  expect(ids(results)).toEqual(order);
  for (const r of results) expect(r.score, r.entry.id).toBeGreaterThan(0);
  if (!sorted) return;
  for (let i = 1; i < results.length; i++) expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
}

function breakdownOf(results: readonly SearchResult[], id: string): ScoreBreakdown {
  const found = results.find((r) => r.entry.id === id)?.breakdown;
  expect(found, `${id} has a breakdown`).toBeDefined();
  return found!;
}

describe('sync BM25 search', () => {
  const base = { now: NOW, budget: 100_000 };

  it('ranks by matched terms, adds a summary child with no shared word, and drops the superseded row', () => {
    const res = search('deploy pipeline', clone(), base);
    expectRanked(res, ['x1', 'd1', 's1', 'c1', 'n1', 'd5', 'd2', 'd6', 'd3', 'd4']);
    expect(res.find((r) => r.entry.id === 'c1')!.bm25).toBe(0);
  });

  it('a temporal cue lifts the newer rows', () => {
    expectRanked(search('latest deploy pipeline', clone(), base), [
      'x1',
      'd1',
      's1',
      'c1',
      'd5',
      'n1',
      'd2',
      'd6',
      'd4',
      'd3',
    ]);
    expectRanked(search('first deploy', clone(), base), ['d2', 'x1', 'd1', 's1', 'n1', 'c1', 'd3', 'd5', 'd6']);
  });

  it('a query that names the summary and its child returns the summary first', () => {
    expectRanked(search('weekend freeze summary topic', clone(), base), ['s1', 'c1']);
  });

  it('asOf before the successor took over returns the old row alone', () => {
    expectRanked(search('deploy pipeline', clone(), { ...base, asOf: ago(50) }), ['o1']);
  });

  it('includeSuperseded keeps the old row in the list', () => {
    expectRanked(search('deploy pipeline', clone(), { ...base, includeSuperseded: true }), [
      'x1',
      'd1',
      's1',
      'c1',
      'n1',
      'd5',
      'd2',
      'o1',
      'd6',
      'd3',
      'd4',
    ]);
  });

  it('a small budget still returns minResults rows', () => {
    expectRanked(search('deploy pipeline', clone(), { now: NOW, budget: 20, minResults: 2 }), ['x1', 'd1']);
  });
});

describe('hybrid without vectors', () => {
  const base = { now: NOW, budget: 100_000, explain: true, scope: 'team-a' };

  it('the breakdown shows the scope, outcome, decision, churn and summary multipliers', async () => {
    const res = await hybridSearch('deploy pipeline', clone(), base);
    expectRanked(res, ['d5', 'x1', 'd1', 's1', 'c1', 'n1', 'd2', 'd3', 'd4', 'd6']);
    expect(breakdownOf(res, 'x1').mode).toBe('bm25-only');
    expect(breakdownOf(res, 'd5').scopeBoost).toBe(1.5);
    expect(breakdownOf(res, 'd6').scopeBoost).toBe(0.5);
    expect(breakdownOf(res, 'd3').outcomeBoost).toBeGreaterThan(1);
    expect(breakdownOf(res, 'd6').outcomeBoost).toBeLessThan(1);
    expect(breakdownOf(res, 'd2').decisionBoost).toBe(1.2);
    expect(breakdownOf(res, 'd4').churnStaleMultiplier).toBeLessThan(1);
    expect(breakdownOf(res, 's1')).toMatchObject({ summaryDeboost: 0.85, descendantCount: 2, rebuildCount: 4 });
    expect(breakdownOf(res, 's1').summaryFreshnessBoost).toBeGreaterThan(1);
    expect(res.find((r) => r.entry.id === 'c1')!.breakdown).toBeUndefined();
  });

  it('a per-call summary deboost replaces the default and no freshness leaves the boost at 1', async () => {
    const res = await hybridSearch('latest deploy pipeline', clone(), {
      ...base,
      summaryDeboost: 0.5,
      summaryFreshness: false,
    });
    expectRanked(res, ['d5', 'x1', 'd1', 'n1', 'd2', 's1', 'c1', 'd4', 'd6', 'd3']);
    expect(breakdownOf(res, 's1')).toMatchObject({ summaryDeboost: 0.5, summaryFreshnessBoost: 1 });
  });

  it('asOf returns the old row alone; includeSuperseded ranks it among the rest', async () => {
    expectRanked(await hybridSearch('deploy pipeline', clone(), { ...base, asOf: ago(50) }), ['o1']);
    expectRanked(await hybridSearch('deploy pipeline', clone(), { ...base, includeSuperseded: true }), [
      'd5',
      'x1',
      'd1',
      's1',
      'c1',
      'n1',
      'd2',
      'o1',
      'd3',
      'd4',
      'd6',
    ]);
  });
});

function seedStore(): string {
  const root = makeRoot('rank-order', { init: false });
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({ embeddings: { provider: 'openai', model: 'text-embedding-3-small' } }),
    'utf8',
  );
  initTestStore(root);
  for (const e of [...ENTRIES, ...OUTSIDE]) writeEntry(root, e);
  vi.stubEnv('OPENAI_API_KEY', 'sk-test');
  saveEmbeddingIndex(root, { ...VECTORS, ...OUTSIDE_VECTORS });
  saveStoredEmbeddingModel(handlesOf(root).on, resolveEmbeddingProvider(loadConfig(root).embeddings).id);
  const entity = (memoryId: string): number =>
    insertEntityAt(root, TENANT, { entityType: 'decision', name: memoryId.toUpperCase(), memoryId }).id;
  for (const [from, to] of [
    ['z2', 'c1'],
    ['x1', 'd4'],
    ['d1', 'd3'],
  ]) {
    insertRelationAt(root, TENANT, {
      fromEntityId: entity(from),
      toEntityId: entity(to),
      relType: 'supersedes',
      memoryId: from,
    });
  }
  const db = openHippoDb(root);
  try {
    savePhysicsState(
      db,
      (['d1', 'd2', 'd3', 's1', 'z2', 'n1'] as const).map((id, i) => ({
        memoryId: id,
        position: VECTORS[id],
        velocity: [0.01 * i, 0, 0],
        mass: 1 + i / 4,
        charge: 0,
        temperature: 0.5,
        lastSimulation: NOW.toISOString(),
      })),
    );
  } finally {
    closeHippoDb(db);
  }
  return root;
}

/** The blend's order with MMR on: d6, a near copy of d5, sits below d3 although it scores higher. */
const BLEND = ['x1', 'd1', 's1', 'd5', 'n1', 'd2', 'z2', 'd3', 'd6', 'c1', 'd4'];

describe('hybrid and physics with a store', () => {
  let root: string;

  beforeAll(() => {
    root = seedStore();
  });

  afterAll(() => {
    vi.stubEnv('OPENAI_API_KEY', undefined);
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        // SAFETY: body is the OpenAI embeddings request the provider just serialised.
        const body = JSON.parse(init.body) as { input: string[] };
        return new Response(JSON.stringify({ data: body.input.map(() => ({ embedding: [1, 0, 0] })) }), {
          status: 200,
        });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const opts = () => ({ now: NOW, budget: 100_000, hippoRoot: root, explain: true, scope: null });
  const score = (results: readonly SearchResult[], id: string): number => results.find((r) => r.entry.id === id)!.score;

  it('the blend adds a vector-only row, and MMR moves a near copy down', async () => {
    const res = await hybridSearch('deploy pipeline', clone(), opts());
    expectRanked(res, BLEND, false);
    expect(breakdownOf(res, 'z2')).toMatchObject({ mode: 'hybrid', matchedTerms: [], cosine: 1 });
    expect(score(res, 'd6')).toBeGreaterThan(score(res, 'd3'));
    expect(breakdownOf(res, 'd6').postMmrRank).toBeGreaterThan(breakdownOf(res, 'd3').postMmrRank!);
  });

  it('without MMR the scores order the list, under the weight the caller set', async () => {
    const res = await hybridSearch('deploy pipeline', clone(), { ...opts(), mmr: false, embeddingWeight: 0.3 });
    expectRanked(res, ['x1', 'd1', 's1', 'd5', 'n1', 'd2', 'd6', 'd3', 'z2', 'd4', 'c1']);
    expect(breakdownOf(res, 'x1')).toMatchObject({ embeddingWeight: 0.3 });
    expect(breakdownOf(res, 'x1').postMmrRank).toBeUndefined();
  });

  it('rrf fuses by rank, and the graph stream lifts a related row', async () => {
    const rrf = await hybridSearch('deploy pipeline', clone(), { ...opts(), scoring: 'rrf' });
    expectRanked(rrf, ['x1', 'c1', 'd2', 'd1', 'z2', 'd5', 's1', 'd3', 'n1', 'd6', 'd4'], false);
    const graphStream = { weight: 0.5, tenantId: TENANT, seedCount: 3 };
    const graph = await hybridSearch('deploy pipeline', clone(), { ...opts(), scoring: 'rrf', graphStream });
    expectRanked(graph, ['x1', 'c1', 'd2', 'd1', 'd5', 'z2', 's1', 'd3', 'n1', 'd4', 'd6'], false);
    expect(score(graph, 'd4')).toBeGreaterThan(score(rrf, 'd4'));
  });

  it('a reranker reorders only its top-k head and records the ranks it moved', async () => {
    const reranker: RerankerFn = async (_q, items) =>
      [...items]
        .reverse()
        .map((r, i) => ({ ...r, rerankScore: i, preRerankRank: r.preRerankRank ?? 0, postRerankRank: i + 1 }));
    const res = await hybridSearch('deploy pipeline', clone(), { ...opts(), reranker, rerankerOptions: { topK: 3 } });
    expectRanked(res, ['s1', 'd1', 'x1', ...BLEND.slice(3)], false);
    expect(res.slice(0, 4).map((r) => [r.rerankScore, r.preRerankRank, r.postRerankRank])).toEqual([
      [0, 3, 1],
      [1, 2, 2],
      [2, 1, 3],
      [undefined, undefined, undefined],
    ]);
  });

  it('vector candidates add store rows the caller did not pass', async () => {
    const vectorCandidates = { tenantId: TENANT, includeSuperseded: false, limit: 5 };
    const res = await hybridSearch('deploy pipeline', clone(), { ...opts(), vectorCandidates });
    expectRanked(res, ['x1', 'd1', 's1', 'd5', 'n1', 'd2', 'z2', 'v1', 'v2', 'd3', 'd6', 'c1', 'd4'], false);
  });

  it('physics merges its pool with the classic one; its top row ties the classic top', async () => {
    const res = await physicsSearch('deploy pipeline', clone(), { ...opts(), queryEmbedding: [1, 0, 0] });
    expectRanked(res, ['x1', 'z2', 's1', 'n1', 'd5', 'd1', 'd6', 'd3', 'd2', 'c1', 'd4']);
    expect(score(res, 'z2')).toBe(score(res, 'x1'));
    expect([breakdownOf(res, 'x1').mode, breakdownOf(res, 'z2').mode]).toEqual(['hybrid', 'physics']);
  });

  it('physics with asOf, a summary deboost and vector candidates returns the old row alone', async () => {
    const vectorCandidates = { tenantId: TENANT, includeSuperseded: false, limit: 5 };
    const res = await physicsSearch('deploy pipeline', clone(), {
      ...opts(),
      asOf: ago(50),
      summaryDeboost: 0.6,
      vectorCandidates,
    });
    expectRanked(res, ['o1']);
  });

  it('physics with no provider falls back to the BM25 order', async () => {
    vi.stubEnv('OPENAI_API_KEY', undefined);
    const res = await physicsSearch('deploy pipeline', clone(), opts());
    expectRanked(res, ids(search('deploy pipeline', clone(), { now: NOW, budget: 100_000 })));
    expect(res.every((r) => r.cosine === 0)).toBe(true);
    expect(new Set(res.flatMap((r) => r.breakdown?.mode ?? []))).toEqual(new Set(['bm25-only']));
  });
});
