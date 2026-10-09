// Recall's vector arm on a store other than hippo.db: an in-memory store with the vector reads must give the replies, ids and rows
// hippo.db gives, over GET /v1/memories and MCP hippo_recall, with a local hashed-embedding server as the provider.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, __resetSessionRecallHistoryHttp, sqliteStore, type VectorCandidateSpec, type VectorReads } from '../src/server.js';
import { markSharedStore } from '../src/config.js';
import { __resetSessionRecallHistoryMcp } from '../src/mcp/server.js';
import { lastRecalledIds } from '../src/mcp/session-state.js';
import { _resetAblationCacheForTests } from '../src/ablation.js';
import { closeHippoDb, openHippoDb, setMeta } from '../src/db.js';
import { embeddingIndexIdentity } from '../src/embeddings.js';
import { resetLogOnce } from '../src/log.js';
import type { MemoryEntry } from '../src/memory.js';
import { resetAllPhysicsState } from '../src/physics-state.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { initStore } from '../src/store/open.js';
import { EMBEDDING_MODEL_META_KEY, upsertVectors } from '../src/vector-store.js';
import { CLEARED_ENV, FAKE_NOW, freshStore, normalise, rowsOf, seeded, sendRecall, type Templates } from './_helpers/recall-golden-seed.js';
import { hashedVector, startHashedEmbeddings, type HashedEmbeddings } from './_helpers/hashed-embedding-server.js';
import { inMemoryVectorStore } from './_helpers/in-memory-vector-store.js';

const MODEL = 'hashed-16';
const IDENTITY = embeddingIndexIdentity(`openai:${MODEL}`);
const QUERY = 'deploy';
const NEAR = hashedVector(QUERY);
const TIE = hashedVector('redeploy cadence');
const ORPHAN = 'mem_x_orphan';
const VECTOR_ONLY = 'mem_v_redeploy';
// A shared store refuses an MCP recall that names no project; the seeded rows are user-global, so any project reaches them.
const PROJECT = 'golden';

interface SeedRow { readonly entry: MemoryEntry; readonly vector: readonly number[] }

const seedRow = (id: string, content: string, day: number, vector: readonly number[], extra: Partial<MemoryEntry> = {}): SeedRow =>
  ({ entry: seeded(content, id, `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`, extra), vector });
const ownRow = (id: string, content: string, day: number): SeedRow => seedRow(id, content, day, hashedVector(content));

// No 'deploy' token in the mem_v_ rows, so only the vector arm can bring them in.
const ADMITTED: readonly SeedRow[] = [
  ownRow('mem_l_api', 'deploy the api with a blue green rollout', 2),
  ownRow('mem_l_freeze', 'deploy freeze on fridays for billing', 3),
  seedRow('mem_l_8d', 'deploy notes indexed by the same model at 8 dims', 4, [1, 2, 3, 4, 5, 6, 7, 8].map((x) => x / 14.282856857085701)),
  seedRow('mem_l_zero', 'deploy checklist with an all zero vector', 5, Array.from({ length: 16 }, () => 0)),
  ownRow(VECTOR_ONLY, 'redeploying the api after the outage', 6),
  seedRow('mem_v_tie_a', 'gateway cadence one', 7, TIE),
  seedRow('mem_v_tie_b', 'gateway cadence two', 8, TIE),
  ownRow('mem_v_noise', 'lunch menu near the office', 9),
];
// Each sits at cosine 1 from the query; 50 rows of another tenant fill the top 50 unless the filter runs before the cut.
const HIDDEN: readonly SeedRow[] = [
  seedRow('mem_x_archived', 'archived rollout plan', 10, NEAR, { kind: 'archived' }),
  seedRow('mem_x_superseded', 'old rollout plan', 11, NEAR, { superseded_by: 'mem_l_api' }),
  seedRow('mem_x_private', 'private rollout token', 12, NEAR, { scope: 'slack:private:C1' }),
  ...Array.from({ length: 50 }, (_, i) => seedRow(`mem_o_${String(i).padStart(2, '0')}`, QUERY, 13, NEAR, { tenantId: 'other' })),
];
const HIDDEN_IDS = [...HIDDEN.map((r) => r.entry.id), ORPHAN];

function withDb(root: string, fn: (db: ReturnType<typeof openHippoDb>) => void): void {
  const db = openHippoDb(root);
  try {
    fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function seedVectorStore(root: string): void {
  initStore(root);
  const rows = [...ADMITTED, ...HIDDEN];
  for (const r of rows) writeEntry(root, r.entry);
  const index = Object.fromEntries(rows.map((r): [string, number[]] => [r.entry.id, [...r.vector]]));
  const vectors: [string, readonly number[]][] = [...Object.entries(index), [ORPHAN, NEAR]];
  withDb(root, (db) => {
    upsertVectors(db, vectors, IDENTITY);
    setMeta(db, EMBEDDING_MODEL_META_KEY, IDENTITY);
    resetAllPhysicsState(db, ADMITTED.map((r) => r.entry), index, new Date(FAKE_NOW));
    // A row with a vector and no particle ranks in physics' classic pool, as the 8-dim particle does.
    db.prepare('DELETE FROM memory_physics WHERE memory_id = ?').run('mem_l_zero');
    db.prepare('UPDATE memories SET updated_at = ?').run('2026-02-01 00:00:00');
  });
}

interface Call { readonly via: 'http' | 'mcp'; readonly args: Readonly<Record<string, string>> }
interface Reply { status: number; body: unknown }
interface Pass { replies: Reply[]; mcpIds: string[][]; rows: ReturnType<typeof rowsOf>; requests: number; log: string; calls: string[] }

const http = (mode: string): Call => ({ via: 'http', args: { q: QUERY, mode, limit: '20' } });
const MCP: Call = { via: 'mcp', args: { query: QUERY } };

const send = (url: string, call: Call): Promise<Reply> => sendRecall(url, call.via, call.args, PROJECT);

function shownIds(pass: Pass): string[] {
  // SAFETY: a GET /v1/memories reply is a serialised RecallResult; an MCP reply has no results field.
  const http = pass.replies.flatMap((r) => (r.body as { results?: { id: string }[] }).results?.map((x) => x.id) ?? []);
  return [...http, ...pass.mcpIds.flat()];
}

let templates: Templates;
let embeddings: HashedEmbeddings;

/** One recall run on a fresh copy, on hippo.db or on the in-memory store, with every module-level ring, cache and once-key cleared. */
async function runPass(calls: readonly Call[], physics: boolean, inMemory: boolean, prepare?: (root: string) => void): Promise<Pass> {
  __resetSessionRecallHistoryHttp();
  __resetSessionRecallHistoryMcp();
  _resetAblationCacheForTests();
  lastRecalledIds.clear();
  resetLogOnce();
  const s = freshStore(templates, 'local');
  const lines: string[] = [];
  try {
    const embeddingsConfig = { provider: 'openai', model: MODEL, apiBaseUrl: embeddings.url };
    writeFileSync(join(s.root, 'config.json'), JSON.stringify({ embeddings: embeddingsConfig, physics: { enabled: physics } }));
    prepare?.(s.root);
    // serve() marks a port store's root shared, so the hippo.db pass must be shared too to compare like with like.
    markSharedStore(s.root);
    const memory = inMemory ? inMemoryVectorStore(s.root) : undefined;
    const before = embeddings.requests();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const handle = await serve({ hippoRoot: s.root, port: 0, store: memory?.store });
    const replies: Reply[] = [];
    const mcpIds: string[][] = [];
    try {
      for (const call of calls) {
        replies.push(await send(handle.url, call));
        if (call.via === 'mcp') mcpIds.push([...lastRecalledIds.values()].flat());
      }
    } finally {
      await handle.stop();
      await memory?.store.close();
      stderr.mockRestore();
    }
    const requests = embeddings.requests() - before;
    return normalise({ replies, mcpIds, rows: rowsOf(s.root), requests, log: lines.join(''), calls: memory?.calls ?? [] }, s);
  } finally {
    rmSync(s.home, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  embeddings = await startHashedEmbeddings();
  const dir = mkdtempSync(join(tmpdir(), 'hippo-vector-reads-'));
  seedVectorStore(join(dir, 'local'));
  initStore(join(dir, 'global'));
  templates = { dir, goalId: 'no-goal-in-this-seed' };
});

afterAll(async () => {
  await embeddings.close();
  rmSync(templates.dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of CLEARED_ENV) vi.stubEnv(k, '');
  vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  vi.stubEnv('HIPPO_V1_RPS', '0');
  vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret');
});

afterEach(() => {
  embeddings.setStatus(200);
  vi.unstubAllEnvs();
  _resetAblationCacheForTests();
});

describe('recall through the vector reads of a store other than hippo.db', () => {
  it.each([
    ['GET /v1/memories mode=hybrid', [http('hybrid')], false, 'nearestEntries'],
    ['GET /v1/memories mode=physics', [http('physics')], true, 'physicsParticles'],
    ['MCP hippo_recall, hybrid', [MCP], false, 'nearestEntries'],
    ['MCP hippo_recall, physics', [MCP], true, 'physicsParticles'],
  ] as const)('%s: same ids in the same order, same rows written, same provider calls', async (_name, calls, physics, read) => {
    const onHippoDb = await runPass(calls, physics, false);
    const onMemory = await runPass(calls, physics, true);
    expect(onMemory.replies).toEqual(onHippoDb.replies);
    expect(onMemory.mcpIds).toEqual(onHippoDb.mcpIds);
    expect(onMemory.rows).toEqual(onHippoDb.rows);
    expect(onMemory.requests).toBe(onHippoDb.requests);
    expect(onMemory.calls).toContain(read);
    // hippo.db's own reply shows the vector arm ran: a row no query word matches is in it, and no filtered row is.
    const shown = shownIds(onHippoDb);
    expect(onHippoDb.replies.every((r) => r.status === 200)).toBe(true);
    expect(onHippoDb.requests).toBeGreaterThan(0);
    expect(shown).toContain(VECTOR_ONLY);
    expect(shown.filter((id) => HIDDEN_IDS.includes(id))).toEqual([]);
  }, 60_000);
});

describe('when the vector arm cannot run, both stores fall back to BM25 alike', () => {
  const emptyIndex = (root: string): void => withDb(root, (db) => db.exec('DELETE FROM memory_vectors; DELETE FROM memory_physics;'));
  const staleModel = (root: string): void => withDb(root, (db) => setMeta(db, EMBEDDING_MODEL_META_KEY, embeddingIndexIdentity('openai:old-model')));

  // Physics embeds the query before it reads the index, so an empty index still costs it one call; hybrid spends none.
  it.each([
    ['an empty index under a stored model', emptyIndex, 200, 'hybrid', 0],
    ['an empty index under a stored model', emptyIndex, 200, 'physics', 1],
    ['an index built by another model', staleModel, 200, 'hybrid', 0],
    ['an index built by another model', staleModel, 200, 'physics', 0],
    ['a provider that answers 500', undefined, 500, 'hybrid', 3],
    ['a provider that answers 500', undefined, 500, 'physics', 6],
  ] as const)('%s, mode=%s', async (_name, prepare, status, mode, requests) => {
    embeddings.setStatus(status);
    const onHippoDb = await runPass([http(mode)], true, false, prepare);
    const onMemory = await runPass([http(mode)], true, true, prepare);
    expect(onMemory.replies).toEqual(onHippoDb.replies);
    expect(onMemory.rows).toEqual(onHippoDb.rows);
    expect([onHippoDb.requests, onMemory.requests]).toEqual([requests, requests]);
    expect(onHippoDb.replies[0]!.status).toBe(200);
    expect(shownIds(onHippoDb)).not.toContain(VECTOR_ONLY);
  }, 60_000);

  it('a stale index names the rebuild each store needs', async () => {
    const onHippoDb = await runPass([http('hybrid')], false, false, staleModel);
    const onMemory = await runPass([http('hybrid')], false, true, staleModel);
    expect(onHippoDb.log).toContain("is being rebuilt; run 'hippo embed' ts=");
    expect(onMemory.log).toContain("run 'hippo embed' on the SQLite store, then rebuild the 'in-memory' database from it");
  }, 60_000);
});

describe('the in-memory vector reads answer as sqliteStore does', () => {
  let sqlite: VectorReads;
  let memory: VectorReads;

  beforeAll(() => {
    const root = join(templates.dir, 'local');
    sqlite = sqliteStore(root).vectors;
    memory = inMemoryVectorStore(root).store.vectors;
  });

  const ids = async (reads: VectorReads, q: readonly number[], spec: VectorCandidateSpec): Promise<string[]> =>
    (await reads.nearestEntries(q, spec)).map((e) => e.id);

  it.each([
    ['tenant, default-deny scope, current rows', NEAR, { tenantId: 'default', scope: { mode: 'default-deny' }, includeSuperseded: false }],
    ['superseded rows kept', NEAR, { tenantId: 'default', includeSuperseded: true }],
    ['a private scope asked for exactly', NEAR, { tenantId: 'default', scope: { mode: 'exact', value: 'slack:private:C1' }, includeSuperseded: false }],
    ['an origin filter', NEAR, { tenantId: 'default', includeSuperseded: false, origin: ['no-such-project'] }],
    ['no tenant, a 51-way tie cut at 5', NEAR, { includeSuperseded: false, limit: 5 }],
    ['a two-way tie cut at 1', TIE, { tenantId: 'default', includeSuperseded: false, limit: 1 }],
  ] as const)('nearestEntries: %s', async (_name, q, spec) => {
    expect(await ids(memory, q, spec)).toEqual(await ids(sqlite, q, spec));
  });

  it('a tie at the cut goes to the smaller id on both', async () => {
    const spec = { tenantId: 'default', includeSuperseded: false, limit: 1 };
    expect(await ids(sqlite, TIE, spec)).toEqual(['mem_v_tie_a']);
    expect(await ids(sqlite, NEAR, { includeSuperseded: false, limit: 2 })).toEqual(['mem_o_00', 'mem_o_01']);
  });

  it('storedVectors, embeddingIndexState and physicsParticles', async () => {
    const some = ['mem_l_8d', 'mem_l_api', 'mem_l_zero', ORPHAN, 'mem_missing'];
    expect(await memory.storedVectors(some)).toEqual(await sqlite.storedVectors(some));
    expect((await sqlite.storedVectors(some)).get('mem_l_8d')).toHaveLength(8);
    expect(await memory.embeddingIndexState()).toEqual(await sqlite.embeddingIndexState());
    expect(await memory.physicsParticles(some)).toEqual(await sqlite.physicsParticles(some));
    expect([(await sqlite.physicsParticles([])).size, (await memory.physicsParticles([])).size]).toEqual([0, 0]);
  });
});
