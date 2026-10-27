// embedAll and embedMemory with a store embed through its vectorWrites group, never opening hippo.db in hippoRoot,
// and through hippo.db's own store they leave the same index, model and particles as the path without a store.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FailureNotices } from '../../src/base/util/failure-notices.js';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { PRODUCTION_STRENGTH, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeHippoDb, getMeta, openHippoDb } from '../../src/db/index.js';
import type { EmbeddingProvider } from '../../src/base/ports/embedder.js';
import { embeddingIndexIdentity, embeddingInputText } from '../../src/base/embeddings/index-identity.js';
import { embedAll, embedMemoryInto, type EmbedTarget } from '../../src/domain/search/embed-memories.js';
import { loadConfig } from '../../src/host/config-file.js';
import { resolveEmbeddingProvider } from '../../src/infra/embedding-provider.js';
import { createMemory } from '../../src/entry/memory.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import { loadAllPhysicsState } from '../../src/db/physics-state.js';
import { OTHER_STORE_MARKER, type PhysicsParticle } from '../../src/entry/store-kit.js';
import type { StoreWith } from '../../src/base/ports/store.js';

// The vector groups an add-on store keeps so its embeds go through vectorWrites.
const VECTOR_GROUPS = ['vectors', 'vectorWrites'] as const;
import { EMBEDDING_MODEL_META_KEY } from '../../src/db/vector-store.js';
import { hashedVector, startHashedEmbeddings, type HashedEmbeddings } from '../_helpers/hashed-embedding-server.js';
import { seedTwoTenants, TENANT_A, TENANT_B, type TwoTenantFixture } from '../_helpers/store-conformance.js';
import { localIndex } from '../_helpers/cli-stores.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';
import { portOnlySide } from '../_helpers/port-only-store.js';
import { copyTree } from '../_helpers/copy-tree.js';
import { evalNow } from '../../src/infra/eval-switches.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { sqliteStore } = sessionPerTest();

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

const vectorsFor = (id: string, texts: string[]): number[][] =>
  texts.map((t) => (t.includes('unembeddable') ? [] : hashedVector(`${id} ${t}`)));

function provider(
  id: string,
  embed: EmbeddingProvider['embed'] = async (texts) => vectorsFor(id, texts),
): EmbeddingProvider {
  return { kind: 'local', model: id, id, isAvailable: () => true, embed };
}

function copyOf(from: string = fixture.dir): string {
  const root = join(home, `copy-${++n}`);
  copyTree(from, root);
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
/** The embed target for `store`, with the provider the folder's config.json names, as a root loads it. */
function on(hippoRoot: string, store: StoreWith<'vectors' | 'vectorWrites'>): EmbedTarget {
  return {
    groups: { vectors: store.vectors, vectorWrites: store.vectorWrites },
    embeddings: loadConfig(hippoRoot).embeddings,
    embedderFor: resolveEmbeddingProvider,
    failureNotices: new FailureNotices(),
    strength: PRODUCTION_STRENGTH,
    clock: evalNow,
  };
}

function markedFolder(config?: ConfigFile): string {
  const root = join(home, `marked-${++n}`);
  mkdirSync(root);
  writeFileSync(join(root, OTHER_STORE_MARKER), 'port-only\n');
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
      vectors: db
        .prepare('SELECT memory_id, model, dim, hex(vector) AS bytes FROM memory_vectors ORDER BY memory_id')
        .all(),
      model: getMeta(db, EMBEDDING_MODEL_META_KEY, ''),
      particles: [...loadAllPhysicsState(db)].sort(([a], [b]) => (a < b ? -1 : 1)),
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
    [TENANT_A, 'the deploy runbook lives in the ops wiki'],
    [TENANT_B, 'globex invoices close on the fifth'],
    [TENANT_A, 'unembeddable row the provider gives up on'],
    [TENANT_B, 'the globex on-call rota sits in the shared drive'],
    [TENANT_A, 'rotate the staging keys every quarter'],
  ];
  seeded = rows.map(([tenantId, content]) => ({
    ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId }),
    created: SEEDED_AT,
    lastRetrieved: SEEDED_AT,
  }));
  writeEntriesTogether(fixture.dir, seeded);
  oldIndexed = copyOf();
  await embedAll(localIndex(oldIndexed), undefined, provider('fake-old'));
});

afterAll(async () => {
  await embeddings.close();
  rmSync(fixture.dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
  vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('embedAll with a store', () => {
  it("embeds every tenant's memories through vectorWrites and leaves hippoRoot holding only its marker", async () => {
    const hippoRoot = markedFolder();
    const side = portOnlySide(copyOf(), VECTOR_GROUPS);
    const run = (): Promise<number> => embedAll(on(hippoRoot, side.store), undefined, provider('fake-a'));
    expect(await run()).toBe(4);
    expect(readdirSync(hippoRoot)).toEqual([OTHER_STORE_MARKER]);
    expect(await run()).toBe(0);
    const left = await side.store.vectorWrites.entriesWithoutVector({
      tenantId: ALL_TENANTS,
      model: embeddingIndexIdentity('fake-a'),
      limit: 500,
    });
    expect(left.map((e) => e.content)).toEqual(['unembeddable row the provider gives up on']);
    const [a] = seeded;
    expect(Array.from((await side.store.vectors.stored('vectors', [a.id])).get(a.id) ?? [])).toEqual(
      hashedVector(`fake-a ${embeddingInputText(a)}`).map(Math.fround),
    );
  });

  it.each([
    { name: 'a first backfill', template: (): string => copyOf(), id: 'fake-a' },
    {
      name: 'a model change, which rebuilds the index and every particle',
      template: (): string => copyOf(oldIndexed),
      id: 'fake-new',
    },
  ])('leaves hippo.db as the no-store path does on $name', async ({ template, id }) => {
    const [plain, viaStore] = [template(), template()];
    const counts = [
      await embedAll(localIndex(plain), undefined, provider(id)),
      await embedAll(on(viaStore, sqliteStore(viaStore)), undefined, provider(id)),
    ];
    expect(counts).toEqual([4, 4]);
    const expected = indexOn(plain);
    expect(indexOn(viaStore)).toEqual(expected);
    expect(expected.model).toBe(embeddingIndexIdentity(id));
  });

  it('keeps the pages written before the provider fails, and the next run finishes the rest', async () => {
    const root = join(home, `paged-${++n}`);
    initTestStore(root);
    writeEntriesTogether(
      root,
      Array.from({ length: 70 }, (_, i) =>
        createMemory(`paged backfill memory number ${i}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
      ),
    );
    let calls = 0;
    const flaky = provider('fake-a', async (texts) => {
      calls += 1;
      if (calls === 2) throw new Error('provider down');
      return vectorsFor('fake-a', texts);
    });
    await expect(embedAll(on(root, sqliteStore(root)), undefined, flaky)).rejects.toThrow('provider down');
    expect(indexOn(root).vectors).toHaveLength(64);
    expect(await embedAll(on(root, sqliteStore(root)), undefined, flaky)).toBe(6);
    expect(indexOn(root).vectors).toHaveLength(70);
  });

  it('stops with an error, keeping the other index, when another process rebuilds under its own model mid-run', async () => {
    const side = portOnlySide(copyOf(), VECTOR_GROUPS);
    const [first] = seeded;
    const other = embeddingIndexIdentity('fake-other');
    const racing = provider('fake-a', async (texts) => {
      await side.store.vectorWrites.writeVectors({
        tenantId: first.tenantId,
        model: other,
        replaceIndex: true,
        rows: [{ memoryId: first.id, vector: [1, 0] }],
      });
      return vectorsFor('fake-a', texts);
    });
    const running = embedAll(on(markedFolder(), side.store), undefined, racing);
    await expect(running).rejects.toThrow(
      "the vector index was built by another embedding model; run 'hippo embed' to rebuild it",
    );
    expect(await side.store.vectors.embeddingIndexState()).toEqual({ storedModel: other, hasVectors: true });
    const left = await side.store.vectors.stored(
      'vectors',
      seeded.map((e) => e.id),
    );
    expect([...left.keys()]).toEqual([first.id]);
  });
});

describe('embedMemory with a store', () => {
  it('stores the vector and a first particle through the store, opening no hippo.db', async () => {
    const hippoRoot = markedFolder(hashedConfig());
    const side = portOnlySide(copyOf(), VECTOR_GROUPS);
    const entry = seeded[1];
    await embedMemoryInto(on(hippoRoot, side.store), entry);
    expect(readdirSync(hippoRoot).sort()).toEqual(['config.json', OTHER_STORE_MARKER]);
    const expected = hashedVector(embeddingInputText(entry)).map(Math.fround);
    expect(Array.from((await side.store.vectors.stored('vectors', [entry.id])).get(entry.id) ?? [])).toEqual(expected);
    expect((await side.store.vectors.stored('particles', [entry.id])).get(entry.id)).toMatchObject({
      memoryId: entry.id,
      position: expected,
      lastSimulation: FAKE_NOW,
    });
    expect(await side.store.vectors.embeddingIndexState()).toEqual({ storedModel: HASHED_MODEL, hasVectors: true });
  });

  it.each([
    { name: 'it reads that', stale: false, asked: 0 },
    { name: 'its read predates that rebuild', stale: true, asked: 1 },
  ])(
    "leaves every tenant's vectors to embedAll when another model built the index and $name",
    async ({ stale, asked }) => {
      const side = portOnlySide(copyOf(oldIndexed), VECTOR_GROUPS);
      const staleVectors = {
        ...side.store.vectors,
        embeddingIndexState: async () => ({ storedModel: HASHED_MODEL, hasVectors: true }),
      };
      const store = stale ? { ...side.store, vectors: staleVectors } : side.store;
      const ids = seeded.map((e) => e.id);
      const [before, requests] = [await side.store.vectors.stored('vectors', ids), embeddings.requests()];
      await embedMemoryInto(on(markedFolder(hashedConfig()), store), seeded[0]);
      expect(embeddings.requests() - requests).toBe(asked);
      expect(await side.store.vectors.stored('vectors', ids)).toEqual(before);
      expect(before.size).toBe(4);
      expect(await side.store.vectors.embeddingIndexState()).toEqual({
        storedModel: embeddingIndexIdentity('fake-old'),
        hasVectors: true,
      });
    },
  );
});
