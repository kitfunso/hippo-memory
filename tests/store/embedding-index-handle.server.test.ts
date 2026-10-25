// The embedding index's session handle on hippo.db, in process and on the store worker: a rebuild staged in steps
// reaches the live index only at its commit, a close drops it, and the lock keeps another thread's session out.
import { afterEach, describe, expect, it } from 'vitest';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { embeddingIndexIdentity } from '../../src/base/embeddings/index-identity.js';
import type { EmbeddingIndex } from '../../src/base/ports/store.js';
import type { EmbeddingIndexState } from '../../src/base/ports/store/vectors.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { workerSqliteStore } from '../../src/store/sqlite/worker-store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';

const OLD = embeddingIndexIdentity('fake-old');
const NEW = embeddingIndexIdentity('fake-new');
// Exact in float32, so a vector read back equals the one written.
const vector = (i: number): number[] => [i, 0.5, 0.25, -1];

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
});

const KINDS = {
  'in process': (root: string): EmbeddingIndex => sqliteStore(root).embeddingIndex,
  'on the store worker': (root: string): EmbeddingIndex => {
    const store = workerSqliteStore(root);
    closing.push(() => store.close());
    return store.embeddingIndex;
  },
} as const;
type Kind = keyof typeof KINDS;

interface Seeded {
  readonly root: string;
  readonly ids: readonly [string, string, string];
}

/** Three memories, the first two with a vector built by OLD. */
async function seeded(): Promise<Seeded> {
  const root = makeRoot('index-handle');
  const entries = ['alpha', 'beta', 'gamma'].map((t) => createMemory(`index handle ${t}`));
  writeEntriesTogether(root, entries);
  const ids = [entries[0]!.id, entries[1]!.id, entries[2]!.id] as const;
  const index = sqliteStore(root).embeddingIndex;
  const { id } = await index.open();
  await index.step(id, {
    kind: 'save',
    rows: [
      [ids[0], vector(1)],
      [ids[1], vector(2)],
    ],
    model: OLD,
  });
  await index.step(id, { kind: 'saveModel', providerId: 'fake-old' });
  await index.step(id, { kind: 'close' });
  return { root, ids };
}

interface Live {
  readonly vectors: Record<string, number[]>;
  readonly state: EmbeddingIndexState;
}

/** The live index as a reader on this thread sees it. */
async function live({ root, ids }: Seeded): Promise<Live> {
  const { vectors } = sqliteStore(root);
  const stored = await vectors.stored('vectors', ids);
  return {
    vectors: Object.fromEntries([...stored].map(([id, v]) => [id, Array.from(v)])),
    state: await vectors.embeddingIndexState(),
  };
}

describe.each<Kind>(['in process', 'on the store worker'])('the embedding index handle %s', (kind) => {
  it('opens a session as plain data, and a close ends that session only', async () => {
    const { root } = await seeded();
    const index = KINDS[kind](root);
    const first = await index.open();
    const second = await index.open();
    expect(structuredClone(first)).toEqual(first);
    expect([second.id === first.id, second.key]).toEqual([false, first.key]);
    await index.step(first.id, { kind: 'close' });
    await expect(index.step(first.id, { kind: 'summary' })).rejects.toThrow(`no open index session '${first.id}'`);
    expect(await index.step(second.id, { kind: 'summary' })).toEqual({ vectors: 2, dims: 4 });
    await expect(index.step(second.id, { kind: 'stage', rows: [] })).rejects.toThrow('no vector rebuild is open');
    await index.step(second.id, { kind: 'close' });
  });

  it('stages a rebuild that reaches the live index only at its commit', async () => {
    const seed = await seeded();
    const [a, b, c] = seed.ids;
    const before = await live(seed);
    expect(before).toEqual({
      vectors: { [a]: vector(1), [b]: vector(2) },
      state: { storedModel: OLD, hasVectors: true },
    });
    const index = KINDS[kind](seed.root);
    const { id } = await index.open();
    expect(await index.step(id, { kind: 'lock' })).toBe(true);
    await index.step(id, { kind: 'begin' });
    await expect(index.step(id, { kind: 'begin' })).rejects.toThrow('a vector rebuild is already open on this session');
    expect(await index.step(id, { kind: 'stage', rows: [[b, vector(3)]] })).toBe(1);
    expect(await index.step(id, { kind: 'stage', rows: [[c, vector(4)]] })).toBe(1);
    expect(await live(seed)).toEqual(before);
    await index.step(id, { kind: 'commit', model: NEW });
    await expect(index.step(id, { kind: 'stage', rows: [] })).rejects.toThrow('no vector rebuild is open');
    await index.step(id, { kind: 'close' });
    expect(await live(seed)).toEqual({
      vectors: { [b]: vector(3), [c]: vector(4) },
      state: { storedModel: NEW, hasVectors: true },
    });
  });

  it('drops a staging whose session closes before the commit', async () => {
    const seed = await seeded();
    const [a, , c] = seed.ids;
    const before = await live(seed);
    const index = KINDS[kind](seed.root);
    const aborted = await index.open();
    expect(await index.step(aborted.id, { kind: 'lock' })).toBe(true);
    await index.step(aborted.id, { kind: 'begin' });
    await index.step(aborted.id, { kind: 'stage', rows: [[c, vector(9)]] });
    await index.step(aborted.id, { kind: 'close' });
    expect(await live(seed)).toEqual(before);
    // The next rebuild commits only the rows it staged itself.
    const { id } = await index.open();
    await index.step(id, { kind: 'begin' });
    await index.step(id, { kind: 'stage', rows: [[a, vector(5)]] });
    await index.step(id, { kind: 'commit', model: NEW });
    await index.step(id, { kind: 'close' });
    expect((await live(seed)).vectors).toEqual({ [a]: vector(5) });
  });
});

describe('the embedding index lock', () => {
  const PAIRS: readonly (readonly [holder: Kind, waiter: Kind])[] = [
    ['in process', 'on the store worker'],
    ['on the store worker', 'in process'],
  ];

  it.each(PAIRS)('held %s, keeps a session %s out until the holder closes', async (holderKind, waiterKind) => {
    const { root } = await seeded();
    const holder = KINDS[holderKind](root);
    const waiter = KINDS[waiterKind](root);
    const held = await holder.open();
    const waiting = await waiter.open();
    expect(waiting.key).toBe(held.key);
    expect(await holder.step(held.id, { kind: 'lock' })).toBe(true);
    expect(await waiter.step(waiting.id, { kind: 'lock' })).toBe(false);
    await holder.step(held.id, { kind: 'close' });
    expect(await waiter.step(waiting.id, { kind: 'lock' })).toBe(true);
    await waiter.step(waiting.id, { kind: 'close' });
  });
});
