// The graph path of nearest-vector search: the caller's filter runs inside the walk, and a wide enough walk gives the
// exact scan's ids and scores. The threshold is forced low with minGraphRows, so small seeded stores take the graph.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { buildGraph } from '../src/db/vector-graph-rows.js';
import { keepVectorGraphLoaded } from '../src/db/vector-graph-search.js';
import { makeRoot } from './_helpers/make-root.js';
import { clusteredVectors, nearest, seedVectors, withDb } from './_helpers/vector-graph-seed.js';

vi.setConfig({ testTimeout: 120_000 });
// The graph answers only in a process that opted in, as serve and MCP stdio do.
keepVectorGraphLoaded();

let root: string;

beforeEach(() => {
  root = makeRoot('vector-graph-filter');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** A row the exact scan sees and the graph cannot: no node, and its queue row removed by hand. */
function seedProbe(vector: readonly number[]): string {
  const [id] = seedVectors(root, [[...vector]]);
  withDb(root, (db) => db.prepare('DELETE FROM memory_vector_pending WHERE memory_id = ?').run(id));
  return id;
}

describe('vector graph search under a filter', () => {
  it('rows the scope filter hides never appear, though they sit nearest the query', async () => {
    const vectors = clusteredVectors(1000, 7);
    const query = vectors[123];
    const hiddenVectors = Array.from({ length: 30 }, (_, i) => query.map((x, d) => x + (d === i % 16 ? 1e-4 : 0)));
    const visible = seedVectors(root, vectors);
    const hidden = seedVectors(root, hiddenVectors, () => 'secret');
    withDb(root, (db) => buildGraph(db));
    const probe = seedProbe(query);

    const where = ' AND m.scope IS NULL';
    const graph = await nearest(root, query, 10, { where, minGraphRows: 100 });
    expect(graph.map((m) => m.id)).not.toContain(probe);
    expect(graph).toHaveLength(10);
    for (const m of graph) expect(hidden).not.toContain(m.id);
    expect(graph[0].id).toBe(visible[123]);
    const unfiltered = await nearest(root, query, 10, { minGraphRows: 100 });
    expect(unfiltered.filter((m) => hidden.includes(m.id)).length).toBeGreaterThan(0);
  });

  it('on a 3k store, a walk at ef >= N gives the exact scan ids and scores', async () => {
    const vectors = clusteredVectors(3000, 11);
    seedVectors(root, vectors);
    withDb(root, (db) => buildGraph(db));
    const probe = seedProbe(vectors[0].map((x) => -x));
    for (const q of [vectors[5], vectors[1500], vectors[2999].map((x) => x * 0.5 + 0.1)]) {
      const graph = await nearest(root, q, 25, { minGraphRows: 100, ef: 3001 });
      vi.stubEnv('HIPPO_VECTOR_INDEX', 'exact');
      const exact = (await nearest(root, q, 26, {})).filter((m) => m.id !== probe).slice(0, 25);
      vi.unstubAllEnvs();
      expect(graph).toEqual(exact);
    }
  });

  it('HIPPO_VECTOR_INDEX=exact skips the graph, and so does a filter admitting under half the nodes', async () => {
    const vectors = clusteredVectors(600, 3);
    const ids = seedVectors(root, vectors, (i) => (i % 20 === 0 ? null : 'other'));
    withDb(root, (db) => buildGraph(db));
    const probe = seedProbe(vectors[40]);

    const idsOf = async (opts: { where?: string; minGraphRows: number }): Promise<string[]> =>
      (await nearest(root, vectors[40], 3, opts)).map((m) => m.id);
    const graph = await idsOf({ minGraphRows: 100 });
    expect(graph).toContain(ids[40]);
    expect(graph).not.toContain(probe);
    vi.stubEnv('HIPPO_VECTOR_INDEX', 'exact');
    expect(await idsOf({ minGraphRows: 100 })).toContain(probe);
    vi.unstubAllEnvs();
    expect(await idsOf({ where: ' AND m.scope IS NULL', minGraphRows: 10 })).toContain(probe);
  });
});
