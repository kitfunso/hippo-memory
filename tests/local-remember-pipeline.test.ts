// rememberLocally and extractRememberedFacts on a real store: what each ending stores, counts and answers.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import {
  adminActor, extractRememberedFacts, reject, rememberLocally,
  type HippoDbContext, type LocalRememberInput, type LocalRememberOutcome,
} from '../src/api/index.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, Layer, type MemoryEntry } from '../src/core/memory.js';
import { schemaFitInStore } from '../src/store/candidates.js';
import { loadAllEntries, readEntry } from '../src/store/entry-reads.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadStats } from '../src/store/index-and-stats.js';
import { RejectedValueError } from '../src/core/api-errors.js';
import { loadEmbeddingIndex } from '../src/store/vector-index.js';
import { startHashedEmbeddings, type HashedEmbeddings } from './_helpers/hashed-embedding-server.js';
import { makeRoot, type MakeRootOptions } from './_helpers/make-root.js';

const TEXT = 'the billing service retries a failed charge three times';
const SALIENCE_ON = { salience: { enabled: true } };

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
afterEach(() => { vi.unstubAllEnvs(); });

function store(config?: MakeRootOptions['config']): HippoDbContext {
  const hippoRoot = makeRoot('local-remember', { config });
  roots.push(hippoRoot);
  return { hippoRoot, tenantId: 'default', actor: adminActor('cli') };
}

const counted = (ctx: HippoDbContext): number => Number(loadStats(ctx.hippoRoot).total_remembered);
const rows = (ctx: HippoDbContext): MemoryEntry[] => loadAllEntries(ctx.hippoRoot, ctx.tenantId);

function seed(ctx: HippoDbContext, content: string, tags: string[]): void {
  writeEntry(ctx.hippoRoot, createMemory(content, { tags, baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
}

/** A store whose last four rows are errors, so a fifth that overlaps them is a repeated error. */
function storeOfRepeatedErrors(): HippoDbContext {
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
  it('stores the row, counts it once and answers the row as the store holds it', () => {
    const ctx = store();
    const outcome = rememberLocally(ctx, { content: TEXT, tags: ['billing'], layer: Layer.Episodic, source: 'cli', confidence: 'observed', scope: 'team:eng' });
    const entry = storedRow(outcome);
    expect(outcome).toEqual({ status: 'stored', entry });
    expect(entry).toEqual(readEntry(ctx.hippoRoot, entry.id, ctx.tenantId));
    expect(entry).toMatchObject({ content: TEXT, tags: ['billing'], source: 'cli', confidence: 'observed', scope: 'team:eng', pinned: false });
    expect(rows(ctx)).toHaveLength(1);
    expect(counted(ctx)).toBe(1);
  });

  it('scores schema fit on fitTags when given, else on the stored tags', () => {
    const ctx = store();
    for (const n of [1, 2, 3]) seed(ctx, `the billing service sends invoice batch ${n}`, ['billing']);
    const stored = ['billing', 'path:acme', 'scope:eng'];
    const typedFit = schemaFitInStore(ctx.hippoRoot, ctx.tenantId, TEXT, ['billing']);
    const storedFit = schemaFitInStore(ctx.hippoRoot, ctx.tenantId, TEXT, stored);
    expect(typedFit).not.toBe(storedFit);
    expect(storedRow(rememberLocally(ctx, { content: TEXT, tags: stored, fitTags: ['billing'], force: true })).schema_fit).toBe(typedFit);
    const other = store();
    for (const n of [1, 2, 3]) seed(other, `the billing service sends invoice batch ${n}`, ['billing']);
    expect(storedRow(rememberLocally(other, { content: TEXT, tags: stored })).schema_fit).toBe(storedFit);
  });

  it('with the gate off, stores a repeat of the same text', () => {
    const ctx = store();
    rememberLocally(ctx, { content: TEXT, tags: [] });
    expect(rememberLocally(ctx, { content: TEXT, tags: [] }).status).toBe('stored');
    expect(counted(ctx)).toBe(2);
  });

  it('skips a repeat of the same text: nothing stored, nothing counted, the reason and score answered', () => {
    const ctx = store(SALIENCE_ON);
    const first = storedRow(rememberLocally(ctx, { content: TEXT, tags: [] }));
    const outcome = rememberLocally(ctx, { content: TEXT, tags: [] });
    expect(outcome).toEqual({ status: 'skipped', reason: `duplicate (same text as ${first.id})`, score: 0.1 });
    expect(rows(ctx).map((row) => row.id)).toEqual([first.id]);
    expect(counted(ctx)).toBe(1);
  });

  it('starts a repeated error weak: the verdict strength, half the half-life once, and the verdict answered', () => {
    const forced = storedRow(rememberLocally(storeOfRepeatedErrors(), { ...FIFTH_ERROR, force: true }));
    const ctx = storeOfRepeatedErrors();
    const outcome = rememberLocally(ctx, FIFTH_ERROR);
    const entry = storedRow(outcome);
    expect(outcome).toMatchObject({ status: 'stored', startedWeak: { strength: 0.3 } });
    expect(outcome).toHaveProperty('startedWeak.reason', expect.stringMatching(/^repeat_error \(4 recent errors, overlap 100% with mem_/));
    expect(forced.strength).toBeCloseTo(1, 3);
    expect(entry.strength).toBeCloseTo(0.3, 3);
    expect(entry.half_life_days).toBe(forced.half_life_days * 0.5);
    expect(readEntry(ctx.hippoRoot, entry.id, ctx.tenantId)?.half_life_days).toBe(entry.half_life_days);
    expect(counted(ctx)).toBe(1);
  });

  const BYPASSES: readonly (readonly [string, Pick<LocalRememberInput, 'pinned' | 'force'>])[] = [['pinned', { pinned: true }], ['forced', { force: true }]];
  it.each(BYPASSES)('a %s write is not judged by the gate', (_label, bypass) => {
    const ctx = store(SALIENCE_ON);
    rememberLocally(ctx, { content: TEXT, tags: [] });
    const outcome = rememberLocally(ctx, { content: TEXT, tags: [], ...bypass });
    expect(outcome).toEqual({ status: 'stored', entry: storedRow(outcome) });
    expect(storedRow(outcome).pinned).toBe(bypass.pinned === true);
    expect(counted(ctx)).toBe(2);
    const weak = storeOfRepeatedErrors();
    expect(storedRow(rememberLocally(weak, { ...FIFTH_ERROR, ...bypass })).strength).toBeCloseTo(1, 3);
  });

  it('a rejected value throws what remember throws, with nothing stored or counted, weak verdict or not', () => {
    const ctx = store();
    reject(ctx, { value: TEXT, reason: 'wrong' });
    expect(() => rememberLocally(ctx, { content: TEXT, tags: [] })).toThrow(RejectedValueError);
    expect(rows(ctx)).toHaveLength(0);
    expect(counted(ctx)).toBe(0);
    const weak = storeOfRepeatedErrors();
    reject(weak, { value: FIFTH_ERROR.content, reason: 'wrong' });
    expect(() => rememberLocally(weak, FIFTH_ERROR)).toThrow(RejectedValueError);
    expect(rows(weak)).toHaveLength(4);
    expect(counted(weak)).toBe(0);
  });
});

describe('rememberLocally starts the embedding', () => {
  let embeddings: HashedEmbeddings;
  beforeAll(async () => { embeddings = await startHashedEmbeddings(); });
  afterAll(async () => { await embeddings.close(); });

  // The embedding is never awaited by the write, so the test waits for the local server's round trip on a busy box.
  it('leaves a vector for the stored row, and none for a skipped write', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret');
    const ctx = store({ ...SALIENCE_ON, embeddings: { provider: 'openai', model: 'hashed-16', apiBaseUrl: embeddings.url } });
    const entry = storedRow(rememberLocally(ctx, { content: TEXT, tags: [] }));
    await vi.waitFor(() => expect(Object.keys(loadEmbeddingIndex(ctx.hippoRoot))).toEqual([entry.id]), { timeout: 20_000, interval: 50 });
    const asked = embeddings.requests();
    expect(rememberLocally(ctx, { content: TEXT, tags: [] }).status).toBe('skipped');
    expect(embeddings.requests()).toBe(asked);
  }, 30_000);
});

describe('extractRememberedFacts', () => {
  const FACTS = [
    { content: 'Alice owns the billing retry policy for failed charges', tags: ['speaker:Alice', 'topic:billing'], valence: 'neutral' },
    { content: 'The billing service retries a failed charge three times before paging', tags: ['topic:billing'], valence: 'neutral' },
  ];
  const answering = (text: string, status = 200): typeof fetch => async () => new Response(JSON.stringify({ content: [{ text }] }), { status });
  const stored = (ctx: HippoDbContext): MemoryEntry => storedRow(rememberLocally(ctx, { content: TEXT, tags: ['scope:eng'] }));
  const extracted = (ctx: HippoDbContext, from: MemoryEntry): MemoryEntry[] => rows(ctx).filter((row) => row.extracted_from === from.id);

  it('is off unless the caller or the config asks', async () => {
    const ctx = store();
    const entry = stored(ctx);
    const outcome = await extractRememberedFacts(ctx, entry, { requested: false, apiKey: 'no-key', fetcher: answering(JSON.stringify(FACTS)) });
    expect(outcome).toEqual({ status: 'off' });
    expect(extracted(ctx, entry)).toHaveLength(0);
  });

  it.each([['the caller asks', undefined, true], ['the config asks', { extraction: { enabled: true } }, false]])(
    'answers no_key when %s and there is no key',
    async (_label, config, requested) => {
      const ctx = store(config);
      const entry = stored(ctx);
      expect(await extractRememberedFacts(ctx, entry, { requested })).toEqual({ status: 'no_key' });
      expect(await extractRememberedFacts(ctx, entry, { requested, apiKey: '' })).toEqual({ status: 'no_key' });
    },
  );

  it('stores the facts the model gives beside the row and counts them', async () => {
    const ctx = store();
    const entry = stored(ctx);
    const outcome = await extractRememberedFacts(ctx, entry, { requested: true, apiKey: 'no-key', fetcher: answering(JSON.stringify(FACTS)) });
    expect(outcome).toEqual({ status: 'ran', facts: 2, failures: [] });
    expect(extracted(ctx, entry).map((row) => row.content)).toEqual(FACTS.map((fact) => fact.content));
    expect(extracted(ctx, entry)[0]?.tags).toContain('scope:eng');
  });

  it('names a failed model call and a thrown one in the result, and stores nothing', async () => {
    const ctx = store();
    const entry = stored(ctx);
    const refused = await extractRememberedFacts(ctx, entry, { requested: true, apiKey: 'no-key', fetcher: answering('ignored', 500) });
    expect(refused).toMatchObject({ status: 'ran', facts: 0 });
    expect(refused).toHaveProperty('failures.length', 1);
    const unparseable = await extractRememberedFacts(ctx, entry, { requested: true, apiKey: 'no-key', fetcher: answering('not json') });
    expect(unparseable).toHaveProperty('failures.0', expect.stringMatching(/^unparseable response: /));
    expect(extracted(ctx, entry)).toHaveLength(0);
  });
});
