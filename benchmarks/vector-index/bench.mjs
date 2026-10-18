// By hand only: node benchmarks/vector-index/bench.mjs (after npm run build). Env: N, M, EFC, SEED.
import { createVectorGraph, insertNode, searchGraph } from '../../dist/search/vector-graph.js';

const N = Number(process.env.N ?? 100000);
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
