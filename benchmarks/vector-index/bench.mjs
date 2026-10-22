// By hand only, after npm run build: node --expose-gc benchmarks/vector-index/bench.mjs. Env: N (vectors, 20000),
// MODE (store: the store worker's graph against the scan on a real store; graph: the bare graph, with M and EFC;
// crossover: scan against graph p50 at each size in NS, which sets VECTOR_GRAPH_THRESHOLD; oneshot: a fresh process's
// read at each size in NS, by scan and from the saved graph file, and a writer's waits during the file's build) and NOISE
// (spread of each cluster, 2: two points of a cluster sit at cosine about 0.2, against 0 +- 0.05 for the rest).
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVectorGraph, insertNode, searchGraph } from '../../dist/db/vector-graph.js';
import { VectorGraphs } from '../../dist/db/vector-graph-index.js';
import { saveVectorGraphFile } from '../../dist/db/vector-graph-build.js';
import { graphFilePath } from '../../dist/db/vector-graph-file.js';
import { sqliteStore } from '../../dist/store/sqlite/store.js';
import { closeHippoDb, openHippoDb, setMeta } from '../../dist/db/index.js';
import { EMBEDDING_MODEL_META_KEY, upsertVectors } from '../../dist/db/vector-store.js';
import { createMemory } from '../../dist/base/memory/memory.js';
import { writeEntryDbOnly } from '../../dist/entry/testing.js';
import { initStore } from '../../dist/entry/testing.js';
import { loadVectorCandidateEntriesAt } from '../../dist/entry/testing.js';
import { ALL_TENANTS } from '../../dist/base/util/tenant.js';

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

const NOISE = Number(process.env.NOISE ?? 2);
const noise = NOISE / Math.sqrt(DIM);

// Random unit vectors around n / 100 random unit centres, and queries drawn around the same centres.
function dataset(n) {
  const centres = Array.from({ length: Math.max(1, n / 100) }, () => unit(Float32Array.from({ length: DIM }, gauss)));
  const point = (c) => unit(Float32Array.from(centres[c], (x) => x + gauss() * noise));
  return {
    vectors: Array.from({ length: n }, (_, i) => point(i % centres.length)),
    queries: Array.from({ length: QUERIES }, (_, i) => Array.from(point((i * 37) % centres.length))),
  };
}

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

function seedStore(vectors) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-vector-bench-'));
  initStore(root);
  const db = openHippoDb(root);
  db.exec('BEGIN');
  for (let i = 0; i < vectors.length; i++) {
    writeEntryDbOnly(db, { ...createMemory(`memory ${i}`, { tenantId: TENANTS[i % 3] }), id: `m${i}` });
  }
  upsertVectors(
    db,
    vectors.map((v, i) => [`m${i}`, Array.from(v)]),
    'bench',
  );
  setMeta(db, EMBEDDING_MODEL_META_KEY, 'bench');
  db.exec('COMMIT');
  return { root, db };
}

async function timed(fn) {
  const start = performance.now();
  const out = await fn();
  return { out, took: performance.now() - start };
}

// No limit, as recall and context ask: the store's default of 50 rows, of which recall@10 scores the first 10.
const spec = (tenantId) => ({ tenantId, scope: { mode: 'default-deny' }, includeSuperseded: false });

async function builtGraphs(root, db, n, query) {
  const graphs = new VectorGraphs(root, { threshold: n });
  const build = await timed(async () => {
    await loadVectorCandidateEntriesAt(db, query, spec(ALL_TENANTS), graphs);
    await graphs.idle();
  });
  return { graphs, build };
}

async function storeMode() {
  const { vectors, queries } = dataset(N);
  const { root, db } = seedStore(vectors);
  const built = await builtGraphs(root, db, N, queries[0]);
  let graphs = built.graphs;
  console.log(`build N=${N} dim=${DIM} noise=${NOISE} build_ms=${Math.round(built.build.took)}`);
  for (const [label, tenant] of [
    ['all rows', ALL_TENANTS],
    ['one tenant of three', 't0'],
  ]) {
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

// Scan and graph p50 at each size: the threshold is the first size where the graph answers faster.
async function crossoverMode() {
  const sizes = (process.env.NS ?? '1000,5000,10000,20000,50000').split(',').map(Number);
  for (const n of sizes) {
    const { vectors, queries } = dataset(n);
    const { root, db } = seedStore(vectors);
    const before = await heapMb();
    const { graphs, build } = await builtGraphs(root, db, n, queries[0]);
    const heldKb = (((await heapMb()) - before) * 1024) / n;
    const scanMs = [];
    const graphMs = [];
    for (const q of queries) {
      scanMs.push((await timed(() => loadVectorCandidateEntriesAt(db, q, spec(ALL_TENANTS)))).took);
      graphMs.push((await timed(() => loadVectorCandidateEntriesAt(db, q, spec(ALL_TENANTS), graphs))).took);
    }
    scanMs.sort((a, b) => a - b);
    graphMs.sort((a, b) => a - b);
    console.log(
      `N=${n} scan p50/p95 ms=${ms(pct(scanMs, 0.5))}/${ms(pct(scanMs, 0.95))} graph p50/p95 ms=` +
        `${ms(pct(graphMs, 0.5))}/${ms(pct(graphMs, 0.95))} build_ms=${Math.round(build.took)} ` +
        `graph_kb_per_vector=${heldKb.toFixed(2)}`,
    );
    graphs.close();
    closeHippoDb(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function graphMode() {
  const { vectors, queries } = dataset(N);
  const M = Number(process.env.M ?? 16);
  const EFC = Number(process.env.EFC ?? 100);
  const before = await heapMb();
  const start = performance.now();
  const graph = createVectorGraph({ dim: DIM, m: M, efConstruction: EFC, seed: 1 });
  vectors.forEach((v, i) => insertNode(graph, i, v));
  const buildMs = performance.now() - start;
  console.log(
    `build N=${N} M=${M} efC=${EFC} build_ms=${Math.round(buildMs)} heap_mb=${Math.round((await heapMb()) - before)}`,
  );
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

// One nearest-row read through the store in a fresh process, as a one-shot CLI recall makes it: with no store worker
// it reads the saved graph file when there is one and scans when there is not.
async function oneshotRead() {
  const { root, q } = JSON.parse(process.env.ONESHOT);
  const query = JSON.parse(fs.readFileSync(path.join(root, 'queries.json'), 'utf8'))[q];
  const { vectors } = sqliteStore(root);
  // Opens the store first, so the timing holds the read alone.
  await vectors.storedVectors(['none']);
  const { out, took } = await timed(() => vectors.nearestEntries(query, spec(ALL_TENANTS)));
  console.log(JSON.stringify({ took, ids: out.slice(0, K).map((e) => e.id) }));
}

// Commits with no busy wait until the parent drops a stop file, so any write a build blocks fails as busy.
async function oneshotWriter() {
  const { root } = JSON.parse(process.env.ONESHOT);
  const db = openHippoDb(root);
  db.exec('PRAGMA busy_timeout = 0');
  const write = db.prepare(
    "INSERT INTO meta(key, value) VALUES('bench-writer', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const stats = { writes: 0, busy: 0, maxMs: 0 };
  while (!fs.existsSync(path.join(root, 'stop'))) {
    const start = performance.now();
    try {
      db.exec('BEGIN IMMEDIATE');
      write.run(String(stats.writes));
      db.exec('COMMIT');
      stats.writes++;
    } catch (err) {
      if (!/busy|locked/i.test(String(err))) throw err;
      stats.busy++;
    }
    stats.maxMs = Math.max(stats.maxMs, performance.now() - start);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  closeHippoDb(db);
  console.log(JSON.stringify(stats));
}

const childEnv = (mode, payload) => ({ ...process.env, MODE: mode, ONESHOT: JSON.stringify(payload) });
const lastJson = (out) => JSON.parse(out.trim().split('\n').at(-1));

function readInChild(root, q, into) {
  const env = childEnv('oneshot-read', { root, q });
  const read = lastJson(execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env, encoding: 'utf8' }));
  into.took.push(read.took);
  into.ids.push(read.ids);
}

// Scan and file reads take turns query by query, so a load on the machine falls on both alike.
function oneshotReads(root) {
  const file = graphFilePath(root, DIM);
  const scan = { took: [], ids: [] };
  const fromFile = { took: [], ids: [] };
  for (let q = 0; q < QUERIES; q++) {
    fs.renameSync(file, `${file}.off`);
    readInChild(root, q, scan);
    fs.renameSync(`${file}.off`, file);
    readInChild(root, q, fromFile);
  }
  for (const arm of [scan, fromFile]) arm.took.sort((a, b) => a - b);
  return { scan, file: fromFile };
}

// Builds and saves the file as a sleep does, while a writer in another process commits as fast as it can.
async function savedUnderWrites(root) {
  const env = childEnv('oneshot-writer', { root });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env });
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const build = await timed(() => saveVectorGraphFile(root, { maxVectors: 200_000 }));
  fs.writeFileSync(path.join(root, 'stop'), '');
  await exited;
  return { buildMs: build.took, writer: lastJson(out) };
}

async function oneshotMode() {
  for (const n of (process.env.NS ?? '10000,50000').split(',').map(Number)) {
    const { vectors, queries } = dataset(n);
    const { root, db } = seedStore(vectors);
    closeHippoDb(db);
    fs.writeFileSync(path.join(root, 'queries.json'), JSON.stringify(queries));
    const { buildMs, writer } = await savedUnderWrites(root);
    const { scan, file } = oneshotReads(root);
    const hit = file.ids.reduce((sum, ids, i) => sum + ids.filter((id) => scan.ids[i].includes(id)).length, 0);
    const bytes = fs.statSync(graphFilePath(root, DIM)).size;
    console.log(
      `N=${n} one-shot read p50/p95 ms: scan=${ms(pct(scan.took, 0.5))}/${ms(pct(scan.took, 0.95))} ` +
        `file=${ms(pct(file.took, 0.5))}/${ms(pct(file.took, 0.95))} recall@${K}=${(hit / (QUERIES * K)).toFixed(3)} ` +
        `file_mb_per_10k=${((bytes / 2 ** 20) * (10_000 / n)).toFixed(2)} build_ms=${Math.round(buildMs)} ` +
        `writer writes=${writer.writes} busy=${writer.busy} max_ms=${ms(writer.maxMs)}`,
    );
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const modes = {
  graph: graphMode,
  crossover: crossoverMode,
  oneshot: oneshotMode,
  'oneshot-read': oneshotRead,
  'oneshot-writer': oneshotWriter,
};
await (modes[MODE] ?? storeMode)();
