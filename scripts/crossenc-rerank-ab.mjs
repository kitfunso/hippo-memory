#!/usr/bin/env node
/** Lane 12 (AMENDMENT 3) of docs/EXPERIMENT-PROTOCOL.md: base ranking vs
 *  hippo's own free local cross-encoder reranker, same ~300 paraphrase
 *  queries as Lane 9b. No API calls, $0. Mirrors jev-retrieval-ab-paraphrase.mjs. */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hybridSearch } from '../dist/search/hybrid.js';
import { buildCorpus } from '../dist/search/bm25.js';
import { loadAllEntries } from '../dist/store.js';
import { getReranker } from '../dist/rerankers/index.js';

const BOOTSTRAP_DRAWS = 2000;
const CANDIDATE_TOPK = 40;
const BUDGET = 4000;
const ALPHA_LO = 0.00625, ALPHA_HI = 0.99375; // 98.75% CI, Bonferroni 0.0125 (AMENDMENT 3)
const DIAG_LO = 0.025, DIAG_HI = 0.975; // nominal 95%, diagnostic only

const hippoRoot = join(homedir(), '.hippo');

let s = 4242;
const rng = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const f = (x) => (Number.isFinite(x) ? x.toFixed(4) : ' n/a ');
const median = (xs) => { const copy = [...xs].sort((a, b) => a - b); const m = Math.floor(copy.length / 2); return copy.length % 2 ? copy[m] : (copy[m - 1] + copy[m]) / 2; };
const quantile = (xs, p) => { const copy = [...xs].sort((a, b) => a - b); return copy[Math.min(copy.length - 1, Math.floor(copy.length * p))]; };

const dir = 'evals/paraphrase';
const queries = [];
for (const fn of readdirSync(dir).filter((x) => /^queries\d+\.json$/.test(x)).sort()) {
  const part = JSON.parse(readFileSync(join(dir, fn), 'utf8'));
  queries.push(...part);
  console.error(`  ${fn}: ${part.length} queries`);
}
console.error(`merged ${queries.length} paraphrase queries\n`);

const entries = loadAllEntries(hippoRoot);
const byId = new Map(entries.map((e) => [e.id, e]));
const cases = queries.filter((q) => byId.has(q.id) && q.query?.trim());
console.error(`corpus ${entries.length} entries; usable cases: ${cases.length} (dropped ${queries.length - cases.length} with no matching entry)\n`);

const corpus = buildCorpus(entries.map((e) => `${e.content} ${e.tags.join(' ')}`));
const NOW = new Date(); // pinned once so recency decay cannot drift mid-run
const SEARCH_OPTS = { budget: 1000000, hippoRoot, preparedCorpus: corpus, minResults: 50, mmr: true, now: NOW };

/** hippo's real production cut (search.ts:410-411, 777-786): admit at least
 *  minResults, then stop once the running token total exceeds budget. */
function applyBudget(ordered, budget, minResults) {
  const admitted = [];
  let used = 0;
  for (const r of ordered) {
    if (admitted.length >= minResults && used + r.tokens > budget) continue;
    used += r.tokens;
    admitted.push(r);
  }
  return admitted;
}

const rankIn = (list, id) => { const i = list.findIndex((r) => r.entry.id === id); return i < 0 ? Infinity : i + 1; };

const crossEncoderReranker = getReranker('cross-encoder');

// crossEncoderReranker fails OPEN (identity order + a console.warn) rather than
// throwing, so a silent fallback would look like a real result without this spy.
let fallbackWarning = null;
const realWarn = console.warn;
console.warn = (...a) => { fallbackWarning = a.join(' '); realWarn(...a); };

const warmup = [{ entry: { id: '__warmup__', content: 'warm up the cross encoder model before timing real queries' }, score: 1, tokens: 10 }];
let modelLoadMs = null;
try {
  const t0 = performance.now();
  await crossEncoderReranker('warm up query', warmup, { topK: 1 });
  modelLoadMs = performance.now() - t0;
} catch (err) {
  console.error('CROSS-ENCODER FAILED TO LOAD: threw during the warmup call.');
  console.error(err?.stack ?? String(err));
  process.exit(1);
}
console.warn = realWarn;

if (fallbackWarning) {
  console.error('CROSS-ENCODER UNAVAILABLE: reranker fell back to identity ordering, not a real model call.');
  console.error('Captured warning:', fallbackWarning);
  console.error('Reporting this failure rather than producing numbers from a substitute.');
  process.exit(1);
}
console.error(`cross-encoder model load ok: ${modelLoadMs.toFixed(1)}ms (one warmup inference, excluded from per-query timings)\n`);

const out = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const candidates = await hybridSearch(c.query, entries, SEARCH_OPTS);
  const baseCut = applyBudget(candidates, BUDGET, 1);
  const baseRank = rankIn(baseCut, c.id);

  const t0 = performance.now();
  const rerankedHead = await crossEncoderReranker(c.query, candidates, { topK: CANDIDATE_TOPK });
  const ceLatencyMs = performance.now() - t0;
  const ceOrdered = [...rerankedHead, ...candidates.slice(CANDIDATE_TOPK)];
  const ceCut = applyBudget(ceOrdered, BUDGET, 1);
  const ceRank = rankIn(ceCut, c.id);

  const preRerankRank = rankIn(candidates, c.id);
  const inTop40 = preRerankRank <= CANDIDATE_TOPK;
  const targetInHead = inTop40 ? rerankedHead.find((r) => r.entry.id === c.id) : undefined;

  out.push({
    id: c.id, query: c.query,
    candidateCount: candidates.length,
    preRerankRank: Number.isFinite(preRerankRank) ? preRerankRank : null,
    inTop40,
    ceScore: targetInHead ? targetInHead.rerankScore : null,
    postRerankRankAmongHead: targetInHead ? targetInHead.postRerankRank : null,
    baseRank: Number.isFinite(baseRank) ? baseRank : null,
    baseCutSize: baseCut.length,
    ceRank: Number.isFinite(ceRank) ? ceRank : null,
    ceCutSize: ceCut.length,
    ceLatencyMs,
  });
  if ((i + 1) % 50 === 0) console.error(`  ${i + 1}/${cases.length}`);
}

const at = (r, k) => r.filter((x) => x <= k).length / r.length;
const METRICS = {
  'recall@budget': (r) => r.filter((x) => Number.isFinite(x)).length / r.length,
  'R@1': (r) => at(r, 1),
  'R@5': (r) => at(r, 5),
  MRR: (r) => r.reduce((a, x) => a + (Number.isFinite(x) ? 1 / x : 0), 0) / r.length,
};
const PRIMARY = 'recall@budget';

const baseRanks = out.map((o) => o.baseRank ?? Infinity);
const ceRanks = out.map((o) => o.ceRank ?? Infinity);
const baseCutSizes = out.map((o) => o.baseCutSize);

console.log('\n======================================================================');
console.log('BASE ARM CONTROL (compare against scripts/jev-rerank-query.mjs)');
console.log('======================================================================');
console.log(`hippoRoot: ${hippoRoot}`);
console.log('search: hybridSearch(query, entries, { budget: 1000000, hippoRoot, preparedCorpus, minResults: 50, mmr: true, now: NOW })');
console.log(`  then cut at budget=4000, minResults=1 (search.ts:410-411, 777-786); NOW pinned at ${NOW.toISOString()}`);
console.log(`usable cases: ${cases.length}`);
console.log(`median returned-set size (post-budget-cut): ${median(baseCutSizes)}`);
for (const [name, fn] of Object.entries(METRICS)) console.log(`  ${name.padEnd(14)} ${f(fn(baseRanks))}`);
console.log('======================================================================\n');

// One resample index matrix per report, shared across every metric below (not redrawn per metric).
const idxMatrix = Array.from({ length: BOOTSTRAP_DRAWS }, () => Array.from({ length: out.length }, () => Math.floor(rng() * out.length)));
const deltas = Object.fromEntries(Object.keys(METRICS).map((k) => [k, []]));
for (const draw of idxMatrix) {
  const bSample = draw.map((k) => baseRanks[k]);
  const cSample = draw.map((k) => ceRanks[k]);
  for (const [name, fn] of Object.entries(METRICS)) deltas[name].push(fn(cSample) - fn(bSample));
}

console.log(`Lane 12 (AMENDMENT 3): base vs cross-encoder, n=${out.length}\n`);
console.log('metric          base       cross-enc   delta       98.75% CI (verdict)      95% CI (diagnostic)      read');
const table = {}, ci9875 = {}, ci95 = {};
for (const [name, fn] of Object.entries(METRICS)) {
  const b = fn(baseRanks), ce = fn(ceRanks);
  ci9875[name] = { lo: quantile(deltas[name], ALPHA_LO), hi: quantile(deltas[name], ALPHA_HI) };
  ci95[name] = { lo: quantile(deltas[name], DIAG_LO), hi: quantile(deltas[name], DIAG_HI) };
  table[name] = { base: b, crossEncoder: ce, delta: ce - b };
  const read = ci9875[name].lo > 0 ? 'CE WINS' : ci9875[name].hi < 0 ? 'CE LOSES' : 'no difference';
  console.log(`${name.padEnd(14)}  ${f(b)}     ${f(ce)}    ${ce - b >= 0 ? '+' : ''}${f(ce - b)}   [${f(ci9875[name].lo)}, ${f(ci9875[name].hi)}]    [${f(ci95[name].lo)}, ${f(ci95[name].hi)}]    ${read}`);
}

const verdict = ci9875[PRIMARY].lo > 0 && !(ci9875['R@1'].hi < 0) ? 'CROSS-ENCODER BEATS BASE' : 'DO NOT PROMOTE';
console.log(`\nVERDICT: ${verdict}  (rule: ${PRIMARY} 98.75% CI excludes 0 upward AND R@1 does not lose)`);

const ceLatencies = out.map((o) => o.ceLatencyMs);
const meanLatency = ceLatencies.reduce((a, x) => a + x, 0) / ceLatencies.length;
console.log(`\ncross-encoder rerank latency per query (ms, excludes model load): median ${median(ceLatencies).toFixed(1)}, mean ${meanLatency.toFixed(1)}`);
console.log(`model load time (one-off): ${modelLoadMs.toFixed(1)}ms`);
console.log('cost: $0 API spend either arm; the tradeoff against Jev is this latency, not dollars.');

mkdirSync('results', { recursive: true });
const outPath = join('results', 'crossenc-rerank-ab-2026-09-18.json');
writeFileSync(outPath, JSON.stringify({
  protocol: 'docs/EXPERIMENT-PROTOCOL.md AMENDMENT 3, Lane 12',
  primary_metric: PRIMARY,
  model: 'Xenova/ms-marco-MiniLM-L-6-v2',
  reranker_package: '@xenova/transformers',
  now: NOW.toISOString(),
  hippo_root: hippoRoot,
  search_options_candidates: { budget: 1000000, minResults: 50, mmr: true },
  budget_cut: { budget: BUDGET, minResults: 1 },
  usable_cases: cases.length,
  base_arm_control: {
    median_returned_set_size: median(baseCutSizes),
    metrics: Object.fromEntries(Object.entries(METRICS).map(([k, fn]) => [k, fn(baseRanks)])),
  },
  metrics: table,
  ci_98_75_verdict: ci9875,
  ci_95_diagnostic: ci95,
  verdict,
  latency_ms: { model_load: modelLoadMs, per_query_median: median(ceLatencies), per_query_mean: meanLatency },
  rows: out,
}, null, 2));
console.log(`\nWrote ${outPath}`);
