// By hand only, after npm run build: node --expose-gc benchmarks/vector-index/bench.mjs. Env: N (vectors, 20000),
// MODE (store: the store worker's graph against the scan on a real store; graph: the bare graph, with M and EFC) and
// NOISE (spread of each cluster, 2: two points of a cluster sit at cosine about 0.2, against 0 +- 0.05 for the rest).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createVectorGraph, insertNode, searchGraph } from '../../dist/db/vector-graph.js';
import { VectorGraphs } from '../../dist/db/vector-graph-index.js';
import { closeHippoDb, openHippoDb, setMeta } from '../../dist/db/index.js';
import { EMBEDDING_MODEL_META_KEY, upsertVectors } from '../../dist/db/vector-store.js';
import { createMemory } from '../../dist/core/memory.js';
import { writeEntryDbOnly } from '../../dist/store/entry-writes.js';
import { initStore } from '../../dist/entry/testing.js';
import { loadVectorCandidateEntriesAt } from '../../dist/store/search-rows.js';

const N = Number(process.env.N ?? 20000);
const MODE = process.env.MODE ?? 'store';
const DIM = 384;
const K = 10;
const QUERIES = 50;
const TENANTS = ['t0', 't1', 't2'];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r = rng(43);
const gauss = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

function unit(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

// Random unit vectors around N / 100 random unit centres.
const centres = Array.from({ length: N / 100 }, () => unit(Float32Array.from({ length: DIM }, gauss)));
const NOISE = Number(process.env.NOISE ?? 2);
const noise = NOISE / Math.sqrt(DIM);
const point = (c) => unit(Float32Array.from(centres[c], (x) => x + gauss() * noise));
const vectors = Array.from({ length: N }, (_, i) => point(i % centres.length));
const queries = Array.from({ length: QUERIES }, (_, i) => Array.from(point((i * 37) % centres.length)));

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const ms = (x) => x.toFixed(2);

// V8 frees ArrayBuffer memory on a background thread after a collection, so the count settles a moment later.
async function heapMb() {
  globalThis.gc?.();
  await new Promise((resolve) => setTimeout(resolve, 200));
  globalThis.gc?.();
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return (heapUsed + arrayBuffers) / 2 ** 20;
}

function seedStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-vector-bench-'));
  initStore(root);
  const db = openHippoDb(root);
  db.exec('BEGIN');
  for (let i = 0; i < N; i++) {
    writeEntryDbOnly(db, { ...createMemory(`memory ${i}`, { tenantId: TENANTS[i % 3] }), id: `m${i}` });
  }
  upsertVectors(db, vectors.map((v, i) => [`m${i}`, Array.from(v)]), 'bench');
  setMeta(db, EMBEDDING_MODEL_META_KEY, 'bench');
  db.exec('COMMIT');
  return { root, db };
}

async function timed(fn) {
  const start = performance.now();
  const out = await fn();
  return { out, took: performance.now() - start };
}

async function storeMode() {
  const { root, db } = seedStore();
  let graphs = new VectorGraphs(root, { threshold: N });
  // No limit, as recall and context ask: the store's default of 50 rows, of which recall@10 scores the first 10.
  const spec = (tenantId) => ({ tenantId, scope: { mode: 'default-deny' }, includeSuperseded: false });
  const build = await timed(async () => {
    await loadVectorCandidateEntriesAt(db, queries[0], spec(undefined), graphs);
    await graphs.idle();
  });
  console.log(`build N=${N} dim=${DIM} noise=${NOISE} build_ms=${Math.round(build.took)}`);
  for (const [label, tenant] of [['all rows', undefined], ['one tenant of three', 't0']]) {
    const scanMs = [];
    const graphMs = [];
    let hit = 0;
    for (const q of queries) {
      const scan = await timed(() => loadVectorCandidateEntriesAt(db, q, spec(tenant)));
      const graph = await timed(() => loadVectorCandidateEntriesAt(db, q, spec(tenant), graphs));
      const truth = new Set(scan.out.slice(0, K).map((e) => e.id));
      hit += graph.out.slice(0, K).filter((e) => truth.has(e.id)).length;
      scanMs.push(scan.took);
      graphMs.push(graph.took);
    }
    scanMs.sort((a, b) => a - b);
    graphMs.sort((a, b) => a - b);
    console.log(
      `${label}: recall@${K}=${(hit / (QUERIES * K)).toFixed(3)} graph p50/p95 ms=${ms(pct(graphMs, 0.5))}/` +
        `${ms(pct(graphMs, 0.95))} scan p50/p95 ms=${ms(pct(scanMs, 0.5))}/${ms(pct(scanMs, 0.95))}`,
    );
  }
  // What the graph holds, measured as what dropping it frees.
  const held = await heapMb();
  graphs.close();
  graphs = undefined;
  console.log(`graph heap_mb=${Math.round(held - (await heapMb()))}`);
  closeHippoDb(db);
  fs.rmSync(root, { recursive: true, force: true });
}

async function graphMode() {
  const M = Number(process.env.M ?? 16);
  const EFC = Number(process.env.EFC ?? 100);
  const before = await heapMb();
  const start = performance.now();
  const graph = createVectorGraph({ dim: DIM, m: M, efConstruction: EFC, seed: 1 });
  vectors.forEach((v, i) => insertNode(graph, i, v));
  const buildMs = performance.now() - start;
  console.log(`build N=${N} M=${M} efC=${EFC} build_ms=${Math.round(buildMs)} heap_mb=${Math.round((await heapMb()) - before)}`);
  const truths = queries.map((q) => {
    const exact = vectors.map((v, i) => [v.reduce((s, x, j) => s + x * q[j], 0), i]).sort((a, b) => b[0] - a[0]);
    return new Set(exact.slice(0, K).map((x) => x[1]));
  });
  for (const ef of (process.env.EFS ?? '64,128').split(',').map(Number)) {
    let hit = 0;
    const took = [];
    queries.forEach((q, i) => {
      const start = performance.now();
      const found = searchGraph(graph, Float32Array.from(q), { k: K, ef });
      took.push(performance.now() - start);
      if (!found.aborted) hit += found.hits.filter((h) => truths[i].has(h.node)).length;
    });
    took.sort((a, b) => a - b);
    console.log(`ef=${ef} recall@${K}=${(hit / (QUERIES * K)).toFixed(3)} p50 ms=${ms(pct(took, 0.5))}`);
  }
}

await (MODE === 'graph' ? graphMode() : storeMode());
