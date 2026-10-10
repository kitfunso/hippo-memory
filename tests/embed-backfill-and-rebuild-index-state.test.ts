// embedAll and embedMemory on hippo.db with no store: the vectors, model identity and particles a backfill and a model-change rebuild leave.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetAblationCacheForTests } from '../src/core/ablation.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../src/core/memory.js';
import type { PhysicsParticle } from '../src/core/physics.js';
import { closeHippoDb, getMeta, openHippoDb } from '../src/db/index.js';
import { initializeParticle, loadPhysicsState, savePhysicsState } from '../src/db/physics-state.js';
import { EMBEDDING_MODEL_META_KEY } from '../src/db/vector-store.js';
import { embedAll, embeddingIndexIdentity, embeddingInputText, embedMemory } from '../src/store/embeddings/index.js';
import type { EmbeddingProvider } from '../src/embeddings/provider.js';
import { loadAllEntries, loadAllEntryIds } from '../src/store/entry-reads.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { initStore } from '../src/store/open.js';
import { MEMORY_SELECT_COLUMNS } from '../src/store/rows.js';
import { loadEmbeddingIndex, resetStoredParticles } from '../src/store/vector-index.js';
import { recordStatements, recordStatementsAsync } from './_helpers/count-statements.js';
import { hashedVector, startHashedEmbeddings, type HashedEmbeddings } from './_helpers/hashed-embedding-server.js';

const SEEDED_AT = '2026-01-15T00:00:00.000Z';
const FAKE_NOW = '2026-03-01T12:00:00.000Z';
const TENANTS = ['tenant-a', 'tenant-b'];
const ROWS = 300;
const HASHED_ID = 'openai:hashed-16';
const SLOW = 120_000;
const PAGE = 64;

let home: string;
let embeddings: HashedEmbeddings;
/** 180 rows indexed by `fake-old`, 120 rows with no vector. */
let partly: string;
/** Every row indexed by `fake-old`, each with a particle dated SEEDED_AT. */
let indexedOld: string;
let n = 0;

interface VectorRow { memory_id: string; model: string; dim: number; bytes: string }

/** Everything an embed run leaves in hippo.db's vector index; vectors are in the order they were inserted. */
interface IndexState {
  readonly vectors: VectorRow[];
  readonly model: string;
  readonly particles: PhysicsParticle[];
}

const fakeVector = (id: string, entry: MemoryEntry): number[] => hashedVector(`${id} ${embeddingInputText(entry)}`);
const hashedServerVector = (entry: MemoryEntry): number[] => hashedVector(embeddingInputText(entry));
// The index of the 120 rows written after the first backfill, spread through the store's order and both tenants.
const isLate = (i: number): boolean => i % 5 < 2;

function fake(id: string, onCall: (texts: string[]) => void = () => undefined): EmbeddingProvider {
  const embed: EmbeddingProvider['embed'] = async (texts) => {
    onCall(texts);
    return texts.map((t) => hashedVector(`${id} ${t}`));
  };
  return { kind: 'local', model: id, id, isAvailable: () => true, embed };
}

function row(i: number): MemoryEntry {
  // Three rows share each minute, so order inside a tie is id order and a read ordered by content would differ.
  const created = new Date(Date.parse(SEEDED_AT) + Math.floor(i / 3) * 60_000).toISOString();
  const options = { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tenantId: TENANTS[i % 2], tags: [`topic:${i % 7}`, `path:/work/site-${i}`] };
  return { ...createMemory(`index state memory ${ROWS - i} about release ${i % 11}`, options), created, last_retrieved: created };
}

function copyOf(from: string): string {
  const root = join(home, `copy-${++n}`);
  cpSync(from, root, { recursive: true });
  return root;
}

function useHashedServer(root: string): void {
  writeFileSync(join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: 'hashed-16', apiBaseUrl: embeddings.url } }));
}

function indexOn(root: string): IndexState {
  const db = openHippoDb(root);
  try {
    return {
      // SAFETY: the SELECT names exactly VectorRow's four fields.
      vectors: db.prepare('SELECT memory_id, model, dim, hex(vector) AS bytes FROM memory_vectors ORDER BY rowid').all() as VectorRow[],
      model: getMeta(db, EMBEDDING_MODEL_META_KEY, ''),
      particles: [...loadPhysicsState(db).values()].sort((a, b) => (a.memoryId < b.memoryId ? -1 : 1)),
    };
  } finally {
    closeHippoDb(db);
  }
}

function vectorRow(entry: MemoryEntry, model: string, vector: number[]): VectorRow {
  return { memory_id: entry.id, model, dim: vector.length, bytes: Buffer.from(Float32Array.from(vector).buffer).toString('hex').toUpperCase() };
}

function particleOf(entry: MemoryEntry, vector: number[], at: string): PhysicsParticle {
  return { ...initializeParticle(entry, vector, new Date(at)), position: vector.map(Math.fround) };
}

/** The state a rebuild under `providerId` must leave: every row in store order, each with a particle dated FAKE_NOW. */
function rebuiltState(root: string, providerId: string, vectorOf: (entry: MemoryEntry) => number[]): IndexState {
  const entries = loadAllEntries(root);
  const model = embeddingIndexIdentity(providerId);
  return {
    vectors: entries.map((e) => vectorRow(e, model, vectorOf(e))),
    model,
    particles: entries.map((e) => particleOf(e, vectorOf(e), FAKE_NOW)).sort((a, b) => (a.memoryId < b.memoryId ? -1 : 1)),
  };
}

beforeAll(async () => {
  embeddings = await startHashedEmbeddings();
  home = mkdtempSync(join(tmpdir(), 'hippo-embed-index-state-'));
  partly = join(home, 'partly');
  initStore(partly);
  const rows = Array.from({ length: ROWS }, (_, i) => row(i));
  rows.forEach((entry, i) => { if (!isLate(i)) writeEntry(partly, entry); });
  await embedAll(partly, undefined, fake('fake-old'));
  rows.forEach((entry, i) => { if (isLate(i)) writeEntry(partly, entry); });

  indexedOld = copyOf(partly);
  await embedAll(indexedOld, undefined, fake('fake-old'));
  const db = openHippoDb(indexedOld);
  try {
    savePhysicsState(db, loadAllEntries(indexedOld).map((e) => initializeParticle(e, fakeVector('fake-old', e), new Date(SEEDED_AT))));
  } finally {
    closeHippoDb(db);
  }
}, SLOW);

afterAll(async () => {
  await embeddings.close();
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

describe('embedAll backfill on hippo.db', () => {
  it('embeds exactly the 120 rows with no vector, 64 at a time in store order, and leaves the other 180 vectors alone', async () => {
    const root = copyOf(partly);
    const before = indexOn(root);
    const entries = loadAllEntries(root);
    const embedded = new Set(before.vectors.map((v) => v.memory_id));
    const pending = entries.filter((e) => !embedded.has(e.id));
    expect([entries.length, before.vectors.length, pending.length]).toEqual([ROWS, 180, 120]);
    expect(new Set(pending.map((e) => e.tenantId))).toEqual(new Set(TENANTS));

    const calls: string[][] = [];
    expect(await embedAll(root, undefined, fake('fake-old', (texts) => calls.push(texts)))).toBe(120);

    expect(calls.map((texts) => texts.length)).toEqual([64, 56]);
    expect(calls.flat()).toEqual(pending.map((e) => embeddingInputText(e)));
    const model = embeddingIndexIdentity('fake-old');
    expect(indexOn(root)).toEqual({
      vectors: [...before.vectors, ...pending.map((e) => vectorRow(e, model, fakeVector('fake-old', e)))],
      model,
      particles: [],
    });
  }, SLOW);

  it('embeds nothing on a second run', async () => {
    const root = copyOf(indexedOld);
    const before = indexOn(root);
    const calls: string[][] = [];
    expect(await embedAll(root, undefined, fake('fake-old', (texts) => calls.push(texts)))).toBe(0);
    expect(calls).toEqual([]);
    expect(indexOn(root)).toEqual(before);
  }, SLOW);
});

describe('a model identity change on hippo.db', () => {
  it("embedAll rebuilds every tenant's vectors under the new model, saves its identity and resets every particle", async () => {
    const root = copyOf(indexedOld);
    expect(indexOn(root).particles.map((p) => p.lastSimulation)).toEqual(Array.from({ length: ROWS }, () => SEEDED_AT));
    expect(await embedAll(root, undefined, fake('fake-new'))).toBe(ROWS);
    const state = indexOn(root);
    expect(state).toEqual(rebuiltState(root, 'fake-new', (e) => fakeVector('fake-new', e)));
    expect([state.vectors.length, state.particles.length]).toEqual([ROWS, ROWS]);
  }, SLOW);

  it('embedAll and embedMemory end in the same state through the configured provider', async () => {
    const [viaAll, viaOne] = [copyOf(indexedOld), copyOf(indexedOld)];
    useHashedServer(viaAll);
    useHashedServer(viaOne);
    expect(await embedAll(viaAll)).toBe(ROWS);
    await embedMemory(viaOne, loadAllEntries(viaOne)[7]);
    const expected = rebuiltState(viaAll, HASHED_ID, hashedServerVector);
    expect(indexOn(viaAll)).toEqual(expected);
    expect(indexOn(viaOne)).toEqual(expected);
  }, SLOW);

  it('keeps the old vectors, identity and particles when the provider fails part way through the rebuild', async () => {
    const root = copyOf(indexedOld);
    const before = indexOn(root);
    const last = embeddingInputText(loadAllEntries(root)[ROWS - 1]);
    const failing = fake('fake-new', (texts) => {
      if (texts.includes(last)) throw new Error('provider down');
    });
    await expect(embedAll(root, undefined, failing)).rejects.toThrow('provider down');
    expect(indexOn(root)).toEqual(before);
    expect(before.model).toBe(embeddingIndexIdentity('fake-old'));
  }, SLOW);
});

/** The most full memory rows one statement of a run can hand back: the length of its id list, or the whole store when it has none. */
function peakFullRowsRead(statements: readonly string[]): number {
  const reads = statements.filter((sql) => sql.includes(MEMORY_SELECT_COLUMNS));
  expect(reads.length).toBeGreaterThan(0);
  return Math.max(...reads.map((sql) => {
    const idList = /\bid IN \(([?,\s]+)\)/.exec(sql);
    return idList ? idList[1].split('?').length - 1 : ROWS;
  }));
}

describe('rows held while embedding hippo.db', () => {
  it.each([
    { name: 'a backfill of 120 rows', template: (): string => partly, id: 'fake-old', embedded: 120 },
    { name: 'a rebuild of 300 rows', template: (): string => indexedOld, id: 'fake-new', embedded: ROWS },
  ])('reads full rows and embeds them at most 64 at a time on $name', async ({ template, id, embedded }) => {
    const root = copyOf(template());
    const calls: number[] = [];
    const log = await recordStatementsAsync(() => embedAll(root, undefined, fake(id, (texts) => calls.push(texts.length))));
    expect(log.result).toBe(embedded);
    expect(Math.max(...calls)).toBe(PAGE);
    expect(peakFullRowsRead(log.statements)).toBe(PAGE);
  }, SLOW);

  it("resets particles from ids for both tenants' embedded rows, reading the rows at most 64 at a time", () => {
    const root = copyOf(partly);
    const ids = loadAllEntryIds(root);
    const index = loadEmbeddingIndex(root);
    const log = recordStatements(() => resetStoredParticles(root, ids, index));
    const { particles } = indexOn(root);
    const tenantOf = new Map(loadAllEntries(root).map((e) => [e.id, e.tenantId]));
    expect([ids.length, log.result, particles.length]).toEqual([ROWS, 180, 180]);
    expect(particles.map((p) => p.memoryId)).toEqual(Object.keys(index).sort());
    expect(new Set(particles.map((p) => tenantOf.get(p.memoryId)))).toEqual(new Set(TENANTS));
    expect(peakFullRowsRead(log.statements)).toBe(PAGE);
  }, SLOW);
});
