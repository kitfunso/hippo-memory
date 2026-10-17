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

// Each row gets a hash bucket h in 0..99: h < 30 has scope NULL (f30), the rest scope `b<h>`, so bucket ranges give
// f50, f20 and f10. Clusters c % 5 === 0 hold the "far" rows the worst case admits, and no query sits in one of them.
const FILTERS = {
  f100: '',
  f50: " AND (m.scope IS NULL OR m.scope < 'b50')",
  f30: ' AND m.scope IS NULL',
  f20: " AND m.scope >= 'b30' AND m.scope < 'b50'",
  f10: " AND m.scope >= 'b30' AND m.scope < 'b40'",
};
const FORCED = { minGraphRows: 1000, minSelectivity: 0 };
const COLD_RUNS = 11;

if (process.env.BENCH_COLD) {
  await coldChild();
  process.exit(0);
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
    const res = searchGraph(graph, q, { k: K, ef, admit, vectorsOf: (ns) => ns.map(vecOf) });
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

function sqliteRows(createMemory) {
  const centres = Array.from({ length: N / 100 }, () => unit(Float32Array.from({ length: DIM }, gauss)));
  const noise = 1.17 / Math.sqrt(DIM);
  const point = (c) => unit(Float32Array.from(centres[c], (x) => x + gauss() * noise));
  const vectors = Array.from({ length: N }, (_, i) => Array.from(point(i % centres.length)));
  const entries = vectors.map((_, i) => {
    const h = (Math.imul(i, 2654435761) >>> 0) % 100;
    const kind = (i % centres.length) % 5 === 0 ? 'far' : 'near';
    return createMemory(`${kind} ${i}`, { tenantId: 'default', scope: h < 30 ? null : `b${h}` });
  });
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
    await sqliteRun(join(home, 'store'), home);
  } finally {
    // A failed run leaves hippo.db open, and Windows then refuses the delete; that must not hide the run's own error.
    try {
      rmSync(home, { recursive: true, force: true });
    } catch (err) {
      console.error(`bench store left at ${home}: ${err.message}`);
    }
  }
}

async function seededStore(root) {
  const { initStore } = await import('../../dist/store/open.js');
  const { createMemory } = await import('../../dist/core/memory.js');
  const { batchWriteAndDelete } = await import('../../dist/store/delete-and-batch.js');
  const { openHippoDb } = await import('../../dist/db/index.js');
  const { upsertVectors } = await import('../../dist/db/vector-store.js');
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
  return { db, queries };
}

async function sqliteRun(root, home) {
  const { closeHippoDb } = await import('../../dist/db/index.js');
  const { db, queries } = await seededStore(root);
  try {
    await timedRows(db, queries);
  } finally {
    closeHippoDb(db);
  }
  await coldRows(root, home, queries);
}

async function timedRows(db, queries) {
  const { topVectorMatches } = await import('../../dist/db/vector-store.js');
  const { keepVectorGraphLoaded } = await import('../../dist/db/vector-graph-search.js');
  // Warm rows stand for serve and MCP stdio, the hosts that opt in.
  keepVectorGraphLoaded();
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
  const exact = {};
  for (const [f, where] of Object.entries(FILTERS)) exact[f] = await run(f, where, {}, true);
  const report = (graph, base) => {
    let hit = 0;
    graph.results.forEach((ids, i) => {
      const want = new Set(base.results[i]);
      hit += ids.filter((id) => want.has(id)).length;
    });
    console.log(`sqlite ${graph.label} exact_p50_ms=${base.p50} graph_p50_ms=${graph.p50} ` +
      `recall@${K}=${(hit / (QUERIES * K)).toFixed(3)}`);
  };
  report(await run('f100', FILTERS.f100, {}, false), exact.f100);
  report(await run('f30 (auto: admitted rows under 20k, so exact)', FILTERS.f30, {}, false), exact.f30);
  for (const f of ['f50', 'f30', 'f20', 'f10']) {
    report(await run(`${f} (graph forced)`, FILTERS[f], FORCED, false), exact[f]);
  }
  await worstCase(db, run, report, queries);
}

// A 20% filter whose rows all sit in other clusters: the walk finds nothing near the query, spends its budget, then
// the exact scan answers. `graph_null` counts queries the graph handed back to the scan.
async function worstCase(db, run, report, queries) {
  const { graphCandidates } = await import('../../dist/db/vector-graph-search.js');
  const far = " AND m.content LIKE 'far %'";
  const nulls = queries.filter((q) => graphCandidates(db, q, K, { where: far, params: [] }, FORCED) === null).length;
  const graph = await run(`worst (20% far rows, graph forced, graph_null ${nulls}/${QUERIES})`, far, FORCED, false);
  report(graph, await run('worst', far, {}, true));
}

// Each cold run is a fresh process that opens the store and times its first f100 query. `cli` is a one-shot command
// (no opt-in), `exact` forces the scan by env, `graph` opts in and so pays the graph load.
async function coldRows(root, home, queries) {
  const { spawnSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const file = join(home, 'queries.json');
  writeFileSync(file, JSON.stringify(queries.slice(0, COLD_RUNS)));
  const coldOnce = (mode, i) => {
    const env = { ...process.env, BENCH_COLD: mode, BENCH_ROOT: root, BENCH_QUERIES: file, BENCH_QUERY: String(i) };
    const out = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env, encoding: 'utf8' });
    if (out.status !== 0) throw new Error(`cold ${mode} run failed: ${out.stderr}`);
    return Number(out.stdout.trim().split(/\r?\n/).pop());
  };
  const times = { cli: [], exact: [], graph: [] };
  // Modes take turns within each run, so load on the box drifts across all three alike.
  for (let i = 0; i < COLD_RUNS; i++) for (const mode of Object.keys(times)) times[mode].push(coldOnce(mode, i));
  console.log(`sqlite cold f100 (fresh process, first query) cli_p50_ms=${p50(times.cli)} ` +
    `exact_p50_ms=${p50(times.exact)} graph_opt_in_p50_ms=${p50(times.graph)}`);
}

async function coldChild() {
  const { readFileSync } = await import('node:fs');
  const { openHippoDb, closeHippoDb } = await import('../../dist/db/index.js');
  const { topVectorMatches } = await import('../../dist/db/vector-store.js');
  const { keepVectorGraphLoaded } = await import('../../dist/db/vector-graph-search.js');
  const query = JSON.parse(readFileSync(process.env.BENCH_QUERIES, 'utf8'))[Number(process.env.BENCH_QUERY)];
  if (process.env.BENCH_COLD === 'exact') process.env.HIPPO_VECTOR_INDEX = 'exact';
  else delete process.env.HIPPO_VECTOR_INDEX;
  if (process.env.BENCH_COLD === 'graph') keepVectorGraphLoaded();
  const db = openHippoDb(process.env.BENCH_ROOT);
  const t = await timed(() => topVectorMatches(db, query, K, '', [], {}));
  closeHippoDb(db);
  console.log(t.ms.toFixed(2));
}
