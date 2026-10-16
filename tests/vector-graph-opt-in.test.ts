// The vector graph answers only in a process that opted in (serve, MCP stdio); a one-shot process scans.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { buildGraph } from '../src/db/vector-graph-rows.js';
import { keepVectorGraphLoaded } from '../src/db/vector-graph-search.js';
import { countMatching, recordStatementsAsync } from './_helpers/count-statements.js';
import { makeRoot } from './_helpers/make-root.js';
import { clusteredVectors, nearest, seedVectors, withDb } from './_helpers/vector-graph-seed.js';

vi.setConfig({ testTimeout: 120_000 });

const GRAPH_TABLES = /memory_vector_(nodes|index_meta)/;
let root: string;

beforeEach(() => {
  root = makeRoot('vector-graph-opt-in');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('vector graph opt-in', () => {
  it('a process that never opted in scans and reads no graph table, though the graph is large enough', async () => {
    const vectors = clusteredVectors(300, 5);
    const ids = seedVectors(root, vectors);
    withDb(root, (db) => buildGraph(db));

    const scanned = await recordStatementsAsync(() => nearest(root, vectors[7], 5, { minGraphRows: 100 }));
    expect(scanned.result[0].id).toBe(ids[7]);
    expect(countMatching(scanned.statements, GRAPH_TABLES)).toBe(0);

    // The same query after the opt-in reads the graph, so the zero above is the gate and not an unused graph.
    keepVectorGraphLoaded();
    const walked = await recordStatementsAsync(() => nearest(root, vectors[7], 5, { minGraphRows: 100 }));
    expect(walked.result[0].id).toBe(ids[7]);
    expect(countMatching(walked.statements, GRAPH_TABLES)).toBeGreaterThan(0);
  });
});
