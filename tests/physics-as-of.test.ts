// Physics ranking under asOf on a real store: no row, and no physics state, from after the cut may reach the results.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { makeRoot } from './_helpers/make-root.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, type MemoryEntry } from '../src/core/memory.js';
import { saveStoredEmbeddingModel } from '../src/store/embeddings/index.js';
import { saveEmbeddingIndex } from '../src/store/vector-index.js';
import { resolveEmbeddingProvider } from '../src/embeddings/provider.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { savePhysicsState } from '../src/db/physics-state.js';
import { loadConfig } from '../src/core/config.js';
import { hybridSearch } from '../src/search/hybrid.js';
import { physicsSearch } from '../src/search/physics-search.js';
import { rankRecall, type RankRecallOpts } from '../src/api/recall-pipeline.js';
import type { SearchResult } from '../src/core/search-types.js';

const TENANT = 'default';
const CUT = '2026-06-01T00:00:00.000Z';
const NOW = new Date('2026-09-01T00:00:00.000Z');
const QUERY_VECTOR = [1, 0, 0];

function mk(id: string, content: string, validFrom: string): MemoryEntry {
  const base = createMemory(content, { baseHalfLifeDays: 30, tenantId: TENANT });
  return { ...base, id, created: validFrom, last_retrieved: validFrom, valid_from: validFrom };
}

// pre1 and pre2 existed at the cut; post was written after it and sits right on the query with a heavy particle.
const PRE1 = mk('pre1', 'deploy pipeline runs on jenkins', '2026-05-01T00:00:00.000Z');
const PRE2 = mk('pre2', 'deploy pipeline needs ops approval', '2026-04-01T00:00:00.000Z');
const POST = mk('post', 'deploy pipeline moved to github actions', '2026-07-01T00:00:00.000Z');
const VECTORS = { pre1: [0.6, 0.8, 0], pre2: [0.5, 0, 0.86], post: QUERY_VECTOR } satisfies Record<string, number[]>;

let root: string;

beforeEach(() => {
  root = makeRoot('physics-asof', { config: { embeddings: { provider: 'openai', model: 'text-embedding-3-small' } } });
  process.env.OPENAI_API_KEY = 'sk-test';
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    // SAFETY: body is the OpenAI embeddings request the provider just serialised.
    const body = JSON.parse(init.body) as { input: string[] };
    return new Response(JSON.stringify({ data: body.input.map(() => ({ embedding: QUERY_VECTOR })) }), { status: 200 });
  }));
  for (const e of [PRE1, PRE2, POST]) writeEntry(root, { ...e, tags: [...e.tags] });
  saveEmbeddingIndex(root, VECTORS);
  saveStoredEmbeddingModel(root, resolveEmbeddingProvider(root).id);
  const db = openHippoDb(root);
  try {
    savePhysicsState(db, Object.entries(VECTORS).map(([id, position]) => ({
      memoryId: id, position, velocity: [0, 0, 0], mass: id === 'post' ? 5 : 1, charge: 0, temperature: 0.5,
      lastSimulation: NOW.toISOString(),
    })));
  } finally {
    closeHippoDb(db);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  rmSync(root, { recursive: true, force: true });
});

const ids = (results: SearchResult[]): string[] => results.map((r) => r.entry.id);
const pool = (...entries: MemoryEntry[]): MemoryEntry[] => entries.map((e) => ({ ...e, tags: [...e.tags] }));

describe('physicsSearch with asOf', () => {
  const base = () => ({ now: NOW, budget: 100_000, hippoRoot: root, explain: true, scope: null, asOf: CUT });

  it('drops a row written after the cut and ranks exactly as the hybrid path does', async () => {
    const physics = await physicsSearch('deploy pipeline', pool(PRE1, PRE2, POST), { ...base(), queryEmbedding: QUERY_VECTOR });
    const hybrid = await hybridSearch('deploy pipeline', pool(PRE1, PRE2, POST), base());
    expect(ids(physics)).not.toContain('post');
    expect(ids(physics)).toEqual(ids(hybrid));
    expect(physics.map((r) => r.score)).toEqual(hybrid.map((r) => r.score));
    // Particle positions and masses are today's, so none may shape a past-dated ranking.
    expect(physics.every((r) => r.breakdown?.mode !== 'physics')).toBe(true);
  });

  it('does not let the vector arm add a row written after the cut', async () => {
    const vectorCandidates = { tenantId: TENANT, includeSuperseded: true, limit: 5 };
    const physics = await physicsSearch('deploy pipeline', pool(PRE1, PRE2), { ...base(), queryEmbedding: QUERY_VECTOR, vectorCandidates });
    expect(ids(physics)).not.toContain('post');
    expect(ids(physics)).toEqual(ids(await hybridSearch('deploy pipeline', pool(PRE1, PRE2), { ...base(), vectorCandidates })));
  });

  it('still ranks by physics when no asOf is given', async () => {
    const physics = await physicsSearch('deploy pipeline', pool(PRE1, PRE2, POST), { ...base(), asOf: undefined, queryEmbedding: QUERY_VECTOR });
    expect(ids(physics)[0]).toBe('post');
    expect(physics[0].breakdown?.mode).toBe('physics');
  });

  it('drops a superseded row from the physics pool unless includeSuperseded is set', async () => {
    const superseded = { ...PRE1, superseded_by: 'post', tags: [...PRE1.tags] };
    const current = await physicsSearch('deploy pipeline', [superseded, ...pool(PRE2, POST)], { ...base(), asOf: undefined, queryEmbedding: QUERY_VECTOR });
    expect(ids(current)).not.toContain('pre1');
    const all = await physicsSearch('deploy pipeline', [superseded, ...pool(PRE2, POST)], {
      ...base(), asOf: undefined, includeSuperseded: true, queryEmbedding: QUERY_VECTOR,
    });
    expect(ids(all)).toContain('pre1');
  });
});

describe('rankRecall in physics mode with asOf', () => {
  const opts = (explain: boolean, usePhysics: boolean): RankRecallOpts => ({
    query: 'deploy pipeline',
    budget: 100_000,
    cost: (r) => r.tokens,
    limit: 10,
    includeSuperseded: false,
    asOf: CUT,
    explicitScope: null,
    activeScope: null,
    search: { usePhysics, physicsConfig: loadConfig(root).physics, multihop: false, mmr: false, mmrLambda: 0.7, localBump: 1.2, explain },
  });
  const rank = async (explain: boolean, usePhysics: boolean): Promise<string[]> =>
    (await rankRecall({ hippoRoot: root, tenantId: TENANT }, opts(explain, usePhysics))).results.map((r) => r.entry.id);

  for (const explain of [false, true]) {
    it(`returns the same rows as the non-physics path${explain ? ' under explain' : ''}`, async () => {
      const physics = await rank(explain, true);
      expect(physics).not.toContain('post');
      expect(physics).toEqual(await rank(explain, false));
    });
  }
});
