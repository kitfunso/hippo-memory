// getContext on hippo.db returns and records what each case lists; on a store held in memory it answers the same through
// the store, with hippo.db blocked.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetAblationCacheForTests } from '../src/ablation.js';
import { getContext, type Actor, type ContextOpts, type ContextResult } from '../src/api.js';
import { _resetSharedStoreCacheForTests, markSharedStore } from '../src/config.js';
import { closeHippoDb, openHippoDb, setMeta, withSqliteBlocked } from '../src/db.js';
import { StoreNotPortedError } from '../src/util/sqlite-blocked.js';
import { embeddingIndexIdentity } from '../src/embeddings.js';
import { resetAllPhysicsState } from '../src/db/physics-state.js';
import type { HippoStore } from '../src/store-port.js';
import { MEMORY_SELECT_COLUMNS, rowToEntry, type MemoryRow } from '../src/store/rows.js';
import { EMBEDDING_MODEL_META_KEY, upsertVectors } from '../src/db/vector-store.js';
import {
  CONTEXT_NOW, contextRowsOf, OWNER, PROJECT, rounded, SESSION, seedContextGlobal, seedContextRows,
} from './_helpers/context-fixture.js';
import { hashedVector, startHashedEmbeddings, type HashedEmbeddings } from './_helpers/hashed-embedding-server.js';
import { inMemoryContextStore, type InMemoryContextStore } from './_helpers/in-memory-context-store.js';
import { portOnlyStore } from './_helpers/port-only-store.js';
import { CLEARED_ENV, statsMirror } from './_helpers/recall-golden-seed.js';
import { seedTwoTenants, TENANT_A, TENANT_B } from './_helpers/store-conformance.js';

type Block = Exclude<keyof ContextResult, 'entries' | 'tokens'>;

/** What the hippo.db pass that reads the global store too returns and records. */
interface Expected {
  /** Entry ids in rank order. */
  readonly ids: readonly string[];
  readonly tokens: number;
  readonly blocks: readonly Block[];
  /** The result count on the one trace row the call writes; absent when it writes none. */
  readonly traced?: number;
  /** total_recalled in stats.json after the call; absent when the call writes no stats.json. */
  readonly recalled?: number;
  /** Global-store ids the call counts as retrieved there, in id order; absent when it counts none. */
  readonly globalRetrieved?: readonly string[];
}

interface Case {
  readonly name: string;
  readonly opts: ContextOpts;
  readonly expected: Expected;
  readonly actor?: Actor;
  readonly tenantId?: string;
  readonly shared?: true;
  readonly physicsOff?: true;
  /** Physics on in the embedded passes only: with no provider it ranks as hybrid. */
  readonly physicsOn?: true;
  /** Shows the case reached the branch it names, on the hippo.db pass that reads the global store too. */
  readonly reaches?: (pass: Pass) => void;
  /** Reads the in-memory store must have answered, so the case cannot pass on hippo.db's copy. */
  readonly storeReads?: readonly string[];
}

const ALICE: Actor = { subject: 'api_key:k1', role: 'member', owner: OWNER };
const OWN_STEPS = ['mem_a_own_0', 'mem_a_own_1', 'mem_a_own_2', 'mem_a_own_3', 'mem_a_own_4', 'mem_a_own_5'] as const;
const ALL_BLOCKS: readonly Block[] = ['activeSnapshot', 'sessionHandoff', 'recentEvents', 'ambientState'];

const CASES: readonly Case[] = [
  {
    name: 'no query, with the active session',
    opts: { currentSessionId: SESSION },
    expected: {
      ids: [
        'mem_a_error', 'mem_a_pin', 'mem_a_liked', ...OWN_STEPS, 'mem_a_global_0', 'mem_a_global_1', 'mem_a_global_2', 'mem_a_team',
        'mem_a_new', 'mem_a_blank', 'mem_a_archived', 'mem_a_secret_own', 'mem_g_pin', 'mem_g_note', 'mem_a_decayed', 'mem_a_flat',
      ],
      tokens: 253,
      blocks: ALL_BLOCKS,
      traced: 21,
      recalled: 21,
      globalRetrieved: ['mem_g_note', 'mem_g_pin'],
    },
    reaches: (p) => {
      expect(p.result.activeSnapshot?.task).toBe('unkeyed task for session a');
      expect(p.result.recentEvents?.length).toBeGreaterThan(0);
      expect(p.result.ambientState).toBeDefined();
      expect(p.result.entries.some((e) => e.isGlobal)).toBe(true);
    },
    storeReads: ['continuity', 'contextCandidates', 'ambientTallies'],
  },
  {
    name: 'query',
    opts: { q: 'rollout queue' },
    expected: {
      ids: [...OWN_STEPS, 'mem_g_note', 'mem_g_pin', 'mem_a_liked', 'mem_a_new', 'mem_a_team', 'mem_a_flat', 'mem_a_decayed'],
      tokens: 151,
      blocks: ALL_BLOCKS,
      traced: 13,
      recalled: 13,
      globalRetrieved: ['mem_g_note', 'mem_g_pin'],
    },
    physicsOn: true,
    reaches: (p) => expect(p.result.entries.length).toBeGreaterThan(0),
    storeReads: ['searchRecallEntries', 'physicsParticles'],
  },
  {
    name: 'query without physics',
    opts: { q: 'rollout' },
    expected: {
      ids: ['mem_g_note', 'mem_g_pin', 'mem_a_liked', 'mem_a_new', ...OWN_STEPS, 'mem_a_team', 'mem_a_flat', 'mem_a_decayed'],
      tokens: 151,
      blocks: ALL_BLOCKS,
      traced: 13,
      recalled: 13,
      globalRetrieved: ['mem_g_note', 'mem_g_pin'],
    },
    physicsOff: true,
    reaches: (p) => expect(p.result.entries.length).toBeGreaterThan(0),
    storeReads: ['searchRecallEntries', 'nearestEntries'],
  },
  {
    name: 'query cut to nothing, which still writes a trace',
    opts: { q: 'rollout', exactScope: 'team:eng', limit: 0 },
    expected: { ids: [], tokens: 0, blocks: [], traced: 0 },
    reaches: (p) => {
      expect(p.result).toEqual({ entries: [], tokens: 0 });
      expect(p.rows.local.traces).toEqual([expect.objectContaining({ result_count: 0, pipeline: 'context' })]);
    },
  },
  {
    name: 'pinned only, with recent rows and prompt recall',
    opts: { pinnedOnly: true, includeRecent: 5, prompt: 'what is the rule for billing deploys on fridays' },
    expected: { ids: ['mem_a_pin', 'mem_g_pin'], tokens: 29, blocks: ['activeSnapshot', 'sessionHandoff', 'recentEvents'] },
    reaches: (p) => expect(p.result.entries.some((e) => e.entry.pinned)).toBe(true),
    storeReads: ['ambientCandidates'],
  },
  {
    name: 'shared store, member keyed by owner',
    opts: {},
    expected: {
      ids: [
        'mem_a_error', 'mem_a_pin', 'mem_a_liked', ...OWN_STEPS, 'mem_a_global_0', 'mem_a_global_1', 'mem_a_global_2', 'mem_a_team',
        'mem_a_alice', 'mem_a_new', 'mem_a_blank', 'mem_a_archived', 'mem_a_secret_own', 'mem_a_decayed', 'mem_a_flat',
      ],
      tokens: 241,
      blocks: ALL_BLOCKS,
      traced: 20,
      recalled: 20,
    },
    actor: ALICE,
    shared: true,
    reaches: (p) => {
      expect(p.result.activeSnapshot?.task).toBe('alice task, newer id');
      expect(p.result.sessionHandoff?.summary).toBe('alice handoff');
    },
  },
  {
    name: 'shared store, member across projects',
    opts: { crossProject: true, q: 'rollout' },
    expected: {
      ids: ['mem_a_liked', 'mem_a_alice', 'mem_a_new', ...OWN_STEPS, 'mem_a_team', 'mem_a_no_origin', 'mem_a_flat', 'mem_a_decayed'],
      tokens: 152,
      blocks: ALL_BLOCKS,
      traced: 13,
      recalled: 13,
    },
    actor: ALICE,
    shared: true,
  },
  {
    name: 'second tenant, pinned only, whose stale snapshot leaves an unfinished handoff',
    opts: { pinnedOnly: true, includeRecent: 3 },
    expected: { ids: ['mem_b_0', 'mem_b_1', 'mem_b_2', 'mem_b_pin'], tokens: 38, blocks: ['sessionHandoff'] },
    tenantId: TENANT_B,
    reaches: (p) => {
      expect(p.result.activeSnapshot).toBeUndefined();
      expect(p.result.sessionHandoff?.summary).toBe('globex handoff');
    },
    storeReads: ['unfinishedHandoff'],
  },
];

const ADMIN: Actor = { subject: 'cli', role: 'admin' };
const MODEL = 'hashed-16';

interface Pass {
  readonly result: ContextResult;
  readonly rows: { readonly local: ContextRows; readonly global: ContextRows | null };
  readonly lastRecall: unknown[];
  readonly stats: string | null;
}

type ContextRows = ReturnType<typeof contextRowsOf>;

function lastRecallMeta(root: string): unknown[] {
  const db = openHippoDb(root);
  try {
    return db.prepare("SELECT key, value FROM meta WHERE key IN ('last_retrieval_ids', 'last_trace_id') ORDER BY key").all();
  } finally {
    closeHippoDb(db);
  }
}

/** Every memory row's hashed vector and its particle, so the search's vector arm and physics have rows to read. */
function seedVectors(dir: string): void {
  const db = openHippoDb(dir);
  try {
    // SAFETY: the SELECT names exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
    const entries = (db.prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories ORDER BY id`).all() as MemoryRow[]).map(rowToEntry);
    const index = Object.fromEntries(entries.map((e): [string, number[]] => [e.id, hashedVector(e.content)]));
    const identity = embeddingIndexIdentity(`openai:${MODEL}`);
    upsertVectors(db, Object.entries(index), identity);
    setMeta(db, EMBEDDING_MODEL_META_KEY, identity);
    resetAllPhysicsState(db, entries, index, new Date(CONTEXT_NOW));
  } finally {
    closeHippoDb(db);
  }
}

interface Templates {
  readonly local: string;
  readonly vectors: string;
  readonly global: string;
}

let templates: Templates;
let seededLastRecall: unknown[];
let globalRows: ContextRows;
let embeddings: HashedEmbeddings;

beforeAll(async () => {
  const local = seedTwoTenants().dir;
  seedContextRows(local);
  const vectors = mkdtempSync(join(tmpdir(), 'hippo-context-vectors-'));
  cpSync(local, vectors, { recursive: true });
  seedVectors(vectors);
  const global = mkdtempSync(join(tmpdir(), 'hippo-context-global-'));
  seedContextGlobal(global);
  templates = { local, vectors, global };
  seededLastRecall = lastRecallMeta(local);
  globalRows = contextRowsOf(global);
  embeddings = await startHashedEmbeddings();
}, 120_000);

afterAll(async () => {
  await embeddings.close();
  for (const dir of Object.values(templates)) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of CLEARED_ENV) vi.stubEnv(k, '');
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(CONTEXT_NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  _resetSharedStoreCacheForTests();
  _resetAblationCacheForTests();
});

interface PassOpts {
  /** HIPPO_HOME points at a copy of the global store, else at no store. */
  readonly withGlobal: boolean;
  /** The store carries vectors and the local hashed-embedding server is its provider. */
  readonly embedded: boolean;
}

/** The config.json a pass writes, when it sets anything. */
interface PassConfig {
  embeddings?: { readonly provider: string; readonly model: string; readonly apiBaseUrl: string };
  physics?: { readonly enabled: boolean };
}

/** One getContext on a fresh copy of the fixture. */
async function runPass(c: Case, { withGlobal, embedded }: PassOpts, makeStore?: (root: string) => HippoStore): Promise<Pass> {
  _resetSharedStoreCacheForTests();
  _resetAblationCacheForTests();
  const home = mkdtempSync(join(tmpdir(), 'hippo-context-parity-'));
  try {
    const root = join(home, 'store');
    const globalRoot = join(home, 'global');
    cpSync(embedded ? templates.vectors : templates.local, root, { recursive: true });
    if (withGlobal) cpSync(templates.global, globalRoot, { recursive: true });
    vi.stubEnv('HIPPO_HOME', globalRoot);
    const config: PassConfig = {};
    if (embedded) config.embeddings = { provider: 'openai', model: MODEL, apiBaseUrl: embeddings.url };
    if (c.physicsOff) config.physics = { enabled: false };
    else if (c.physicsOn && embedded) config.physics = { enabled: true };
    if (Object.keys(config).length > 0) writeFileSync(join(root, 'config.json'), JSON.stringify(config));
    if (c.shared) markSharedStore(root);
    const store = makeStore?.(root);
    const ctx = { hippoRoot: root, tenantId: c.tenantId ?? TENANT_A, actor: c.actor ?? ADMIN, store };
    const opts: ContextOpts = { currentProject: PROJECT, ...c.opts };
    const result = store && store.kind !== 'sqlite'
      ? await withSqliteBlocked(store.kind, () => getContext(ctx, opts))
      : await getContext(ctx, opts);
    await store?.close();
    return {
      result,
      rows: { local: contextRowsOf(root), global: withGlobal ? contextRowsOf(globalRoot) : null },
      lastRecall: lastRecallMeta(root),
      stats: statsMirror(root),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('getContext on hippo.db returns and records what each case lists', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const pass = await runPass(c, { withGlobal: true, embedded: false });
    const { result } = pass;
    const { ids, tokens, blocks, traced, recalled, globalRetrieved = [] } = c.expected;
    c.reaches?.(pass);
    expect(result.entries.map((e) => e.entry.id)).toEqual(ids);
    expect(result.tokens).toBe(tokens);
    expect(ALL_BLOCKS.filter((block) => result[block] !== undefined)).toEqual(blocks);
    expect(pass.rows.local.traces).toEqual(traced === undefined ? [] : [expect.objectContaining({ pipeline: 'context', result_count: traced })]);
    expect(pass.rows.local.traceResults).toHaveLength(traced ?? 0);
    expect(pass.stats).toEqual(recalled === undefined ? null : expect.stringContaining(`"total_recalled": ${recalled},`));
    expect(pass.rows.global?.retrieved).toEqual(globalRetrieved.map((id) => expect.objectContaining({ id, retrieval_count: 1 })));
  }, 120_000);
});

describe('getContext on a store held in memory, with hippo.db blocked', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const onHippoDb = await runPass(c, { withGlobal: false, embedded: true });
    const before = embeddings.requests();
    let memory: InMemoryContextStore | undefined;
    // The operator's global store sits under HIPPO_HOME here, and a store other than hippo.db must neither read nor write it.
    const inMemory = await runPass(c, { withGlobal: true, embedded: true }, (root) => (memory = inMemoryContextStore(root)).store);
    expect(rounded(inMemory.result)).toEqual(rounded(onHippoDb.result));
    expect(inMemory.rows.local).toEqual(onHippoDb.rows.local);
    expect(inMemory.rows.global).toEqual(globalRows);
    expect(inMemory.stats).toBe(onHippoDb.stats);
    // The last-recall ids feed only POST /v1/outcome, which no other store serves, so the store path leaves them as seeded.
    expect(inMemory.lastRecall).toEqual(seededLastRecall);
    expect(memory?.calls).toEqual(expect.arrayContaining([...(c.storeReads ?? [])]));
    if (c.storeReads?.includes('physicsParticles') || c.storeReads?.includes('nearestEntries')) {
      expect(embeddings.requests()).toBeGreaterThan(before);
    }
  }, 120_000);

  it('a store without contextReads answers StoreNotPortedError before it reads a row', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-context-unported-'));
    try {
      const store = portOnlyStore(home);
      const ctx = { hippoRoot: home, tenantId: TENANT_A, actor: ADMIN, store };
      await expect(withSqliteBlocked(store.kind, () => getContext(ctx, { currentProject: PROJECT }))).rejects.toBeInstanceOf(StoreNotPortedError);
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
