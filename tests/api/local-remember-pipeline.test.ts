// rememberLocally and extractRememberedFacts on a real store: what each ending stores, counts and answers.
import type { FullContext } from '../_helpers/api-ctx.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import {
  adminActor,
  extractRememberedFacts,
  reject,
  rememberLocally,
  type LocalRememberInput,
  type LocalRememberOutcome,
} from '../../src/api/index.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, Layer, type MemoryEntry } from '../../src/core/memory.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { RejectedValueError } from '../../src/core/api-errors.js';
import { startHashedEmbeddings, type HashedEmbeddings } from '../_helpers/hashed-embedding-server.js';
import { makeRoot, type MakeRootOptions } from '../_helpers/make-root.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { loadAllEntries, readEntry, writeEntry, loadEmbeddingIndex } from '../_helpers/root-forms.js';

const TEXT = 'the billing service retries a failed charge three times';
const SALIENCE_ON = { salience: { enabled: true } };

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function store(config?: MakeRootOptions['config']): FullContext {
  const hippoRoot = makeRoot('local-remember', { config });
  roots.push(hippoRoot);
  return apiCtx(hippoRoot, 'default', adminActor('cli'));
}

const counted = (ctx: FullContext): number => Number(sqliteSyncStore(ctx.hippoRoot).reports.stats().total_remembered);
const rows = (ctx: FullContext): MemoryEntry[] => loadAllEntries(ctx.hippoRoot, ctx.tenantId);

function seed(ctx: FullContext, content: string, tags: string[]): void {
  writeEntry(ctx.hippoRoot, createMemory(content, { tags, baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
}

/** A store whose last four rows are errors, so a fifth that overlaps them is a repeated error. */
function storeOfRepeatedErrors(): FullContext {
  const ctx = store(SALIENCE_ON);
  for (let n = 1; n <= 4; n++) seed(ctx, `connection timeout on database shard ${n}`, ['error']);
  return ctx;
}
const FIFTH_ERROR: LocalRememberInput = { content: 'connection timeout on database shard 5', tags: ['error'] };

function storedRow(outcome: LocalRememberOutcome): MemoryEntry {
  if (outcome.status !== 'stored') throw new Error(`expected a stored row, got ${outcome.status}`);
  return outcome.entry;
}

describe('rememberLocally', () => {
  it('stores the row, counts it once and answers the row as the store holds it', async () => {
    const ctx = store();
    const outcome = await rememberLocally(ctx, {
      content: TEXT,
      tags: ['billing'],
      layer: Layer.Episodic,
      source: 'cli',
      confidence: 'observed',
      scope: 'team:eng',
    });
    const entry = storedRow(outcome);
    expect(outcome).toMatchObject({ status: 'stored', entry });
    expect(entry).toEqual(readEntry(ctx.hippoRoot, entry.id, ctx.tenantId));
    expect(entry).toMatchObject({
      content: TEXT,
      tags: ['billing'],
      source: 'cli',
      confidence: 'observed',
      scope: 'team:eng',
      pinned: false,
    });
    expect(rows(ctx)).toHaveLength(1);
    expect(counted(ctx)).toBe(1);
  });

  it('says in the outcome and the log that a row the embedder could not index is stored without a vector', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-real');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad key', { status: 401 })),
    );
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const ctx = store({ embeddings: { provider: 'openai', model: 'm' } });
      const outcome = await rememberLocally(ctx, { content: TEXT, tags: [] });
      if (outcome.status !== 'stored') throw new Error('expected a stored row');
      expect(await outcome.embedding).toBe('failed');
      expect(rows(ctx)).toHaveLength(1);
      expect(warn.mock.calls.map((c) => String(c[0])).join('')).toContain(
        `memory ${outcome.entry.id} is stored but not in the vector index`,
      );
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('scores schema fit on fitTags when given, else on the stored tags', async () => {
    const ctx = store();
    for (const n of [1, 2, 3]) seed(ctx, `the billing service sends invoice batch ${n}`, ['billing']);
    const stored = ['billing', 'path:acme', 'scope:eng'];
    const typedFit = sqliteSyncStore(ctx.hippoRoot).contextReads.schemaFit(ctx.tenantId, TEXT, ['billing']);
    const storedFit = sqliteSyncStore(ctx.hippoRoot).contextReads.schemaFit(ctx.tenantId, TEXT, stored);
    expect(typedFit).not.toBe(storedFit);
    expect(
      storedRow(await rememberLocally(ctx, { content: TEXT, tags: stored, fitTags: ['billing'], force: true }))
        .schemaFit,
    ).toBe(typedFit);
    const other = store();
    for (const n of [1, 2, 3]) seed(other, `the billing service sends invoice batch ${n}`, ['billing']);
    expect(storedRow(await rememberLocally(other, { content: TEXT, tags: stored })).schemaFit).toBe(storedFit);
  });

  it('with the gate off, stores a repeat of the same text', async () => {
    const ctx = store();
    await rememberLocally(ctx, { content: TEXT, tags: [] });
    expect((await rememberLocally(ctx, { content: TEXT, tags: [] })).status).toBe('stored');
    expect(counted(ctx)).toBe(2);
  });

  it('skips a repeat of the same text: nothing stored, nothing counted, the reason and score answered', async () => {
    const ctx = store(SALIENCE_ON);
    const first = storedRow(await rememberLocally(ctx, { content: TEXT, tags: [] }));
    const outcome = await rememberLocally(ctx, { content: TEXT, tags: [] });
    expect(outcome).toEqual({ status: 'skipped', reason: `duplicate (same text as ${first.id})`, score: 0.1 });
    expect(rows(ctx).map((row) => row.id)).toEqual([first.id]);
    expect(counted(ctx)).toBe(1);
  });

  it('starts a repeated error weak: the verdict strength, half the half-life once, and the verdict answered', async () => {
    const forced = storedRow(await rememberLocally(storeOfRepeatedErrors(), { ...FIFTH_ERROR, force: true }));
    const ctx = storeOfRepeatedErrors();
    const outcome = await rememberLocally(ctx, FIFTH_ERROR);
    const entry = storedRow(outcome);
    expect(outcome).toMatchObject({ status: 'stored', startedWeak: { strength: 0.3 } });
    expect(outcome).toHaveProperty(
      'startedWeak.reason',
      expect.stringMatching(/^repeat_error \(4 recent errors, overlap 100% with mem_/),
    );
    expect(forced.strength).toBeCloseTo(1, 3);
    expect(entry.strength).toBeCloseTo(0.3, 3);
    expect(entry.halfLifeDays).toBe(forced.halfLifeDays * 0.5);
    expect(readEntry(ctx.hippoRoot, entry.id, ctx.tenantId)?.halfLifeDays).toBe(entry.halfLifeDays);
    expect(counted(ctx)).toBe(1);
  });

  const BYPASSES: readonly (readonly [string, Pick<LocalRememberInput, 'pinned' | 'force'>])[] = [
    ['pinned', { pinned: true }],
    ['forced', { force: true }],
  ];
  it.each(BYPASSES)('a %s write is not judged by the gate', async (_label, bypass) => {
    const ctx = store(SALIENCE_ON);
    await rememberLocally(ctx, { content: TEXT, tags: [] });
    const outcome = await rememberLocally(ctx, { content: TEXT, tags: [], ...bypass });
    expect(outcome).toMatchObject({ status: 'stored', entry: storedRow(outcome) });
    expect(storedRow(outcome).pinned).toBe(bypass.pinned === true);
    expect(counted(ctx)).toBe(2);
    const weak = storeOfRepeatedErrors();
    expect(storedRow(await rememberLocally(weak, { ...FIFTH_ERROR, ...bypass })).strength).toBeCloseTo(1, 3);
  });

  it('a rejected value throws what remember throws, with nothing stored or counted, weak verdict or not', async () => {
    const ctx = store();
    await reject(ctx, { value: TEXT, reason: 'wrong' });
    await expect(rememberLocally(ctx, { content: TEXT, tags: [] })).rejects.toThrow(RejectedValueError);
    expect(rows(ctx)).toHaveLength(0);
    expect(counted(ctx)).toBe(0);
    const weak = storeOfRepeatedErrors();
    await reject(weak, { value: FIFTH_ERROR.content, reason: 'wrong' });
    await expect(rememberLocally(weak, FIFTH_ERROR)).rejects.toThrow(RejectedValueError);
    expect(rows(weak)).toHaveLength(4);
    expect(counted(weak)).toBe(0);
  });
});

describe('rememberLocally starts the embedding', () => {
  let embeddings: HashedEmbeddings;
  beforeAll(async () => {
    embeddings = await startHashedEmbeddings();
  });
  afterAll(async () => {
    await embeddings.close();
  });

  // The embedding is never awaited by the write, so the test waits for the local server's round trip on a busy box.
  it('leaves a vector for the stored row, and none for a skipped write', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret');
    const ctx = store({
      ...SALIENCE_ON,
      embeddings: { provider: 'openai', model: 'hashed-16', apiBaseUrl: embeddings.url },
    });
    const entry = storedRow(await rememberLocally(ctx, { content: TEXT, tags: [] }));
    await vi.waitFor(() => expect(Object.keys(loadEmbeddingIndex(ctx.hippoRoot))).toEqual([entry.id]), {
      timeout: 20_000,
      interval: 50,
    });
    const asked = embeddings.requests();
    expect((await rememberLocally(ctx, { content: TEXT, tags: [] })).status).toBe('skipped');
    expect(embeddings.requests()).toBe(asked);
  });
});

describe('extractRememberedFacts', () => {
  const FACTS = [
    {
      content: 'Alice owns the billing retry policy for failed charges',
      tags: ['speaker:Alice', 'topic:billing'],
      valence: 'neutral',
    },
    {
      content: 'The billing service retries a failed charge three times before paging',
      tags: ['topic:billing'],
      valence: 'neutral',
    },
  ];
  const answering =
    (text: string, status = 200): typeof fetch =>
    async () =>
      new Response(JSON.stringify({ content: [{ text }] }), { status });
  const stored = async (ctx: FullContext): Promise<MemoryEntry> =>
    storedRow(await rememberLocally(ctx, { content: TEXT, tags: ['scope:eng'] }));
  const extracted = (ctx: FullContext, from: MemoryEntry): MemoryEntry[] =>
    rows(ctx).filter((row) => row.extractedFrom === from.id);

  it('is off unless the caller or the config asks', async () => {
    const ctx = store();
    const entry = await stored(ctx);
    const outcome = await extractRememberedFacts(ctx, entry, {
      requested: false,
      apiKey: 'no-key',
      fetcher: answering(JSON.stringify(FACTS)),
    });
    expect(outcome).toEqual({ status: 'off' });
    expect(extracted(ctx, entry)).toHaveLength(0);
  });

  it.each([
    ['the caller asks', undefined, true],
    ['the config asks', { extraction: { enabled: true } }, false],
  ])('answers no_key when %s and there is no key', async (_label, config, requested) => {
    const ctx = store(config);
    const entry = await stored(ctx);
    expect(await extractRememberedFacts(ctx, entry, { requested })).toEqual({ status: 'no_key' });
    expect(await extractRememberedFacts(ctx, entry, { requested, apiKey: '' })).toEqual({ status: 'no_key' });
  });

  it('stores the facts the model gives beside the row and counts them', async () => {
    const ctx = store();
    const entry = await stored(ctx);
    const outcome = await extractRememberedFacts(ctx, entry, {
      requested: true,
      apiKey: 'no-key',
      fetcher: answering(JSON.stringify(FACTS)),
    });
    expect(outcome).toEqual({ status: 'ran', facts: 2, failures: [] });
    expect(extracted(ctx, entry).map((row) => row.content)).toEqual(FACTS.map((fact) => fact.content));
    expect(extracted(ctx, entry)[0]?.tags).toContain('scope:eng');
  });

  it('names a failed model call and a thrown one in the result, and stores nothing', async () => {
    const ctx = store();
    const entry = await stored(ctx);
    const refused = await extractRememberedFacts(ctx, entry, {
      requested: true,
      apiKey: 'no-key',
      fetcher: answering('ignored', 500),
    });
    expect(refused).toMatchObject({ status: 'ran', facts: 0 });
    expect(refused).toHaveProperty('failures.length', 1);
    const unparseable = await extractRememberedFacts(ctx, entry, {
      requested: true,
      apiKey: 'no-key',
      fetcher: answering('not json'),
    });
    expect(unparseable).toHaveProperty('failures.0', expect.stringMatching(/^unparseable response: /));
    expect(extracted(ctx, entry)).toHaveLength(0);
  });
});
