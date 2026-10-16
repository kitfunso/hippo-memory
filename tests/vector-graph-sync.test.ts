// The vector graph stays in step with memory_vectors: re-embeds, raw deletes (the entry node too), a model change, rows
// queued before a merge, and two processes merging at once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGraph, loadGraph, mergePending } from '../src/db/vector-graph-rows.js';
import { saveEmbeddingIndex, saveStoredVectors } from '../src/store/vector-index.js';
import type { DatabaseSyncLike } from '../src/db/index.js';
import { makeRoot } from './_helpers/make-root.js';
import { MODEL, clusteredVectors, nearest, seedVectors, withDb } from './_helpers/vector-graph-seed.js';

vi.setConfig({ testTimeout: 120_000 });

const GRAPH = { minGraphRows: 100, ef: 2000 };
let root: string;
let workerDir: string | undefined;

beforeEach(() => {
  root = makeRoot('vector-graph-sync');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  if (workerDir) rmSync(workerDir, { recursive: true, force: true });
  workerDir = undefined;
});

function count(db: DatabaseSyncLike, table: string): number {
  // SAFETY: the SELECT names exactly the one column read.
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

async function exactNearest(query: readonly number[], k: number): Promise<Awaited<ReturnType<typeof nearest>>> {
  vi.stubEnv('HIPPO_VECTOR_INDEX', 'exact');
  try {
    return await nearest(root, query, k);
  } finally {
    vi.unstubAllEnvs();
  }
}

/** A built graph over `n` seeded rows; returns their ids and vectors. */
function builtStore(n: number) {
  const vectors = clusteredVectors(n, 21);
  const ids = seedVectors(root, vectors);
  expect(withDb(root, (db) => buildGraph(db))).toBe(n);
  return { ids, vectors };
}

describe('vector graph sync', () => {
  it('a re-embedded row is scored from its new vector before and after a merge', async () => {
    const { ids, vectors } = builtStore(400);
    const moved = vectors[300].map((x) => -x);
    saveStoredVectors(root, [[ids[7], moved]], MODEL);
    expect((await nearest(root, moved, 5, GRAPH))).toEqual(await exactNearest(moved, 5));
    expect((await nearest(root, moved, 1, GRAPH))[0].id).toBe(ids[7]);
    withDb(root, (db) => {
      expect(mergePending(db, 5000)?.merged).toBe(0);
      expect(count(db, 'memory_vector_pending')).toBe(0);
    });
    expect((await nearest(root, moved, 1, GRAPH))[0].id).toBe(ids[7]);
  });

  it('a raw DELETE of a row, and of the entry node, keeps search exact and the graph loadable', async () => {
    const { ids, vectors } = builtStore(400);
    withDb(root, (db) => db.prepare('DELETE FROM memories WHERE id = ?').run(ids[50]));
    const after = await nearest(root, vectors[50], 10, GRAPH);
    expect(after.map((m) => m.id)).not.toContain(ids[50]);
    expect(after).toEqual(await exactNearest(vectors[50], 10));

    const entry = withDb(root, (db) => {
      const graph = loadGraph(db);
      return graph?.ids.get(graph.graph.entry);
    });
    expect(entry).toBeDefined();
    withDb(root, (db) => db.prepare('DELETE FROM memories WHERE id = ?').run(entry ?? ''));
    withDb(root, (db) => {
      const graph = loadGraph(db);
      const levels = [...(graph?.graph.nodes.values() ?? [])].map((n) => n.level);
      expect(graph?.ids.has(graph.graph.entry)).toBe(true);
      expect(graph?.graph.maxLevel).toBe(Math.max(...levels));
      expect(graph?.graph.nodes.size).toBe(398);
    });
    expect(await nearest(root, vectors[1], 10, GRAPH)).toEqual(await exactNearest(vectors[1], 10));
  });

  it('a model change through replaceAllVectors clears the graph, so search scans until the next build', async () => {
    const { ids, vectors } = builtStore(300);
    saveEmbeddingIndex(root, Object.fromEntries(ids.map((id, i) => [id, vectors[(i + 1) % ids.length]])), 'other');
    withDb(root, (db) => {
      expect(loadGraph(db)).toBeNull();
      expect([count(db, 'memory_vector_nodes'), count(db, 'memory_vector_pending')]).toEqual([0, 0]);
      expect(count(db, 'memory_vector_index_meta')).toBe(1);
    });
    expect(await nearest(root, vectors[9], 10, GRAPH)).toEqual(await exactNearest(vectors[9], 10));
  });

  it('rows written after the build show up before a merge, and become nodes after it', async () => {
    const { vectors } = builtStore(400);
    const fresh = seedVectors(root, clusteredVectors(60, 99));
    const target = clusteredVectors(60, 99)[17];
    expect((await nearest(root, target, 3, GRAPH))[0].id).toBe(fresh[17]);
    withDb(root, (db) => {
      expect(count(db, 'memory_vector_pending')).toBe(60);
      expect(mergePending(db, 5000)).toMatchObject({ merged: 60 });
      expect(count(db, 'memory_vector_pending')).toBe(0);
      expect(count(db, 'memory_vector_nodes')).toBe(460);
    });
    expect((await nearest(root, target, 3, GRAPH))[0].id).toBe(fresh[17]);
    expect(await nearest(root, vectors[3], 10, GRAPH)).toEqual(await exactNearest(vectors[3], 10));
  });

  it('two processes merging at once both finish with one consistent graph and no queued row lost', async () => {
    builtStore(300);
    seedVectors(root, clusteredVectors(200, 5));
    const outs = await Promise.all([0, 1].map(() => runMergeWorker(root)));
    for (const out of outs) expect(out.code, out.stderr).toBe(0);
    const merged = outs.map((o) => Number(o.stdout.trim()));
    expect(merged[0] + merged[1]).toBe(200);
    withDb(root, (db) => {
      expect(count(db, 'memory_vector_pending')).toBe(0);
      expect(count(db, 'memory_vector_nodes')).toBe(500);
      const graph = loadGraph(db);
      expect(new Set(graph?.ids.values()).size).toBe(500);
      for (const node of graph?.graph.nodes.values() ?? []) {
        for (const level of node.links) for (const n of level) expect(graph?.ids.has(n)).toBe(true);
      }
    });
  });
});

// Each worker marks itself ready in `dir`, then spins until both have, so the two merges overlap.
const WORKER = `
const [, , dbUrl, rowsUrl, root, dir] = process.argv;
const { readdirSync, writeFileSync } = await import('node:fs');
const { openHippoDb, closeHippoDb } = await import(dbUrl);
const { mergePending } = await import(rowsUrl);
writeFileSync(dir + '/ready-' + process.pid, '');
const pause = new Int32Array(new SharedArrayBuffer(4));
const started = Date.now();
while (readdirSync(dir).filter((f) => f.startsWith('ready-')).length < 2) {
  if (Date.now() - started > 20000) throw new Error('barrier timed out');
  Atomics.wait(pause, 0, 0, 2);
}
const db = openHippoDb(root);
try {
  process.stdout.write(String(mergePending(db, 5000)?.merged ?? -1));
} finally {
  closeHippoDb(db);
}
`;

function runMergeWorker(hippoRoot: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const dir = (workerDir ??= mkdtempSync(join(tmpdir(), 'hippo-merge-worker-')));
  const script = join(dir, 'worker.mjs');
  writeFileSync(script, WORKER, 'utf8');
  const dist = (p: string): string => pathToFileURL(resolve('dist', p)).href;
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [script, dist('db/index.js'), dist('db/vector-graph-rows.js'), hippoRoot, dir], {
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}
