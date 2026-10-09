// embedAll and embedMemory with a store embed through its vectorWrites group, never opening hippo.db in hippoRoot,
// and through hippo.db's own store they leave the same index, model and particles as the path without a store.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetAblationCacheForTests } from '../src/core/ablation.js';
import { closeHippoDb, getMeta, openHippoDb, withSqliteBlocked } from '../src/db/index.js';
import { StoreNotPortedError } from '../src/util/sqlite-blocked.js';
import type { EmbeddingProvider } from '../src/store/embeddings/provider.js';
import { embedAll, embeddingIndexIdentity, embeddingInputText, embedMemory } from '../src/store/embeddings/index.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../src/core/memory.js';
import { loadPhysicsState } from '../src/db/physics-state.js';
import { OTHER_STORE_MARKER, sqliteStore, type HippoStore, type PhysicsParticle } from '../src/server.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { initStore } from '../src/store/open.js';
import { EMBEDDING_MODEL_META_KEY } from '../src/db/vector-store.js';
import { hashedVector, startHashedEmbeddings, type HashedEmbeddings } from './_helpers/hashed-embedding-server.js';
import { inMemoryVectorWritesStore } from './_helpers/in-memory-vector-writes-store.js';
import { portOnlyStore, portOnlyStoreWithoutVectorReads } from './_helpers/port-only-store.js';
import { seedTwoTenants, TENANT_A, TENANT_B, type TwoTenantFixture } from './_helpers/store-conformance.js';

// Particles weigh a memory by its age, so seeded rows are dated before the fixed clock the embeds run at.
const SEEDED_AT = '2026-01-15T00:00:00.000Z';
const FAKE_NOW = '2026-03-01T12:00:00.000Z';
const HASHED_MODEL = embeddingIndexIdentity('openai:hashed-16');
let fixture: TwoTenantFixture;
let oldIndexed: string;
let home: string;
let embeddings: HashedEmbeddings;
let n = 0;
let seeded: MemoryEntry[] = [];

const vectorsFor = (id: string, texts: string[]): number[][] => texts.map((t) => (t.includes('unembeddable') ? [] : hashedVector(`${id} ${t}`)));

function provider(id: string, embed: EmbeddingProvider['embed'] = async (texts) => vectorsFor(id, texts)): EmbeddingProvider {
  return { kind: 'local', model: id, id, isAvailable: () => true, embed };
}

function copyOf(from: string = fixture.dir): string {
  const root = join(home, `copy-${++n}`);
  cpSync(from, root, { recursive: true });
  return root;
}

interface ConfigFile {
  readonly embeddings: { readonly provider: string; readonly model: string; readonly apiBaseUrl: string };
}

/** Everything an embed run leaves in hippo.db's vector index: rows with their model and bytes, the model meta row, and particles. */
interface HippoDbIndex {
  readonly vectors: unknown[];
  readonly model: string;
  readonly particles: [string, PhysicsParticle][];
}

/** A folder whose marker names another store, so a hippo.db open in it throws and creates nothing. */
function markedFolder(config?: ConfigFile): string {
  const root = join(home, `marked-${++n}`);
  mkdirSync(root);
  writeFileSync(join(root, OTHER_STORE_MARKER), 'in-memory\n');
  if (config) writeFileSync(join(root, 'config.json'), JSON.stringify(config));
  return root;
}

function hashedConfig(): ConfigFile {
  return { embeddings: { provider: 'openai', model: 'hashed-16', apiBaseUrl: embeddings.url } };
}

function indexOn(root: string): HippoDbIndex {
  const db = openHippoDb(root);
  try {
    return {
      vectors: db.prepare('SELECT memory_id, model, dim, hex(vector) AS bytes FROM memory_vectors ORDER BY memory_id').all(),
      model: getMeta(db, EMBEDDING_MODEL_META_KEY, ''),
      particles: [...loadPhysicsState(db)].sort(([a], [b]) => (a < b ? -1 : 1)),
    };
  } finally {
    closeHippoDb(db);
  }
}

beforeAll(async () => {
  embeddings = await startHashedEmbeddings();
  home = mkdtempSync(join(tmpdir(), 'hippo-embed-store-'));
  fixture = seedTwoTenants();
  const rows: [string, string][] = [
    [TENANT_A, 'the deploy runbook lives in the ops wiki'], [TENANT_B, 'globex invoices close on the fifth'],
    [TENANT_A, 'unembeddable row the provider gives up on'], [TENANT_B, 'the globex on-call rota sits in the shared drive'],
    [TENANT_A, 'rotate the staging keys every quarter'],
  ];
  seeded = rows.map(([tenantId, content]) => ({
    ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId }), created: SEEDED_AT, last_retrieved: SEEDED_AT,
  }));
  for (const entry of seeded) writeEntry(fixture.dir, entry);
  oldIndexed = copyOf();
  await embedAll(oldIndexed, undefined, provider('fake-old'));
});

afterAll(async () => {
  await embeddings.close();
  rmSync(fixture.dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
  vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret');
  _resetAblationCacheForTests();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetAblationCacheForTests();
});

describe('embedAll with a store', () => {
  it("embeds every tenant's memories through vectorWrites and leaves hippoRoot holding only its marker", async () => {
    const hippoRoot = markedFolder();
    const memory = inMemoryVectorWritesStore(copyOf());
    const run = (): Promise<number> => withSqliteBlocked(memory.store.kind, () => embedAll(hippoRoot, undefined, provider('fake-a'), memory.store));
    expect(await run()).toBe(4);
    expect(readdirSync(hippoRoot)).toEqual([OTHER_STORE_MARKER]);
    expect(await run()).toBe(0);
    const left = await memory.store.vectorWrites.entriesWithoutVector({ model: embeddingIndexIdentity('fake-a'), limit: 500 });
    expect(left.map((e) => e.content)).toEqual(['unembeddable row the provider gives up on']);
    const [a] = seeded;
    expect((await memory.store.vectors.storedVectors([a.id])).get(a.id)).toEqual(hashedVector(`fake-a ${embeddingInputText(a)}`).map(Math.fround));
  });

  it.each([
    { name: 'a first backfill', template: (): string => copyOf(), id: 'fake-a' },
    { name: 'a model change, which rebuilds the index and every particle', template: (): string => copyOf(oldIndexed), id: 'fake-new' },
  ])('leaves hippo.db as the no-store path does on $name', async ({ template, id }) => {
    const [plain, viaStore] = [template(), template()];
    const counts = [await embedAll(plain, undefined, provider(id)), await embedAll(viaStore, undefined, provider(id), sqliteStore(viaStore))];
    expect(counts).toEqual([4, 4]);
    const expected = indexOn(plain);
    expect(indexOn(viaStore)).toEqual(expected);
    expect(expected.model).toBe(embeddingIndexIdentity(id));
  });

  it('keeps the pages written before the provider fails, and the next run finishes the rest', async () => {
    const root = join(home, `paged-${++n}`);
    initStore(root);
    for (let i = 0; i < 70; i++) writeEntry(root, createMemory(`paged backfill memory number ${i}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    let calls = 0;
    const flaky = provider('fake-a', async (texts) => {
      calls += 1;
      if (calls === 2) throw new Error('provider down');
      return vectorsFor('fake-a', texts);
    });
    await expect(embedAll(root, undefined, flaky, sqliteStore(root))).rejects.toThrow('provider down');
    expect(indexOn(root).vectors).toHaveLength(64);
    expect(await embedAll(root, undefined, flaky, sqliteStore(root))).toBe(6);
    expect(indexOn(root).vectors).toHaveLength(70);
  });

  it('stops with an error, keeping the other index, when another process rebuilds under its own model mid-run', async () => {
    const memory = inMemoryVectorWritesStore(copyOf());
    const [first] = seeded;
    const other = embeddingIndexIdentity('fake-other');
    const racing = provider('fake-a', async (texts) => {
      await memory.store.vectorWrites.writeVectors({ tenantId: first.tenantId, model: other, replaceIndex: true, rows: [{ memoryId: first.id, vector: [1, 0] }] });
      return vectorsFor('fake-a', texts);
    });
    const running = withSqliteBlocked(memory.store.kind, () => embedAll(markedFolder(), undefined, racing, memory.store));
    await expect(running).rejects.toThrow("the vector index was built by another embedding model; run 'hippo embed' to rebuild it");
    expect(await memory.store.vectors.embeddingIndexState()).toEqual({ storedModel: other, hasVectors: true });
    expect([...(await memory.store.vectors.storedVectors(seeded.map((e) => e.id))).keys()]).toEqual([first.id]);
  });

  it('rejects with StoreNotPortedError on a store without vectorWrites, and writes nothing', async () => {
    const storeRoot = copyOf();
    const before = indexOn(storeRoot);
    const running = embedAll(markedFolder(), undefined, provider('fake-a'), portOnlyStore(storeRoot));
    await expect(running).rejects.toThrow(StoreNotPortedError);
    await expect(running).rejects.toThrow("the 'port-only' store has no 'vectorWrites' group");
    expect(indexOn(storeRoot)).toEqual(before);
  });
});

describe('embedMemory with a store', () => {
  it('stores the vector and a first particle through the store, opening no hippo.db', async () => {
    const hippoRoot = markedFolder(hashedConfig());
    const memory = inMemoryVectorWritesStore(copyOf());
    const entry = seeded[1];
    await withSqliteBlocked(memory.store.kind, () => embedMemory(hippoRoot, entry, undefined, memory.store));
    expect(readdirSync(hippoRoot).sort()).toEqual(['config.json', OTHER_STORE_MARKER]);
    const expected = hashedVector(embeddingInputText(entry)).map(Math.fround);
    expect((await memory.store.vectors.storedVectors([entry.id])).get(entry.id)).toEqual(expected);
    expect((await memory.store.vectors.physicsParticles([entry.id])).get(entry.id)).toMatchObject({ memoryId: entry.id, position: expected, lastSimulation: FAKE_NOW });
    expect(await memory.store.vectors.embeddingIndexState()).toEqual({ storedModel: HASHED_MODEL, hasVectors: true });
  });

  it.each([
    { name: 'it reads that', stale: false, asked: 0 },
    { name: 'its read predates that rebuild', stale: true, asked: 1 },
  ])("leaves every tenant's vectors to embedAll when another model built the index and $name", async ({ stale, asked }) => {
    const memory = inMemoryVectorWritesStore(copyOf(oldIndexed));
    const staleVectors = { ...memory.store.vectors, embeddingIndexState: async () => ({ storedModel: HASHED_MODEL, hasVectors: true }) };
    const store: HippoStore = stale ? { ...memory.store, vectors: staleVectors } : memory.store;
    const ids = seeded.map((e) => e.id);
    const [before, requests] = [await memory.store.vectors.storedVectors(ids), embeddings.requests()];
    await withSqliteBlocked(memory.store.kind, () => embedMemory(markedFolder(hashedConfig()), seeded[0], undefined, store));
    expect(embeddings.requests() - requests).toBe(asked);
    expect(await memory.store.vectors.storedVectors(ids)).toEqual(before);
    expect(before.size).toBe(4);
    expect(await memory.store.vectors.embeddingIndexState()).toEqual({ storedModel: embeddingIndexIdentity('fake-old'), hasVectors: true });
  });

  it('resolves and logs the skip on a store without the vector groups', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const store: HippoStore = portOnlyStoreWithoutVectorReads(copyOf());
    await expect(embedMemory(markedFolder(hashedConfig()), seeded[0], undefined, store)).resolves.toBeUndefined();
    expect(lines.join('')).toContain(`skipped embedding ${seeded[0].id} (the 'port-only' store has no 'vectors' group`);
  });
});
