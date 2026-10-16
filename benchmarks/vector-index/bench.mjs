// By hand only: node benchmarks/vector-index/bench.mjs (after npm run build). Env: N, M, EFC, SEED; MODE=sqlite times
// topVectorMatches on a temp store (N defaults to 30k there) instead of the bare graph.
import { createVectorGraph, insertNode, searchGraph } from '../../dist/util/vector-graph.js';

const MODE = process.env.MODE ?? 'memory';
const N = Number(process.env.N ?? (MODE === 'sqlite' ? 30000 : 100000));
const DIM = 384;
const M = Number(process.env.M ?? 16);
const EFC = Number(process.env.EFC ?? 200);
const SEED = Number(process.env.SEED ?? 42);
const K = 50;
const QUERIES = 30;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r = rng(SEED + 1);
const gauss = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

function unit(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

if (MODE === 'sqlite') {
  await sqliteMode();
  process.exit(0);
}

// Centres are unit; noise norm 1.17 puts a point at cosine ~0.65 from its centre.
const centres = Array.from({ length: N / 100 }, () => unit(Float32Array.from({ length: DIM }, gauss)));
const noise = 1.17 / Math.sqrt(DIM);
const point = (c) => unit(Float32Array.from(centres[c], (x) => x + gauss() * noise));
const vecs = new Float32Array(N * DIM);
for (let i = 0; i < N; i++) vecs.set(point(i % centres.length), i * DIM);
const queries = Array.from({ length: QUERIES }, (_, i) => point((i * 37) % centres.length));
const vecOf = (n) => vecs.subarray(n * DIM, (n + 1) * DIM);

const t0 = performance.now();
const graph = createVectorGraph({ dim: DIM, m: M, efConstruction: EFC, seed: SEED });
for (let i = 0; i < N; i++) {
  insertNode(graph, i, vecOf(i));
  if (i % 10000 === 9999) console.error(`built ${i + 1} in ${Math.round(performance.now() - t0)} ms`);
}
const buildMs = performance.now() - t0;

const dotq = (q, n) => {
  let s = 0;
  const o = n * DIM;
  for (let i = 0; i < DIM; i++) s += q[i] * vecs[o + i];
  return s;
};
const admitPct = (pct) => (id) => (Math.imul(id, 2654435761) >>> 0) % 100 < pct;

function truth(q, admit) {
  const all = [];
  for (let n = 0; n < N; n++) if (admit(n)) all.push([dotq(q, n), n]);
  all.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  return new Set(all.slice(0, K).map((x) => x[1]));
}

function run(label, pct) {
  const admit = admitPct(pct);
  const ef = Math.min(Math.ceil(128 / (pct / 100)), 512);
  const times = [];
  let hit = 0;
  for (const q of queries) {
    const gt = truth(q, admit);
    const s = performance.now();
    const res = searchGraph(graph, q, { k: K, ef, admit, vectorOf: vecOf });
    times.push(performance.now() - s);
    if (res.aborted) continue;
    hit += res.hits.filter((h) => gt.has(h.node)).length;
  }
  times.sort((a, b) => a - b);
  console.log(`${label} N=${N} M=${M} efC=${EFC} ef=${ef} warm_p50_ms=${times[times.length >> 1].toFixed(2)} recall@${K}=${(hit / (QUERIES * K)).toFixed(3)}`);
}

console.log(`build N=${N} dim=${DIM} M=${M} efC=${EFC} build_ms=${Math.round(buildMs)}`);
run('f100', 100);
run('f30', 30);

function p50(times) {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[sorted.length >> 1].toFixed(2);
}

async function timed(fn) {
  const s = performance.now();
  const out = await fn();
  return { ms: performance.now() - s, out };
}

// Rows: 30% scope NULL (the f30 filter); clusters c % 5 === 0 hold the "far" rows the worst case admits, and no query
// sits in one of them.
function sqliteRows(createMemory) {
  const centres = Array.from({ length: N / 100 }, () => unit(Float32Array.from({ length: DIM }, gauss)));
  const noise = 1.17 / Math.sqrt(DIM);
  const point = (c) => unit(Float32Array.from(centres[c], (x) => x + gauss() * noise));
  const vectors = Array.from({ length: N }, (_, i) => Array.from(point(i % centres.length)));
  const entries = vectors.map((_, i) => createMemory(`${(i % centres.length) % 5 === 0 ? 'far' : 'near'} ${i}`, {
    tenantId: 'default',
    scope: (Math.imul(i, 2654435761) >>> 0) % 100 < 30 ? null : 'bench-hidden',
  }));
  const queries = Array.from({ length: QUERIES }, (_, i) => {
    const c = (i * 37) % centres.length;
    return Array.from(point(c - (c % 5) + 1));
  });
  return { vectors, entries, queries };
}

async function sqliteMode() {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'hippo-ann-bench-'));
  process.env.HIPPO_HOME = join(home, 'global');
  try {
    await sqliteRun(join(home, 'store'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function sqliteRun(root) {
  const { initStore } = await import('../../dist/store/open.js');
  const { createMemory } = await import('../../dist/core/memory.js');
  const { batchWriteAndDelete } = await import('../../dist/store/delete-and-batch.js');
  const { openHippoDb, closeHippoDb } = await import('../../dist/db/index.js');
  const { upsertVectors, topVectorMatches } = await import('../../dist/db/vector-store.js');
  const { buildGraph, mergePending } = await import('../../dist/db/vector-graph-rows.js');
  initStore(root);
  const { vectors, entries, queries } = sqliteRows(createMemory);
  for (let i = 0; i < N; i += 1000) batchWriteAndDelete(root, entries.slice(i, i + 1000), []);
  const db = openHippoDb(root);
  const put = (from, to) => {
    db.exec('BEGIN');
    upsertVectors(db, entries.slice(from, to).map((e, i) => [e.id, vectors[from + i]]), 'bench');
    db.exec('COMMIT');
  };
  put(0, N - 1000);
  const build = await timed(() => buildGraph(db));
  console.log(`sqlite build N=${N - 1000} dim=${DIM} M=24 efC=300 build_ms=${Math.round(build.ms)} nodes=${build.out}`);
  put(N - 1000, N);
  const merge = await timed(() => mergePending(db, 5000));
  console.log(`sqlite merge pending=1000 merge_ms=${Math.round(merge.ms)} merged=${merge.out?.merged} ` +
    `sampled_recall=${merge.out?.recall.toFixed(3)}`);

  const run = async (label, where, opts, exact) => {
    if (exact) process.env.HIPPO_VECTOR_INDEX = 'exact';
    else delete process.env.HIPPO_VECTOR_INDEX;
    await topVectorMatches(db, queries[0], K, where, [], opts);
    const times = [];
    const results = [];
    for (const q of queries) {
      const t = await timed(() => topVectorMatches(db, q, K, where, [], opts));
      times.push(t.ms);
      results.push(t.out.map((m) => m.id));
    }
    return { label, p50: p50(times), results };
  };
  const report = (graph, exact) => {
    let hit = 0;
    graph.results.forEach((ids, i) => {
      const want = new Set(exact.results[i]);
      hit += ids.filter((id) => want.has(id)).length;
    });
    console.log(`sqlite ${graph.label} exact_p50_ms=${exact.p50} graph_p50_ms=${graph.p50} ` +
      `recall@${K}=${(hit / (QUERIES * K)).toFixed(3)}`);
  };
  const f30 = ' AND m.scope IS NULL';
  report(await run('f100', '', {}, false), await run('f100', '', {}, true));
  report(await run('f30 (auto: admitted rows under 20k, so exact)', f30, {}, false), await run('f30', f30, {}, true));
  report(await run('f30 (graph forced, minGraphRows 5000)', f30, { minGraphRows: 5000 }, false),
    await run('f30', f30, {}, true));
  await worstCase(db, run, report, queries);
  closeHippoDb(db);
}

// A 20% filter whose rows all sit in other clusters: the walk finds nothing near the query, spends its budget, then
// the exact scan answers. `graph_null` counts queries the graph handed back to the scan.
async function worstCase(db, run, report, queries) {
  const { graphCandidates } = await import('../../dist/db/vector-graph-search.js');
  const far = " AND m.content LIKE 'far %'";
  const opts = { minGraphRows: 1000 };
  const nulls = queries.filter((q) => graphCandidates(db, q, K, { where: far, params: [] }, opts) === null).length;
  const graph = await run(`worst (20% far rows, minGraphRows 1000, graph_null ${nulls}/${QUERIES})`, far, opts, false);
  report(graph, await run('worst', far, {}, true));
}
