#!/usr/bin/env node
/** Lane 5 of docs/EXPERIMENT-PROTOCOL.md: paired retrieval A/B. Baseline store
 *  vs the same store with Jev's error tag auto-applied to the top-K rows.
 *  Identical queries, identical corpus. No API calls: Jev scores are on disk. */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hybridSearch, buildCorpus } from '../dist/search.js';
import { loadAllEntries } from '../dist/store.js';

const BOOTSTRAP_DRAWS = 2000;
const QUERY_TOKENS = 6;
const TOPN = 10;
const STOP = new Set(('the a an and or but if then than that this these those is are was were be been being to of in on at for with from by as it its not no do does did done have has had will would can could should must so such when where which who whom what how why all any each other some more most only own same too very just also into over under out up down off then once here there both few many much own why'.split(' ')));

const hippoRoot = join(homedir(), '.hippo');
const lane4 = JSON.parse(readFileSync('results/jev-classify-lane4-cli-holdout-2026-09-18.json', 'utf8'));

let s = 90210;
const rng = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);

const entries = loadAllEntries(hippoRoot);
console.error(`loaded ${entries.length} entries`);

const scored = new Map(lane4.rows.map((r) => [r.id, r.jev.p]));
const present = lane4.rows.filter((r) => entries.some((e) => e.id === r.id));
const baseRate = lane4.rows.filter((r) => r.label_error).length / lane4.rows.length;
const K = Math.round(baseRate * present.length);
const tagSet = new Set([...present].sort((a, b) => scored.get(b.id) - scored.get(a.id)).slice(0, K).map((r) => r.id));
console.error(`corpus rows scored by Jev: ${present.length}; tagging top ${K} (base rate ${baseRate.toFixed(3)})`);

/** The Jev arm: error tag, negative valence, doubled half-life (memory.ts:394). */
const jevEntries = entries.map((e) => (tagSet.has(e.id)
  ? { ...e, tags: [...e.tags, 'error'], emotional_valence: 'negative', half_life_days: e.half_life_days * 2 }
  : e));

function makeQuery(content) {
  const toks = [...new Set(content.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter((t) => t.length > 3 && !STOP.has(t)))];
  if (toks.length < QUERY_TOKENS) return null;
  const picked = [];
  const pool = [...toks];
  for (let i = 0; i < QUERY_TOKENS && pool.length; i++) picked.push(...pool.splice(Math.floor(rng() * pool.length), 1));
  return picked.join(' ');
}

const cases = [];
for (const r of present) {
  const e = entries.find((x) => x.id === r.id);
  const q = makeQuery(e.content);
  if (q) cases.push({ id: r.id, query: q });
}
console.error(`built ${cases.length} queries\n`);

const corpusBase = buildCorpus(entries.map((e) => `${e.content} ${e.tags.join(' ')}`));
const corpusJev = buildCorpus(jevEntries.map((e) => `${e.content} ${e.tags.join(' ')}`));

async function rankOf(query, ents, corpus, targetId) {
  const res = await hybridSearch(query, ents, {
    budget: 1000000, hippoRoot, preparedCorpus: corpus, minResults: TOPN, mmr: true,
  });
  const i = res.findIndex((r) => r.entry.id === targetId);
  return i < 0 ? Infinity : i + 1;
}

const out = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  out.push({
    id: c.id,
    base: await rankOf(c.query, entries, corpusBase, c.id),
    jev: await rankOf(c.query, jevEntries, corpusJev, c.id),
  });
  if ((i + 1) % 50 === 0) console.error(`  ${i + 1}/${cases.length}`);
}

const at = (ranks, k) => ranks.filter((r) => r <= k).length / ranks.length;
const mrr = (ranks) => ranks.reduce((a, r) => a + (Number.isFinite(r) ? 1 / r : 0), 0) / ranks.length;
const B = out.map((o) => o.base), J = out.map((o) => o.jev);
const f = (x) => x.toFixed(4);

console.log(`\nLane 5 — paired retrieval A/B, n=${out.length} queries\n`);
console.log('metric      baseline     Jev arm       delta');
const METRICS = { 'R@1': (r) => at(r, 1), 'R@5': (r) => at(r, 5), 'R@10': (r) => at(r, 10), MRR: mrr };
const table = {};
for (const [name, fn] of Object.entries(METRICS)) {
  const b = fn(B), j = fn(J);
  table[name] = { base: b, jev: j, delta: j - b };
  console.log(`${name.padEnd(10)}  ${f(b)}      ${f(j)}     ${j - b >= 0 ? '+' : ''}${f(j - b)}`);
}

if (table['R@1'].base > 0.95) {
  console.log('\nINSTRUMENT FAILURE: baseline R@1 > 0.95, no headroom. No verdict.');
}

function boot(fn) {
  const ds = [];
  for (let d = 0; d < BOOTSTRAP_DRAWS; d++) {
    const bb = [], jj = [];
    for (let i = 0; i < out.length; i++) { const k = Math.floor(rng() * out.length); bb.push(out[k].base); jj.push(out[k].jev); }
    ds.push(fn(jj) - fn(bb));
  }
  ds.sort((a, b) => a - b);
  return { lo: ds[Math.floor(ds.length * 0.025)], hi: ds[Math.floor(ds.length * 0.975)] };
}

console.log('\npaired bootstrap 95% CI on the delta\n');
const cis = {};
for (const [name, fn] of Object.entries(METRICS)) {
  cis[name] = boot(fn);
  const excl = cis[name].lo > 0 || cis[name].hi < 0;
  console.log(`${name.padEnd(10)} [${f(cis[name].lo)}, ${f(cis[name].hi)}]  ${excl ? (cis[name].lo > 0 ? 'JEV WINS' : 'JEV LOSES') : 'no difference'}`);
}

const pass = cis['R@5'].lo > 0 && !(cis['R@1'].hi < 0);
console.log(`\nVERDICT: ${pass ? 'SHIP' : 'DO NOT SHIP'} (rule: R@5 CI excludes 0 upward AND no R@1 loss)`);
const changed = out.filter((o) => o.base !== o.jev).length;
console.log(`queries whose rank changed at all: ${changed}/${out.length}`);

mkdirSync('results', { recursive: true });
const p = join('results', `jev-retrieval-ab-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(p, JSON.stringify({
  protocol: 'docs/EXPERIMENT-PROTOCOL.md Lane 5', n: out.length, tagged: K,
  metrics: table, ci: cis, verdict: pass ? 'SHIP' : 'DO NOT SHIP', changed, ranks: out,
}, null, 2));
console.log(`\nWrote ${p}`);
