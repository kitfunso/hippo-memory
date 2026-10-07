// getContext on hippo.db answers and writes what the code before the store path did, with or without sqliteStore, as goldens
// taken from that code pin; on a store held in memory it answers the same through the store with hippo.db blocked.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { _resetAblationCacheForTests } from '../src/ablation.js';
import { getContext, type Actor, type ContextOpts, type ContextResult } from '../src/api.js';
import { _resetSharedStoreCacheForTests, markSharedStore } from '../src/config.js';
import { closeHippoDb, openHippoDb, setMeta, withSqliteBlocked } from '../src/db.js';
import { StoreNotPortedError } from '../src/db/sqlite-blocked.js';
import { embeddingIndexIdentity } from '../src/embeddings.js';
import { resetAllPhysicsState } from '../src/physics-state.js';
import { sqliteStore, type HippoStore } from '../src/store-port.js';
import { MEMORY_SELECT_COLUMNS, rowToEntry, type MemoryRow } from '../src/store/rows.js';
import { EMBEDDING_MODEL_META_KEY, upsertVectors } from '../src/vector-store.js';
import {
  CONTEXT_NOW, contextRowsOf, OWNER, PROJECT, rounded, SESSION, seedContextGlobal, seedContextRows,
} from './_helpers/context-fixture.js';
import { hashedVector, startHashedEmbeddings, type HashedEmbeddings } from './_helpers/hashed-embedding-server.js';
import { inMemoryContextStore, type InMemoryContextStore } from './_helpers/in-memory-context-store.js';
import { portOnlyStore } from './_helpers/port-only-store.js';
import { CLEARED_ENV, statsMirror } from './_helpers/recall-golden-seed.js';
import { seedTwoTenants, TENANT_A, TENANT_B } from './_helpers/store-conformance.js';

interface Case {
  readonly name: string;
  readonly opts: ContextOpts;
  readonly actor?: Actor;
  readonly tenantId?: string;
  readonly shared?: true;
  readonly physicsOff?: true;
  /** Physics on in the embedded passes only: with no provider it ranks as hybrid, so the golden pass keeps the config it was written with. */
  readonly physicsOn?: true;
  /** Shows the case reached the branch it names, on the hippo.db pass that reads the global store too. */
  readonly reaches?: (pass: Pass) => void;
  /** Reads the in-memory store must have answered, so the case cannot pass on hippo.db's copy. */
  readonly storeReads?: readonly string[];
}

const ALICE: Actor = { subject: 'api_key:k1', role: 'member', owner: OWNER };

const CASES: readonly Case[] = [
  {
    name: 'no query, with the active session',
    opts: { currentSessionId: SESSION },
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
    physicsOn: true,
    reaches: (p) => expect(p.result.entries.length).toBeGreaterThan(0),
    storeReads: ['searchRecallEntries', 'physicsParticles'],
  },
  {
    name: 'query without physics',
    opts: { q: 'rollout' },
    physicsOff: true,
    reaches: (p) => expect(p.result.entries.length).toBeGreaterThan(0),
    storeReads: ['searchRecallEntries', 'nearestEntries'],
  },
  {
    name: 'query cut to nothing, which still writes a trace',
    opts: { q: 'rollout', exactScope: 'team:eng', limit: 0 },
    reaches: (p) => {
      expect(p.result).toEqual({ entries: [], tokens: 0 });
      expect(p.rows.local.traces).toEqual([expect.objectContaining({ result_count: 0, pipeline: 'context' })]);
    },
  },
  {
    name: 'pinned only, with recent rows and prompt recall',
    opts: { pinnedOnly: true, includeRecent: 5, prompt: 'what is the rule for billing deploys on fridays' },
    reaches: (p) => expect(p.result.entries.some((e) => e.entry.pinned)).toBe(true),
    storeReads: ['ambientCandidates'],
  },
  {
    name: 'shared store, member keyed by owner',
    opts: {},
    actor: ALICE,
    shared: true,
    reaches: (p) => {
      expect(p.result.activeSnapshot?.task).toBe('alice task, newer id');
      expect(p.result.sessionHandoff?.summary).toBe('alice handoff');
    },
  },
  { name: 'shared store, member across projects', opts: { crossProject: true, q: 'rollout' }, actor: ALICE, shared: true },
  {
    name: 'second tenant, pinned only, whose stale snapshot leaves an unfinished handoff',
    opts: { pinnedOnly: true, includeRecent: 3 },
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
  readonly files: readonly (readonly [string, string])[];
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

/** Every file beside hippo.db, such as the task mirrors and stats.json, with its text. */
function filesOf(root: string): [string, string][] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('hippo.db'))
    .map((d): [string, string] => {
      const file = join(d.parentPath, d.name);
      return [relative(root, file).replace(/\\/g, '/'), readFileSync(file, 'utf8')];
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The files a run added or changed beside hippo.db; the seeded memory mirrors would only bloat the golden. */
function writtenFiles(root: string, template: string): [string, string][] {
  const seeded = new Map(filesOf(template));
  return filesOf(root).filter(([name, text]) => seeded.get(name) !== text);
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
    const template = embedded ? templates.vectors : templates.local;
    cpSync(template, root, { recursive: true });
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
      files: writtenFiles(root, template),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const goldenFile = (c: Case): string => `./fixtures/context-store-path/${c.name.replace(/[^a-z0-9]+/gi, '-')}.json`;
const asJson = (pass: Pass): string => `${JSON.stringify(pass, null, 2)}\n`;

// The goldens were written by this describe on the code before getContext read through the store; `vitest -u` rewrites them.
describe('getContext on hippo.db matches the golden, with and without the sqliteStore store path', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const direct = await runPass(c, { withGlobal: true, embedded: false });
    c.reaches?.(direct);
    // SQLite's bm25() calls the platform's log(), whose last bit differs on macOS, so the golden holds rounded numbers.
    await expect(asJson(rounded(direct))).toMatchFileSnapshot(goldenFile(c));
    const viaStore = await runPass(c, { withGlobal: true, embedded: false }, sqliteStore);
    expect(asJson(viaStore)).toBe(asJson(direct));
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
