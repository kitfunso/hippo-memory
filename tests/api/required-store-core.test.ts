// A store with the required groups and no optional one still remembers, recalls in every mode and builds
// context: core remember writes no vector, so each search ranks by BM25, and none of them warns. An embedding
// provider is live, so only the store's empty vector index keeps the vector arm off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { contextGet, remember, retrieve } from '../../src/api/index.js';
import type { Context } from '../../src/api/types.js';
import { log } from '../../src/base/util/log.js';
import { hybridSearch } from '../../src/entry/search.js';
import { physicsSearch } from '../../src/entry/store-kit.js';
import { loadAllEntries } from '../../src/store/sqlite/fixtures.js';
import { apiCtx, cwdProject, testReach } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { portOnlyStore } from '../_helpers/port-only-store.js';

const QUERY = 'deploy rollback';
const TEXTS = [
  'deploy rollback steps: deploy the previous tag, then rollback the schema with the down migration',
  'the deploy window is Tuesday afternoon',
  'a rollback needs the on-call engineer to approve it',
  'lunch is at noon on Fridays',
];

let root: string;
let ctx: Context;

beforeEach(async () => {
  root = makeRoot('required-store-core', {
    config: { embeddings: { provider: 'openai', model: 'text-embedding-3-small' } },
  });
  vi.stubEnv('OPENAI_API_KEY', randomBytes(16).toString('hex'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }))),
  );
  const store = portOnlyStore(root);
  const full = apiCtx(root);
  ctx = {
    ...full,
    store,
    reach: testReach(root, store),
    config: { ...full.config, physics: { ...full.config.physics, enabled: 'auto' } },
  };
  for (const content of TEXTS) await remember(ctx, { content });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const idsOf = (rows: readonly { readonly id: string }[]): string[] => rows.map((row) => row.id);

describe('a store with no optional group', () => {
  it('recalls in hybrid and physics mode in the order BM25 gives, with no warn line', async () => {
    const warn = vi.spyOn(log, 'warn');
    const bm25 = idsOf((await retrieve(ctx, { query: QUERY, mode: 'bm25' })).results);
    expect(bm25.length).toBeGreaterThan(1);
    expect(idsOf((await retrieve(ctx, { query: QUERY, mode: 'hybrid' })).results)).toEqual(bm25);
    expect(idsOf((await retrieve(ctx, { query: QUERY, mode: 'physics' })).results)).toEqual(bm25);
    expect(warn).not.toHaveBeenCalled();
  });

  it("builds context with physics on 'auto' from the rows BM25 ranks, with no warn line", async () => {
    const warn = vi.spyOn(log, 'warn');
    const bm25 = idsOf((await retrieve(ctx, { query: QUERY, mode: 'bm25' })).results);
    const context = await contextGet(ctx, { q: QUERY, currentProject: cwdProject() });
    expect(context.entries.map((row) => row.entry.id)).toEqual(bm25);
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers the published physicsSearch in the order hybridSearch gives on BM25 alone', async () => {
    const warn = vi.spyOn(log, 'warn');
    const entries = loadAllEntries(root);
    const physics = await physicsSearch(QUERY, entries, { hippoRoot: root, store: portOnlyStore(root) });
    const bm25 = await hybridSearch(QUERY, entries);
    expect(physics.length).toBeGreaterThan(1);
    expect(physics.map((row) => row.entry.id)).toEqual(bm25.map((row) => row.entry.id));
    expect(warn).not.toHaveBeenCalled();
  });
});
