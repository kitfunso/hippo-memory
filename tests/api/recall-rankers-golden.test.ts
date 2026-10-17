// Ids and order from each ranker retrieve() names (the SQL band, the MCP wide list, the CLI core) over one seeded store,
// pinned so a change to how any of them picks its search engine cannot move a ranking.
import type { FullContext } from '../_helpers/api-ctx.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { retrieve } from '../../src/api/recall/recall.js';
import { adminActor, type RecallOptions } from '../../src/api/index.js';
import type { RankRecallOptions } from '../../src/api/recall/pipeline.js';
import { loadConfig } from '../../src/core/config.js';
import { _resetAblationCacheForTests } from '../../src/core/ablation.js';
import { setMeta } from '../../src/db/index.js';
import { resetAllPhysicsState } from '../../src/db/physics-state.js';
import { EMBEDDING_MODEL_META_KEY, upsertVectors } from '../../src/db/vector-store.js';
import { embeddingIndexIdentity } from '../../src/store/embeddings/index.js';
import { loadEntriesByIds } from '../../src/store/entry-reads.js';
import { hashedVector, startHashedEmbeddings, type HashedEmbeddings } from '../_helpers/hashed-embedding-server.js';
import { onDb } from '../_helpers/store-worker-server.js';
import {
  CLEARED_ENV, FAKE_NOW, freshStore, SESSION, seedPortBranches, seedTemplates, TENANT, type Store, type Templates,
} from '../_helpers/recall-golden-seed.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';

const MODEL = 'hashed-16';
// Rows with a vector and no particle rank in physics' classic pool, so both physics pools are pinned.
const NO_PARTICLE = new Set(['mem_p_fill0', 'mem_p_noise']);

/** Vectors for every local row and particles for most, so the vector arm and physics scoring both change the order. */
function seedVectors(root: string, url: string): void {
  seedPortBranches(root);
  // SAFETY: the SELECT names one column, id, so each row has it.
  const ids = onDb(root, (db) => db.prepare('SELECT id FROM memories ORDER BY id').all().map((r) => String((r as { id: unknown }).id)));
  const entries = loadEntriesByIds(root, ids);
  const index = Object.fromEntries(entries.map((e): [string, number[]] => [e.id, hashedVector(e.content)]));
  const identity = embeddingIndexIdentity(`openai:${MODEL}`);
  onDb(root, (db) => {
    upsertVectors(db, Object.entries(index), identity);
    setMeta(db, EMBEDDING_MODEL_META_KEY, identity);
    resetAllPhysicsState(db, entries.filter((e) => !NO_PARTICLE.has(e.id)), index, new Date(FAKE_NOW));
  });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: MODEL, apiBaseUrl: url }, physics: { enabled: true } }));
}

type BandCase = readonly [string, Omit<RecallOptions, 'cliCore' | 'showRanked'>];
interface CoreSetup { rank?: Partial<RankRecallOptions>; physics?: boolean; global?: boolean; sessionId?: string }
type CoreCase = readonly [string, string, CoreSetup];

const BAND: readonly BandCase[] = [
  ['bm25 plain', { query: 'deploy' }],
  ['bm25 limit 3', { query: 'deploy', window: { limit: 3 } }],
  ['hybrid', { query: 'deploy', mode: 'hybrid' }],
  ['physics', { query: 'deploy', mode: 'physics' }],
  ['scope team-alpha', { query: 'deploy', filter: { scope: 'team-alpha' } }],
  ['session goal boost', { query: 'deploy', boost: { sessionId: SESSION } }],
  ['goal tag beats the session', { query: 'deploy', boost: { sessionId: SESSION, goalTag: 'goal-alpha' }, mode: 'hybrid' }],
  ['fresh tail', { query: 'deploy', window: { freshTailCount: 1, freshTailSessionId: SESSION } }],
  ['overflow summary', { query: 'deploy', window: { limit: 2 } }],
  ['hybrid rollout limit 5', { query: 'rollout', mode: 'hybrid', window: { limit: 5 } }],
  ['LIKE path', { query: 'caf' }],
  ['physics with session', { query: 'deploy', mode: 'physics', boost: { sessionId: SESSION }, trace: { explain: true } }],
];

const WIDE: readonly BandCase[] = [
  ['wide hybrid', { query: 'deploy' }],
  ['wide physics with session', { query: 'deploy', mode: 'physics', boost: { sessionId: SESSION }, window: { limit: 5 } }],
  ['wide scoped', { query: 'rollout cluster', filter: { scope: 'team-alpha' } }],
];

const CORE: readonly CoreCase[] = [
  ['core hybrid', 'deploy', {}],
  ['core physics', 'deploy', { physics: true }],
  ['core with the global store', 'deploy', { global: true }],
  ['core physics with the global store', 'deploy', { global: true, physics: true }],
  ['core session goal boost', 'deploy', { sessionId: SESSION }],
  ['core superseded kept', 'deploy target', { rank: { includeSuperseded: true } }],
  ['core explicit private scope', 'deploy', { rank: { explicitScope: 'slack:private:C1' } }],
  ['core explain physics', 'deploy rollout', { physics: true, rank: { why: true } }],
];

// The seeded prediction's claim is a semantic row with a fresh id each run.
const stable = (id: string): string => (id.startsWith('sem_') ? '<claim>' : id);

let templates: Templates;
let embeddings: HashedEmbeddings;

const ctxOf = (s: Store): FullContext => (apiCtx(s.root, TENANT, adminActor('golden')));

async function onStore<T>(fn: (s: Store) => Promise<T>): Promise<T> {
  const s = freshStore(templates, 'local');
  try {
    return await fn(s);
  } finally {
    rmSync(s.home, { recursive: true, force: true });
  }
}

function rankOpts(s: Store, c: CoreSetup): Omit<RankRecallOptions, 'query' | 'boost'> {
  const search = {
    usePhysics: c.physics === true, physicsConfig: loadConfig(s.root).physics, multihop: false, mmr: false, mmrLambda: 0.7, localBump: 1.2,
    explain: c.rank?.why === true,
  };
  return { budget: 4000, cost: (r) => r.tokens, window: { limit: 10 }, includeSuperseded: false, explicitScope: null, activeScope: null, ...c.rank, search };
}

describe('recall ranker goldens', () => {
  beforeAll(async () => {
    embeddings = await startHashedEmbeddings();
    templates = await seedTemplates((root) => seedVectors(root, embeddings.url));
  });

  afterAll(async () => {
    await embeddings.close();
    rmSync(templates.dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const k of CLEARED_ENV) vi.stubEnv(k, '');
    vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret');
    _resetAblationCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetAblationCacheForTests();
  });

  it.each(BAND)('band ranker: %s', async (_name, opts) => {
    const ids = await onStore(async (s) => (await retrieve(ctxOf(s), opts)).results.map((r) => stable(r.id)));
    expect(ids).toMatchSnapshot();
  });

  it.each(WIDE)('MCP wide ranker: %s', async (_name, opts) => {
    const got = await onStore(async (s) => {
      let ranked: string[] = [];
      const result = await retrieve(ctxOf(s), {
        ...opts,
        filter: { ...opts.filter, keepHeldCopies: true },
        hints: { ...opts.hints, suppressAvailabilityHint: true },
        showRanked: (ranking) => {
          ranked = ranking.ranked.map((r) => r.entry.id);
          return { ids: ranked.slice(0, 10), audit: [] };
        },
      });
      return { ranked: ranked.map(stable), band: result.results.map((r) => stable(r.id)) };
    });
    expect(got).toMatchSnapshot();
  });

  it.each(CORE)('CLI core ranker: %s', async (_name, query, c) => {
    const got = await onStore(async (s) => {
      let ranked: string[] = [];
      await retrieve(ctxOf(s), {
        query,
        boost: { sessionId: c.sessionId },
        cliCore: {
          rank: rankOpts(s, c),
          sources: c.global ? { globalRoot: s.globalRoot, globalStore: sqliteStore(s.globalRoot) } : undefined,
          show: (ranking) => {
            ranked = ranking.results.map((r) => stable(r.entry.id));
            return { results: ranking.results, audit: [], tokens: 0 };
          },
        },
      });
      return ranked;
    });
    expect(got).toMatchSnapshot();
  });
});
