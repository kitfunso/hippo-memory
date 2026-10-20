// The order each recall ranker (the SQL band, the MCP wide list, the CLI core) gives over one seeded store, so a
// change to how any of them picks its search engine shows up as a moved row.
import type { FullContext } from '../_helpers/api-ctx.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { retrieve, retrieveRanking } from '../../src/api/recall/recall.js';
import { retrieveWithCliCore } from '../../src/api/recall/request.js';
import { adminActor, type RecallOptions } from '../../src/api/index.js';
import type { RankRecallOptions } from '../../src/api/recall/pipeline.js';
import { loadConfig } from '../../src/base/config/config.js';
import { setMeta } from '../../src/db/index.js';
import { resetAllPhysicsState } from '../../src/db/physics-state.js';
import { EMBEDDING_MODEL_META_KEY, upsertVectors } from '../../src/db/vector-store.js';
import { embeddingIndexIdentity } from '../../src/base/embeddings/index-identity.js';
import { hashedVector, startHashedEmbeddings, type HashedEmbeddings } from '../_helpers/hashed-embedding-server.js';
import { onDb } from '../_helpers/store-worker-server.js';
import {
  CLEARED_ENV,
  FAKE_NOW,
  freshStore,
  SESSION,
  seedPortBranches,
  seedTemplates,
  TENANT,
  type Store,
  type Templates,
} from '../_helpers/recall-golden-seed.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { loadEntriesByIds } from '../_helpers/root-forms.js';

const MODEL = 'hashed-16';
// Rows with a vector and no particle rank in physics' classic pool, so both physics pools are pinned.
const NO_PARTICLE = new Set(['mem_p_fill0', 'mem_p_noise']);

/** Vectors for every local row and particles for most, so the vector arm and physics scoring both change the order. */
function seedVectors(root: string, url: string): void {
  seedPortBranches(root);
  // SAFETY: the SELECT names one column, id, so each row has it.
  const ids = onDb(root, (db) =>
    db
      .prepare('SELECT id FROM memories ORDER BY id')
      .all()
      .map((r) => String((r as { id: unknown }).id)),
  );
  const entries = loadEntriesByIds(root, ids);
  const index = Object.fromEntries(entries.map((e): [string, number[]] => [e.id, hashedVector(e.content)]));
  const identity = embeddingIndexIdentity(`openai:${MODEL}`);
  onDb(root, (db) => {
    upsertVectors(db, Object.entries(index), identity);
    setMeta(db, EMBEDDING_MODEL_META_KEY, identity);
    resetAllPhysicsState(
      db,
      entries.filter((e) => !NO_PARTICLE.has(e.id)),
      index,
      new Date(FAKE_NOW),
    );
  });
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({ embeddings: { provider: 'openai', model: MODEL, apiBaseUrl: url }, physics: { enabled: true } }),
  );
}

type BandCase = readonly [string, RecallOptions, readonly string[]];
interface CoreSetup {
  rank?: Partial<RankRecallOptions>;
  physics?: boolean;
  global?: boolean;
  sessionId?: string;
}
type CoreCase = readonly [string, string, CoreSetup, readonly string[]];
interface Wide {
  ranked: readonly string[];
  band: readonly string[];
}

// The seeded prediction's claim is a semantic row with a fresh id each run.
const CLAIM = '<claim>';
const stable = (id: string): string => (id.startsWith('sem_') ? CLAIM : id);
const FILLS = ['mem_p_fill0', 'mem_p_fill1', 'mem_p_fill2', 'mem_p_fill3', 'mem_p_fill4', 'mem_p_fill5'];

/** The band's BM25 order for "deploy": the pinned row, the exact match, the summary's children, then the fillers. */
const BM25 = ['mem_p_pinned', 'mem_p_plain', 'mem_x_child1', 'mem_x_child2', ...FILLS];
/** The hybrid order for "deploy", where the vector arm lifts the trace and scoped rows above the fillers. */
const HYBRID = [
  'mem_p_plain',
  'mem_p_trace',
  'mem_p_pinned',
  'mem_p_scoped',
  'mem_p_fill5',
  'mem_x_child1',
  'mem_p_new',
  'mem_p_fill2',
  'mem_p_fill4',
  'mem_x_raw',
];
/** The physics order for "deploy", which ranks the scoped row first. */
const PHYSICS = [
  'mem_p_scoped',
  'mem_p_fill0',
  'mem_p_trace',
  'mem_p_plain',
  'mem_p_goal',
  'mem_p_pinned',
  'mem_p_new',
  'mem_x_child1',
  'mem_p_fill5',
  'mem_p_fill2',
];
/** The CLI core's order for "deploy", which a global store with no match or a private scope leaves alone. */
const CORE_ORDER = [
  'mem_p_plain',
  'mem_p_pinned',
  'mem_p_trace',
  'mem_p_scoped',
  'mem_p_fill5',
  'mem_p_new',
  'mem_p_fill2',
  'mem_x_child1',
  'mem_p_fill4',
  'mem_p_fill1',
];
const goalFirst = (order: readonly string[], size = order.length): string[] => [
  'mem_p_goal',
  ...order.filter((id) => id !== 'mem_p_goal').slice(0, size - 1),
];

const BAND: readonly BandCase[] = [
  ['bm25 plain', { query: 'deploy' }, BM25],
  ['bm25 limit 3', { query: 'deploy', window: { limit: 3 } }, BM25.slice(0, 3)],
  ['hybrid', { query: 'deploy', mode: 'hybrid' }, HYBRID],
  ['physics', { query: 'deploy', mode: 'physics' }, PHYSICS],
  ['scope team-alpha', { query: 'deploy', filter: { scope: 'team-alpha' } }, ['mem_p_scoped']],
  // The band applies no session goal boost: the order stays BM25's.
  ['session goal boost', { query: 'deploy', boost: { sessionId: SESSION } }, BM25],
  [
    'goal tag beats the session',
    { query: 'deploy', boost: { sessionId: SESSION, goalTag: 'goal-alpha' }, mode: 'hybrid' },
    HYBRID,
  ],
  [
    'fresh tail',
    { query: 'deploy', window: { freshTailCount: 1, freshTailSessionId: SESSION } },
    ['mem_x_raw', ...BM25],
  ],
  ['overflow summary', { query: 'deploy', window: { limit: 2 } }, [...BM25.slice(0, 2), 'mem_x_summary']],
  [
    'hybrid rollout limit 5',
    { query: 'rollout', mode: 'hybrid', window: { limit: 5 } },
    ['mem_p_plain', CLAIM, 'mem_p_goal', 'mem_x_summary', 'mem_p_noise'],
  ],
  ['LIKE path', { query: 'caf' }, ['mem_x_cafe']],
  [
    'physics with session',
    { query: 'deploy', mode: 'physics', boost: { sessionId: SESSION }, trace: { explain: true } },
    goalFirst(PHYSICS),
  ],
];

/** The rows past the band's ten in the wide list for "deploy", in hybrid order. */
const WIDE_TAIL = [
  'mem_p_fill1',
  'mem_p_fill3',
  'mem_p_goal',
  'mem_x_child2',
  'mem_p_fill0',
  CLAIM,
  'mem_p_noise',
  'mem_x_cafe',
  'mem_x_summary',
];
const WIDE_PHYSICS = [
  ...goalFirst(PHYSICS),
  'mem_p_fill1',
  'mem_p_fill4',
  'mem_p_fill3',
  'mem_x_child2',
  'mem_p_noise',
  'mem_x_raw',
  'mem_x_cafe',
  CLAIM,
  'mem_x_summary',
];

const WIDE: ReadonlyArray<readonly [string, RecallOptions, Wide]> = [
  ['wide hybrid', { query: 'deploy' }, { ranked: [...HYBRID, ...WIDE_TAIL], band: HYBRID }],
  [
    'wide physics with session',
    { query: 'deploy', mode: 'physics', boost: { sessionId: SESSION }, window: { limit: 5 } },
    // Five rows fit the limit, then the overflow summary.
    { ranked: WIDE_PHYSICS, band: [...WIDE_PHYSICS.slice(0, 5), 'mem_x_summary'] },
  ],
  [
    'wide scoped',
    { query: 'rollout cluster', filter: { scope: 'team-alpha' } },
    { ranked: ['mem_p_scoped'], band: ['mem_p_scoped'] },
  ],
];

const CORE: readonly CoreCase[] = [
  ['core hybrid', 'deploy', {}, CORE_ORDER],
  ['core physics', 'deploy', { physics: true }, PHYSICS],
  ['core with the global store', 'deploy', { global: true }, CORE_ORDER],
  ['core physics with the global store', 'deploy', { global: true, physics: true }, CORE_ORDER],
  ['core session goal boost', 'deploy', { sessionId: SESSION }, goalFirst(CORE_ORDER)],
  [
    'core superseded kept',
    'deploy target',
    { rank: { includeSuperseded: true } },
    [
      'mem_p_new',
      'mem_p_old',
      CLAIM,
      'mem_p_plain',
      'mem_x_child1',
      'mem_p_trace',
      'mem_p_noise',
      'mem_p_scoped',
      'mem_x_child2',
      'mem_p_pinned',
    ],
  ],
  ['core explicit private scope', 'deploy', { rank: { explicitScope: 'slack:private:C1' } }, CORE_ORDER],
  [
    'core explain physics',
    'deploy rollout',
    { physics: true, rank: { why: true } },
    [
      'mem_p_goal',
      'mem_p_fill0',
      'mem_p_plain',
      'mem_p_pinned',
      'mem_p_scoped',
      'mem_p_noise',
      'mem_p_new',
      'mem_p_fill1',
      'mem_p_trace',
      'mem_p_fill2',
    ],
  ],
];

let templates: Templates;
let embeddings: HashedEmbeddings;

const ctxOf = (s: Store): FullContext => apiCtx(s.root, TENANT, adminActor('golden'));

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
    usePhysics: c.physics === true,
    physicsConfig: loadConfig(s.root).physics,
    multihop: false,
    mmr: false,
    mmrLambda: 0.7,
    localBump: 1.2,
    explain: c.rank?.why === true,
  };
  return {
    budget: 4000,
    cost: (r) => r.tokens,
    window: { limit: 10 },
    includeSuperseded: false,
    explicitScope: null,
    activeScope: null,
    ...c.rank,
    search,
  };
}

describe('recall ranker order', () => {
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
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(BAND)('band ranker: %s', async (_name, opts, order) => {
    const ids = await onStore(async (s) => (await retrieve(ctxOf(s), opts)).results.map((r) => stable(r.id)));
    expect(ids).toEqual(order);
  });

  it.each(WIDE)('MCP wide ranker: %s', async (_name, opts, wide) => {
    const got = await onStore(async (s) => {
      let ranked: string[] = [];
      const result = await retrieveRanking(
        ctxOf(s),
        {
          ...opts,
          filter: { ...opts.filter, keepHeldCopies: true },
          hints: { ...opts.hints, suppressAvailabilityHint: true },
        },
        (ranking) => {
          ranked = ranking.ranked.map((r) => r.entry.id);
          return { ids: ranked.slice(0, 10), audit: [] };
        },
      );
      return { ranked: ranked.map(stable), band: result.results.map((r) => stable(r.id)) };
    });
    expect(got).toEqual(wide);
  });

  it.each(CORE)('CLI core ranker: %s', async (_name, query, c, order) => {
    const got = await onStore(async (s) => {
      let ranked: string[] = [];
      const ctx = ctxOf(s);
      await retrieveWithCliCore(
        ctx,
        { query, boost: { sessionId: c.sessionId } },
        {
          rank: rankOpts(s, c),
          sources: c.global
            ? { root: s.globalRoot, store: sqliteStore(s.globalRoot), config: loadConfig(s.globalRoot) }
            : undefined,
          show: (ranking) => {
            ranked = ranking.results.map((r) => stable(r.entry.id));
            return { results: ranking.results, audit: [], tokens: 0 };
          },
          lastRecall: ctx.store.lastRecall,
        },
      );
      return ranked;
    });
    expect(got).toEqual(order);
  });
});
