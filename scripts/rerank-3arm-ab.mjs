#!/usr/bin/env node
/** Lane 15 of docs/EXPERIMENT-PROTOCOL.md: the deciding head-to-head. One
 *  shared candidate set per query, three arms (base/cross-encoder/jev) via the
 *  real getReranker(), so the two prior single-harness deltas finally compare.
 *  RERANK_ARM=clef-flash|clef swaps the third arm (CLF4 dev comparison). */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hybridSearch } from '../dist/search/hybrid.js';
import { buildCorpus } from '../dist/search/bm25.js';
import { loadAllEntries } from '../dist/store/entry-reads.js';
import { getReranker } from '../dist/rerankers/index.js';

// Literal, not new Date(): a bare Date() drifted 26min between Lane 12/13 runs
// and moved a rank. Passing `now` below also short-circuits HIPPO_FAKE_NOW.
const NOW = new Date('2026-09-18T14:31:52.073Z');

const BOOTSTRAP_DRAWS = 2000;
const CANDIDATE_TOPK = 40;
const BUDGET = 4000;
const MIN_RESULTS = 1;
const ALPHA_LO = 0.00625, ALPHA_HI = 0.99375; // 98.75% CI, alpha 0.0125 (verdict)
const DIAG_LO = 0.025, DIAG_HI = 0.975; // nominal 95%, diagnostic only
const ARM = process.env.RERANK_ARM?.trim() || 'jev';
if (!['jev', 'clef-flash', 'clef'].includes(ARM)) { console.error(`RERANK_ARM must be jev, clef-flash or clef, not ${ARM}.`); process.exit(1); }
// A 300-query clef run is far past the Workers AI free allocation, so hosted needs an explicit opt-in.
if (ARM !== 'jev' && !process.env.HIPPO_CLEF_ENDPOINT?.trim() &&process.env.RERANK_ALLOW_HOSTED !== '1') {
  console.error('Set HIPPO_CLEF_ENDPOINT to a private CLEF server, or RERANK_ALLOW_HOSTED=1 to bill Workers AI.');
  process.exit(1);
}
const COST_PER_CALL_USD = ARM === 'jev' ? 0.0004 : 0;
const COST_CAP_USD = 1.0;
const JEV_CONCURRENCY = Number(process.env.RERANK_CONCURRENCY) > 0 ? Number(process.env.RERANK_CONCURRENCY) : 8;
// The Jev path keeps its frozen Lane 15 name; other arms are dated by the day they ran so a rerun never overwrites.
const OUTPUT_PATH = join('results', ARM === 'jev' ? 'rerank-3arm-2026-09-18.json' : `rerank-3arm-${ARM}-${new Date().toISOString().slice(0, 10)}.json`);
const LANE12_CONTROL = { 'recall@budget': 0.6967, 'R@1': 0.2633, 'R@5': 0.4600, MRR: 0.3608 };

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
if (ARM === 'jev' && !apiKey) { console.error('TYPESAFE_API_KEY is not set.'); process.exit(1); }

let s = 4242; // same seed as crossenc-rerank-ab.mjs
const rng = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const f = (x) => (Number.isFinite(x) ? x.toFixed(4) : ' n/a ');
const median = (xs) => { const c = [...xs].sort((a, b) => a - b); const m = Math.floor(c.length / 2); return c.length % 2 ? c[m] : (c[m - 1] + c[m]) / 2; };
const quantile = (xs, p) => { const c = [...xs].sort((a, b) => a - b); return c[Math.min(c.length - 1, Math.floor(c.length * p))]; };

// A frozen copy keeps a run split across days on one corpus; the live store grows between halves.
const hippoRoot = process.env.RERANK_HIPPO_ROOT?.trim() || join(homedir(), '.hippo');
// Workers AI's free allocation is per day, so a hosted run caps its calls and resumes from cached answers.
const MAX_CALLS = Number(process.env.RERANK_MAX_CALLS) > 0 ? Number(process.env.RERANK_MAX_CALLS) : Infinity;
const CACHE_DIR = process.env.RERANK_CACHE_DIR?.trim() || null;
const dir = process.env.RERANK_QUERIES_DIR || 'evals/paraphrase';
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

const expectedCost = cases.length * COST_PER_CALL_USD;
console.log(`Expected ${ARM} cost: ${cases.length} calls x $${COST_PER_CALL_USD} = $${expectedCost.toFixed(4)}`);
if (expectedCost > COST_CAP_USD) {
  console.error(`STOPPING before any calls: expected cost $${expectedCost.toFixed(2)} exceeds the $${COST_CAP_USD.toFixed(2)} cap.`);
  process.exit(1);
}

const corpus = buildCorpus(entries.map((e) => `${e.content} ${e.tags.join(' ')}`));
const SEARCH_OPTS = { budget: 1000000, hippoRoot, preparedCorpus: corpus, minResults: 50, mmr: true, now: NOW };

/** hippo's real cut (search.ts:777-786), ported so all three arms can share
 *  one hybridSearch call instead of three separately-budgeted ones. */
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

async function runPool(items, worker, concurrency) {
  const out = Array.from({ length: items.length });
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i]);
    }
  }));
  return out;
}

const ceReranker = getReranker('cross-encoder');
const jevReranker = getReranker(ARM);

// crossEncoderReranker fails OPEN (identity order + a console.warn) rather than
// throwing, so a silent fallback would look like a real result without this spy.
let fallbackWarning = null;
const realWarn = console.warn;
console.warn = (...a) => { fallbackWarning = a.join(' '); realWarn(...a); };
const warmup = [{ entry: { id: '__warmup__', content: 'warm up the cross encoder model before timing real queries' }, score: 1, tokens: 10 }];
let modelLoadMs = null;
try {
  const t0 = performance.now();
  await ceReranker('warm up query', warmup, { topK: 1 });
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
  process.exit(1);
}
console.error(`cross-encoder model load ok: ${modelLoadMs.toFixed(1)}ms (warmup excluded from per-query timings)\n`);

// ---------- Phase 1: one hybridSearch + cross-encoder pass per query ----------
const rows = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const candidates = await hybridSearch(c.query, entries, SEARCH_OPTS);
  const preRerankRank = rankIn(candidates, c.id);

  const baseCut = applyBudget(candidates, BUDGET, MIN_RESULTS);
  const baseRank = rankIn(baseCut, c.id);

  const head = candidates.slice(0, CANDIDATE_TOPK);
  const tail = candidates.slice(CANDIDATE_TOPK);
  const ceHead = await ceReranker(c.query, candidates, { topK: CANDIDATE_TOPK });
  const ceOrdered = [...ceHead, ...tail];
  const ceCut = applyBudget(ceOrdered, BUDGET, MIN_RESULTS);
  const ceRank = rankIn(ceCut, c.id);
  const ceTargetInHead = ceHead.find((r) => r.entry.id === c.id);

  rows.push({
    id: c.id, query: c.query, candidates, head, tail,
    candidateCount: candidates.length,
    preRerankRank: Number.isFinite(preRerankRank) ? preRerankRank : null,
    baseRank, baseCutSize: baseCut.length,
    ceHead, ceRank, ceCutSize: ceCut.length,
    ceScore: ceTargetInHead ? ceTargetInHead.rerankScore : null,
    ceTop1Changed: ceOrdered[0]?.entry.id !== candidates[0]?.entry.id,
  });
  if ((i + 1) % 50 === 0) console.error(`  phase 1: ${i + 1}/${cases.length}`);
}
console.error(`phase 1 done: ${rows.length} candidate sets built, cross-encoder scored\n`);

// ---------- Phase 2: Jev calls, pooled for wall-clock, one call per query ----------
// Aggregate-only spy: dist/rerankers/jev.ts is frozen for this run (a second
// agent is building concurrently), so outcomes are read off fetch, not edited in.
const jevStats = { calls: 0, ok: 0, failed: 0, partial: 0, cached: 0, inputTokens: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  jevStats.calls++;
  let expected = null;
  try { expected = Object.keys(JSON.parse(init?.body ?? '{}').questions ?? {}).length; } catch { /* not a Jev call shape */ }
  try {
    const res = await realFetch(input, init);
    if (!res.ok) { jevStats.failed++; return res; }
    if (expected != null) {
      try {
        const body = await res.clone().json();
        const answered = Object.values(body?.result?.answers ?? body?.answers ?? {}).filter((a) => Number.isFinite(a?.noul) && a.noul >= 0 && a.noul <= 1).length;
        jevStats.inputTokens += Number(body?.result?.usage?.input_tokens ?? body?.usage?.input_tokens) || 0;
        if (answered < expected) jevStats.partial++; else jevStats.ok++;
      } catch { jevStats.partial++; }
    } else {
      jevStats.ok++;
    }
    return res;
  } catch (err) {
    jevStats.failed++;
    throw err;
  }
};

console.error(`=== ${ARM} arm: ${rows.length} calls, concurrency ${JEV_CONCURRENCY} ===\n`);
if (CACHE_DIR) mkdirSync(CACHE_DIR, { recursive: true });
const cachePath = (row) => join(CACHE_DIR, `${row.id}.json`);
let started = 0;
const jevOut = await runPool(rows, async (row) => {
  if (CACHE_DIR && existsSync(cachePath(row))) {
    const hit = JSON.parse(readFileSync(cachePath(row), 'utf8'));
    const byCand = new Map(row.candidates.map((r) => [r.entry.id, r]));
    jevStats.cached++;
    return { jevHead: hit.head.map((h) => ({ ...byCand.get(h.id), ...h.ranks })), ms: hit.ms };
  }
  if (started >= MAX_CALLS) return null;
  started++;
  const t0 = Date.now();
  const jevHead = await jevReranker(row.query, row.candidates, { topK: CANDIDATE_TOPK });
  const ms = Date.now() - t0;
  // Fallbacks are not cached, so a resumed run asks again instead of freezing a failure.
  if (CACHE_DIR && !jevHead[0]?.rerankProvenance?.fallbackReason) {
    const head = jevHead.map((r) => ({ id: r.entry.id, ranks: { rerankScore: r.rerankScore, preRerankRank: r.preRerankRank, postRerankRank: r.postRerankRank, rerankProvenance: r.rerankProvenance } }));
    writeFileSync(cachePath(row), JSON.stringify({ query: row.query, ms, head }));
  }
  return { jevHead, ms };
}, JEV_CONCURRENCY);
globalThis.fetch = realFetch;

const missing = jevOut.filter((o) => o === null).length;
if (missing > 0) {
  console.log(`INCOMPLETE: ${rows.length - missing}/${rows.length} queries scored (${jevStats.cached} cached, ${jevStats.calls} new calls, ${jevStats.inputTokens} input tokens). Rerun with the same RERANK_CACHE_DIR to resume; no verdict until every query is scored.`);
  process.exit(0);
}

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const { jevHead, ms } = jevOut[i];
  const jevOrdered = [...jevHead, ...row.tail];
  const jevCut = applyBudget(jevOrdered, BUDGET, MIN_RESULTS);
  row.jevRank = rankIn(jevCut, row.id);
  row.jevCutSize = jevCut.length;
  row.jevMs = ms;
  row.jevHead = jevHead;
  row.jevTop1Changed = jevOrdered[0]?.entry.id !== row.candidates[0]?.entry.id;
  const jevTargetInHead = jevHead.find((r) => r.entry.id === row.id);
  row.jevScore = jevTargetInHead ? jevTargetInHead.rerankScore : null;

  // Exact-equality fallback check: on failure jev.ts sets rerankScore = r.score
  // for every head item, which a real noul probability never coincidentally matches.
  const origScoreById = new Map(row.head.map((r) => [r.entry.id, r.score]));
  row.jevFellBack = jevHead.every((r) => r.rerankScore === origScoreById.get(r.entry.id));
  row.fallbackReason = jevHead[0]?.rerankProvenance?.fallbackReason ?? null;
}
console.error('phase 2 done\n');

// ---------- Metrics ----------
const at = (r, k) => r.filter((x) => x <= k).length / r.length;
const METRICS = {
  'recall@budget': (r) => r.filter((x) => Number.isFinite(x)).length / r.length,
  'R@1': (r) => at(r, 1),
  'R@5': (r) => at(r, 5),
  MRR: (r) => r.reduce((a, x) => a + (Number.isFinite(x) ? 1 / x : 0), 0) / r.length,
};
const PRIMARY = 'R@1';

const baseRanks = rows.map((r) => r.baseRank);
const ceRanks = rows.map((r) => r.ceRank);
const jevRanks = rows.map((r) => r.jevRank);
const baseCutSizes = rows.map((r) => r.baseCutSize);

console.log('\n======================================================================');
console.log('BASE ARM CONTROL');
console.log('======================================================================');
console.log(`hippoRoot: ${hippoRoot}`);
console.log(`NOW pinned: ${NOW.toISOString()}`);
console.log(`usable cases: ${rows.length}`);
console.log(`median returned-set size (post-budget-cut): ${median(baseCutSizes)}`);
for (const [name, fn] of Object.entries(METRICS)) console.log(`  ${name.padEnd(14)} ${f(fn(baseRanks))}`);
// Sanity check: same NOW pin as Lane 12, so the base arm should reproduce its control numbers exactly.
console.log('\nReproduction check against Lane 12 control (docs/EXPERIMENT-PROTOCOL.md:1949-1955, same NOW pin):');
for (const [k, v] of Object.entries(LANE12_CONTROL)) {
  const mine = METRICS[k](baseRanks);
  console.log(`  ${k.padEnd(14)} lane12=${f(v)} mine=${f(mine)} ${Math.abs(mine - v) < 0.0001 ? 'MATCH' : 'DIFFERS'}`);
}
console.log('======================================================================\n');

const idxMatrix = Array.from({ length: BOOTSTRAP_DRAWS }, () => Array.from({ length: rows.length }, () => Math.floor(rng() * rows.length)));

function contrast(aRanks, bRanks) {
  // b - a, paired on the SAME idxMatrix as every other contrast in this report.
  const deltas = Object.fromEntries(Object.keys(METRICS).map((k) => [k, []]));
  for (const draw of idxMatrix) {
    const aSample = draw.map((k) => aRanks[k]);
    const bSample = draw.map((k) => bRanks[k]);
    for (const [name, fn] of Object.entries(METRICS)) deltas[name].push(fn(bSample) - fn(aSample));
  }
  const table = {};
  for (const [name, fn] of Object.entries(METRICS)) {
    const a = fn(aRanks), b = fn(bRanks);
    table[name] = {
      a, b, delta: b - a,
      ci_98_75: { lo: quantile(deltas[name], ALPHA_LO), hi: quantile(deltas[name], ALPHA_HI) },
      ci_95: { lo: quantile(deltas[name], DIAG_LO), hi: quantile(deltas[name], DIAG_HI) },
    };
  }
  return table;
}

const contrasts = {
  [`${ARM}-vs-base`]: { aLabel: 'base', bLabel: ARM, table: contrast(baseRanks, jevRanks) },
  'crossenc-vs-base': { aLabel: 'base', bLabel: 'cross-enc', table: contrast(baseRanks, ceRanks) },
  [`${ARM}-vs-crossenc`]: { aLabel: 'cross-enc', bLabel: ARM, table: contrast(ceRanks, jevRanks) },
};

function printContrast(name, { aLabel, bLabel, table }) {
  console.log(`\n${name}  (${bLabel} - ${aLabel}), n=${rows.length}\n`);
  console.log(`metric          ${aLabel.padEnd(10)} ${bLabel.padEnd(10)} delta       98.75% CI (verdict)      95% CI (diagnostic)      read`);
  for (const [metric, t] of Object.entries(table)) {
    const read = t.ci_98_75.lo > 0 ? `${bLabel.toUpperCase()} WINS` : t.ci_98_75.hi < 0 ? `${aLabel.toUpperCase()} WINS` : 'no difference';
    console.log(`${metric.padEnd(14)}  ${f(t.a)}   ${f(t.b)}   ${t.delta >= 0 ? '+' : ''}${f(t.delta)}   [${f(t.ci_98_75.lo)}, ${f(t.ci_98_75.hi)}]    [${f(t.ci_95.lo)}, ${f(t.ci_95.hi)}]    ${read}`);
  }
}
for (const [name, c] of Object.entries(contrasts)) printContrast(name, c);

// ---------- Integrity checks ----------
function distinctStats(scores) {
  const finite = scores.filter((x) => Number.isFinite(x));
  return { count: finite.length, distinct: new Set(finite).size, min: finite.length ? Math.min(...finite) : null, max: finite.length ? Math.max(...finite) : null };
}
const ceAllScores = rows.flatMap((r) => r.ceHead.map((x) => x.rerankScore));
const jevAllScores = rows.flatMap((r) => r.jevHead.map((x) => x.rerankScore));
const ceScoreStats = distinctStats(ceAllScores);
const jevScoreStats = distinctStats(jevAllScores);
// Target-only view for direct comparison to Lane 12/13's recorded "224 distinct
// ceScore values" convention (docs/EXPERIMENT-PROTOCOL.md); the all-head-items
// stat above is the stricter check that would also have caught the Lane 12 bug.
const ceTargetStats = distinctStats(rows.map((r) => r.ceScore).filter(Number.isFinite));
const jevTargetStats = distinctStats(rows.map((r) => r.jevScore).filter(Number.isFinite));
const ceVoid = ceScoreStats.distinct <= 1;
const jevVoid = jevScoreStats.distinct <= 1;
const ceTop1ChangedCount = rows.filter((r) => r.ceTop1Changed).length;
const jevTop1ChangedCount = rows.filter((r) => r.jevTop1Changed).length;
const jevFellBackCount = rows.filter((r) => r.jevFellBack).length;
const fallbackReasons = {};
for (const r of rows) if (r.fallbackReason) fallbackReasons[r.fallbackReason] = (fallbackReasons[r.fallbackReason] ?? 0) + 1;

console.log('\n======================================================================');
console.log('INTEGRITY CHECKS');
console.log('======================================================================');
console.log('base arm calls hippo\'s real hybridSearch (dist/search.js) over the full entry set; the budget cut is a line-for-line port of search.ts:777-786, applied once per arm to that one shared output (not a reimplemented search or ranking path).');
console.log(`cross-encoder arm: ${ceVoid ? 'VOID -- DEGENERATE' : 'non-degenerate'}: ${ceScoreStats.distinct} distinct scores over ${ceScoreStats.count} head entries, min ${f(ceScoreStats.min)}, max ${f(ceScoreStats.max)}`);
console.log(`  target-only (cf. Lane 12/13): ${ceTargetStats.distinct} distinct over ${ceTargetStats.count}, min ${f(ceTargetStats.min)}, max ${f(ceTargetStats.max)}`);
console.log(`${ARM} arm:`.padEnd(19) + `${jevVoid ? 'VOID -- DEGENERATE' : 'non-degenerate'}: ${jevScoreStats.distinct} distinct scores over ${jevScoreStats.count} head entries, min ${f(jevScoreStats.min)}, max ${f(jevScoreStats.max)}`);
console.log(`  target-only (cf. Lane 12/13): ${jevTargetStats.distinct} distinct over ${jevTargetStats.count}, min ${f(jevTargetStats.min)}, max ${f(jevTargetStats.max)}`);
console.log(`top-1 changed vs base: cross-encoder ${ceTop1ChangedCount}/${rows.length}, ${ARM} ${jevTop1ChangedCount}/${rows.length}`);
console.log(`${ARM} HTTP calls: ${jevStats.calls} total, ${jevStats.ok} ok, ${jevStats.failed} failed, ${jevStats.partial} partial (partial = ok response missing a valid noul for >=1 candidate); ${jevStats.cached} answers from cache; ${jevStats.inputTokens} input tokens this run`);
console.log(`${ARM} per-query fallback (base order kept for that query's head): ${jevFellBackCount}/${rows.length}`);
for (const [reason, n] of Object.entries(fallbackReasons)) console.log(`  ${n} x ${reason}`);

const actualCost = jevStats.calls * COST_PER_CALL_USD;
console.log(`\n${ARM} cost: ${jevStats.calls} calls x $${COST_PER_CALL_USD} = $${actualCost.toFixed(4)} (expected $${expectedCost.toFixed(4)})`);

console.log('\n======================================================================');
console.log(`VERDICT: Amendment 3 gate -- "${ARM} ships only if it beats the cross-encoder"`);
console.log('======================================================================');
let verdict;
// A fallen-back query keeps the base order and its varied scores, so the degenerate check cannot see it.
if (jevFellBackCount > 0) {
  verdict = `UNDECIDABLE: ${ARM} fell back on ${jevFellBackCount}/${rows.length} queries, reported VOID not flat.`;
} else if (jevVoid) {
  verdict = `UNDECIDABLE: ${ARM} arm is degenerate (<=1 distinct score), reported VOID not flat.`;
} else if (ceVoid) {
  verdict = 'UNDECIDABLE: cross-encoder arm is degenerate (<=1 distinct score), reported VOID not flat.';
} else {
  const gate = contrasts[`${ARM}-vs-crossenc`].table[PRIMARY].ci_98_75;
  verdict = gate.lo > 0
    ? `${ARM.toUpperCase()} CLEARS THE GATE: beats cross-encoder on ${PRIMARY}, 98.75% CI [${f(gate.lo)}, ${f(gate.hi)}] excludes zero upward.`
    : gate.hi < 0
      ? `${ARM.toUpperCase()} FAILS THE GATE: cross-encoder beats ${ARM} on ${PRIMARY}, 98.75% CI [${f(gate.lo)}, ${f(gate.hi)}] excludes zero downward.`
      : `GATE NOT CLEARED: ${ARM}-vs-crossenc ${PRIMARY} 98.75% CI [${f(gate.lo)}, ${f(gate.hi)}] includes zero. The free local cross-encoder matches ${ARM} here; ${ARM} does not ship on this evidence.`;
}
console.log(verdict);

const jevVsCeR1Delta = contrasts[`${ARM}-vs-crossenc`].table['R@1'].delta;
console.log(`\nPrediction check: ${ARM} beats cross-encoder on R@1 by LESS than 0.18 (0.3333-0.1533, the two prior single-harness deltas). Observed delta: ${jevVsCeR1Delta >= 0 ? '+' : ''}${f(jevVsCeR1Delta)}.`);

// ---------- Output ----------
mkdirSync('results', { recursive: true });
const outRows = rows.map((r) => ({
  id: r.id, query: r.query, candidateCount: r.candidateCount, preRerankRank: r.preRerankRank,
  baseRank: r.baseRank, baseCutSize: r.baseCutSize,
  ceRank: r.ceRank, ceCutSize: r.ceCutSize, ceScore: r.ceScore, ceTop1Changed: r.ceTop1Changed,
  jevRank: r.jevRank, jevCutSize: r.jevCutSize, jevScore: r.jevScore, jevTop1Changed: r.jevTop1Changed,
  jevFellBack: r.jevFellBack, jevMs: r.jevMs,
}));

writeFileSync(OUTPUT_PATH, JSON.stringify({
  protocol: 'docs/EXPERIMENT-PROTOCOL.md, LANE 15 (deciding head-to-head)',
  third_arm: ARM,
  primary_metric: PRIMARY,
  now: NOW.toISOString(),
  hippo_root: hippoRoot,
  search_options: { budget: 1000000, minResults: 50, mmr: true },
  budget_cut: { budget: BUDGET, minResults: MIN_RESULTS },
  candidate_depth: CANDIDATE_TOPK,
  usable_cases: rows.length,
  base_arm_control: {
    median_returned_set_size: median(baseCutSizes),
    metrics: Object.fromEntries(Object.entries(METRICS).map(([k, fn]) => [k, fn(baseRanks)])),
    lane12_reproduction: LANE12_CONTROL,
  },
  integrity: {
    cross_encoder: { void: ceVoid, ...ceScoreStats, target_only: ceTargetStats },
    jev: { void: jevVoid, ...jevScoreStats, target_only: jevTargetStats },
    top1_changed: { cross_encoder: ceTop1ChangedCount, jev: jevTop1ChangedCount, total: rows.length },
    jev_http: jevStats,
    jev_fallback_count: jevFellBackCount,
    fallback_reasons: fallbackReasons,
  },
  cost: { expected_usd: expectedCost, actual_usd: actualCost, calls: jevStats.calls, cost_per_call_usd: COST_PER_CALL_USD },
  contrasts,
  verdict,
  rows: outRows,
}, null, 2));
console.log(`\nWrote ${OUTPUT_PATH}`);
