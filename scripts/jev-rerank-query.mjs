#!/usr/bin/env node
/** Lanes 9a/9b/11 of docs/EXPERIMENT-PROTOCOL.md WAVE 2: does Jev seeing the QUERY beat
 *  hippo's own ranking as a selector (9a, one choice call) or a scorer (9b, 40 batched
 *  nouls)? Both lanes share one 40-candidate set and base rank per query. */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hybridSearch } from '../dist/search/hybrid.js';
import { buildCorpus } from '../dist/search/bm25.js';
import { loadAllEntries } from '../dist/store/entry-reads.js';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const COST_PER_CALL_USD = 0.0004;
const CANDIDATE_DEPTH = 40;
const TRUNCATE_CHARS = 300;
const REAL_BUDGET_TOKENS = 4000;
const REAL_MIN_RESULTS = 1;
const BOOTSTRAP_DRAWS = 2000;
const ALPHA_PRIMARY = 0.0167;
const ALPHA_DIAG = 0.05;
const CONCURRENCY = 8;
const GATE_N = 5;
const MIN_VALID_FOR_VERDICT = 30;
const OUTPUT_PATH = join('results', 'jev-rerank-query-2026-09-18.json');

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
if (!apiKey) { console.error('TYPESAFE_API_KEY is not set.'); process.exit(1); }

let s = 20260918;
const rng = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truncate = (t, n) => (t.length > n ? `${t.slice(0, n)}...` : t);
const f = (x) => (Number.isFinite(x) ? x.toFixed(4) : ' n/a  ');

const hippoRoot = join(homedir(), '.hippo');
const dir = 'evals/paraphrase';
const queries = [];
for (const fn of readdirSync(dir).filter((x) => /^queries\d+\.json$/.test(x)).sort()) {
  queries.push(...JSON.parse(readFileSync(join(dir, fn), 'utf8')));
}

const entries = loadAllEntries(hippoRoot);
const byId = new Map(entries.map((e) => [e.id, e]));
const cases = queries.filter((q) => byId.has(q.id) && q.query?.trim());
console.error(`merged ${queries.length} paraphrase queries, ${cases.length} usable cases, corpus ${entries.length} entries\n`);

const corpus = buildCorpus(entries.map((e) => `${e.content} ${e.tags.join(' ')}`));

async function baseRanking(query, targetId) {
  const t0 = Date.now();
  const res = await hybridSearch(query, entries, {
    budget: 1000000, hippoRoot, preparedCorpus: corpus, minResults: 50, mmr: true,
  });
  const searchMs = Date.now() - t0;
  const i = res.findIndex((r) => r.entry.id === targetId);
  const baseRank = i < 0 ? Infinity : i + 1;
  const candidates = res.slice(0, Math.min(CANDIDATE_DEPTH, res.length));
  return { fullBase: res, baseRank, candidates, searchMs };
}

const rows = [];
for (const c of cases) {
  const b = await baseRanking(c.query, c.id);
  rows.push({ id: c.id, query: c.query, ...b });
}
console.error(`base ranking computed for ${rows.length} cases (local, no API calls)\n`);

function buildState(query, candidates) {
  const lines = candidates.map((c, i) => `[${i + 1}] ${truncate(c.entry.content, TRUNCATE_CHARS)}`);
  return `Query: ${query}\n\nNumbered candidate memories from an AI coding agent's project store:\n\n${lines.join('\n\n')}`;
}

async function callJev(state, questions, counter) {
  for (let attempt = 0; attempt < 3; attempt++) {
    counter.n++;
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ state, model: MODEL, questions }),
      });
      if (res.status === 429 || res.status === 529) { await sleep(800); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }
  return null;
}

function choiceQuestions9a(n) {
  const criteria = {};
  for (let i = 1; i <= n; i++) criteria[String(i)] = `Candidate ${i} from the numbered list in the state above.`;
  return {
    pick: {
      type: 'choice',
      instructions: 'Given the query and numbered candidates in the state above, choose the single candidate number that best answers the query.',
      criteria,
    },
  };
}

async function askChoice(state, n, counter) {
  const d = await callJev(state, choiceQuestions9a(n), counter);
  const k = Number(d?.answers?.pick?.choice);
  if (!Number.isInteger(k) || k < 1 || k > n) return null;
  const conf = d.answers.pick.confidence;
  return { choice: k, confidence: Number.isFinite(conf) ? conf : null };
}

function noulQuestions9b(n) {
  const questions = {};
  for (let i = 1; i <= n; i++) {
    questions[`c${i}`] = {
      type: 'noul',
      instructions: `Probability that candidate ${i} (numbered in the state above) helps answer the query.`,
    };
  }
  return questions;
}

async function askNoulBatch(state, n, counter) {
  const d = await callJev(state, noulQuestions9b(n), counter);
  const scores = [];
  for (let i = 1; i <= n; i++) {
    const v = d?.answers?.[`c${i}`]?.noul;
    if (!Number.isFinite(v) || v < 0 || v > 1) return null;
    scores.push(v);
  }
  return scores;
}

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

async function runGate(gateCases) {
  console.log(`\n=== AMENDMENT 2 GATE: ${gateCases.length} queries through the Lane 9b batched shape ===\n`);
  const counter = { n: 0 };
  const out = [];
  for (const row of gateCases) {
    const n = row.candidates.length;
    const state = buildState(row.query, row.candidates);
    const t0 = Date.now();
    const d = await callJev(state, noulQuestions9b(n), counter);
    const ms = Date.now() - t0;
    const raw = [];
    for (let i = 1; i <= n; i++) raw.push(d?.answers?.[`c${i}`]?.noul ?? null);
    const nums = raw.filter((v) => Number.isFinite(v));
    const distinct = new Set(nums).size;
    const allEqual = nums.length > 0 && nums.every((v) => v === nums[0]);
    const allHalf = nums.length > 0 && nums.every((v) => v === 0.5);
    const pass = d !== null && nums.length === n && distinct > 5 && !allEqual && !allHalf;
    out.push({ id: row.id, query: row.query, n, present: nums.length, distinct, allEqual, allHalf, ms, raw, pass });
    console.log(`  ${row.id}  n=${n} present=${nums.length} distinct=${distinct} allEqual=${allEqual} allHalf=${allHalf}  ${ms}ms  ${pass ? 'OK' : 'FAIL'}`);
    console.log(`    raw: [${raw.map((v) => (v == null ? 'MISSING' : v.toFixed(3))).join(', ')}]`);
  }
  // Per-response check: each call must itself be non-degenerate, not just the pool of all 5.
  const pass = out.length > 0 && out.every((g) => g.pass);
  console.log(`\nAMENDMENT 2 GATE: ${pass ? 'PASS' : 'FAIL'} (${out.filter((g) => g.pass).length}/${out.length} queries clean)\n`);
  return { pass, results: out, httpCalls: counter.n };
}

mkdirSync('results', { recursive: true });
const gate = await runGate(rows.slice(0, GATE_N));

if (!gate.pass) {
  writeFileSync(OUTPUT_PATH, JSON.stringify({
    protocol: 'docs/EXPERIMENT-PROTOCOL.md WAVE 2, AMENDMENT 2 gate',
    status: 'AMENDMENT 2 GATE FAILED, full lane not run',
    generated_at: new Date().toISOString(),
    gate,
  }, null, 2));
  console.log(`Wrote ${OUTPUT_PATH}. STOPPING per Amendment 2: full lane not run, no silent fallback.`);
  process.exit(1);
}

console.log(`=== LANE 9a: choice rerank, ${rows.length} queries ===\n`);
const counter9a = { n: 0 };
const t9aStart = Date.now();
const results9a = await runPool(rows, async (row) => {
  const state = buildState(row.query, row.candidates);
  const t0 = Date.now();
  const r = await askChoice(state, row.candidates.length, counter9a);
  return { ...r, ms: Date.now() - t0 };
}, CONCURRENCY);
const t9aWallMs = Date.now() - t9aStart;

// Hoisting the picked candidate to rank 1 only shifts items that were originally
// ranked ABOVE it (they move down by one); everything at or below it is untouched.
function hoistRank(baseRank, pickedRank, isPicked) {
  if (isPicked) return 1;
  if (baseRank < pickedRank) return baseRank + 1;
  return baseRank;
}

let failed9a = 0;
for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const r = results9a[i] ?? {};
  row.pick9a = r.choice ?? null;
  row.confidence9a = r.confidence ?? null;
  row.ms9a = r.ms;
  if (row.pick9a == null) { row.failed9a = true; row.rank9a = null; failed9a++; continue; }
  const pickedId = row.candidates[row.pick9a - 1].entry.id;
  row.pickIsTarget9a = pickedId === row.id;
  row.rank9a = hoistRank(row.baseRank, row.pick9a, row.pickIsTarget9a);
}
console.log(`Lane 9a: ${rows.length - failed9a}/${rows.length} calls scored, ${failed9a} failed (excluded from stats)\n`);

console.log(`=== LANE 9b: batched noul rerank, ${rows.length} queries ===\n`);
const gateScoresById = new Map(gate.results.map((g) => [g.id, g.raw]));
const gateMsById = new Map(gate.results.map((g) => [g.id, g.ms]));
const counter9b = { n: 0 };
const t9bStart = Date.now();
const results9b = await runPool(rows, async (row) => {
  if (gateScoresById.has(row.id)) {
    return { scores: gateScoresById.get(row.id), ms: gateMsById.get(row.id), reused: true };
  }
  const state = buildState(row.query, row.candidates);
  const t0 = Date.now();
  const scores = await askNoulBatch(state, row.candidates.length, counter9b);
  return { scores, ms: Date.now() - t0, reused: false };
}, CONCURRENCY);
const t9bWallMs = Date.now() - t9bStart;

function applyBudget(items, budget, minResults) {
  let used = 0;
  const kept = [];
  for (const it of items) {
    if (kept.length >= minResults && used + it.tokens > budget) continue;
    used += it.tokens;
    kept.push(it);
  }
  return kept;
}

let failed9b = 0;
for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const r = results9b[i] ?? {};
  row.scores9b = r.scores ?? null;
  row.ms9b = r.ms;
  row.reused9b = !!r.reused;
  if (!row.scores9b) { row.failed9b = true; row.rank9b = null; row.inBudgetBase = null; row.inBudget9b = null; failed9b++; continue; }

  const n = row.candidates.length;
  const order = row.candidates.map((_, idx) => idx).sort((a, b) => row.scores9b[b] - row.scores9b[a]);
  const reordered = order.map((idx) => row.candidates[idx]);
  const armList = reordered.concat(row.fullBase.slice(n));

  const idx = armList.findIndex((r2) => r2.entry.id === row.id);
  row.rank9b = idx < 0 ? row.baseRank : idx + 1;

  const keptBase = applyBudget(row.fullBase, REAL_BUDGET_TOKENS, REAL_MIN_RESULTS);
  const keptJev = applyBudget(armList, REAL_BUDGET_TOKENS, REAL_MIN_RESULTS);
  row.inBudgetBase = keptBase.some((r2) => r2.entry.id === row.id);
  row.inBudget9b = keptJev.some((r2) => r2.entry.id === row.id);
}
console.log(`Lane 9b: ${rows.length - failed9b}/${rows.length} calls scored, ${failed9b} failed (excluded from stats)\n`);

const at = (arr, k) => arr.filter((x) => x <= k).length / arr.length;
const mrr = (arr) => arr.reduce((a, x) => a + (Number.isFinite(x) ? 1 / x : 0), 0) / arr.length;
const mean01 = (arr) => arr.reduce((a, x) => a + (x ? 1 : 0), 0) / arr.length;

function buildResampleMatrix(n, draws) {
  const m = Array.from({ length: draws });
  for (let d = 0; d < draws; d++) {
    const row = Array.from({ length: n });
    for (let i = 0; i < n; i++) row[i] = Math.floor(rng() * n);
    m[d] = row;
  }
  return m;
}

function ciFromDeltas(sortedDeltas, alpha) {
  const lo = sortedDeltas[Math.floor(sortedDeltas.length * (alpha / 2))];
  const hi = sortedDeltas[Math.floor(sortedDeltas.length * (1 - alpha / 2))];
  return { lo, hi };
}

// One resample index matrix per report, reused by every metric below it (protocol
// requirement): correlated metrics must be bootstrapped off the same resamples.
function report(label, validRows, metrics, primaryName, secondaryNames) {
  const n = validRows.length;
  const matrix = buildResampleMatrix(n, BOOTSTRAP_DRAWS);
  console.log(`\n${label}  n=${n}\n`);
  console.log('metric          baseline   Jev arm    delta      98.33% CI (verdict)     95% CI (diagnostic)');
  const table = {};
  for (const [name, { base, jev }] of Object.entries(metrics)) {
    const b = base(validRows);
    const j = jev(validRows);
    const deltas = matrix.map((idxRow) => {
      const resampled = idxRow.map((i) => validRows[i]);
      return jev(resampled) - base(resampled);
    }).sort((a, b2) => a - b2);
    const ci83 = ciFromDeltas(deltas, ALPHA_PRIMARY);
    const ci95 = ciFromDeltas(deltas, ALPHA_DIAG);
    table[name] = { base: b, jev: j, delta: j - b, ci_9833: ci83, ci_95: ci95 };
    const sign = j - b >= 0 ? '+' : '';
    console.log(`${name.padEnd(14)}  ${f(b)}   ${f(j)}   ${sign}${f(j - b)}   [${f(ci83.lo)}, ${f(ci83.hi)}]   [${f(ci95.lo)}, ${f(ci95.hi)}]`);
  }
  const primaryUp = table[primaryName].ci_9833.lo > 0;
  const secondaryLoses = secondaryNames.some((nm) => table[nm].ci_9833.hi < 0);
  const verdict = primaryUp && !secondaryLoses ? 'SHIP' : 'DO NOT SHIP';
  console.log(`\nVERDICT: ${verdict}  (primary ${primaryName} CI excludes 0 upward at 98.33%: ${primaryUp}; a secondary loses: ${secondaryLoses})`);
  return { n, table, verdict };
}

function safeReport(label, validRows, metrics, primaryName, secondaryNames) {
  if (validRows.length < MIN_VALID_FOR_VERDICT) {
    console.log(`\n${label}: only ${validRows.length} valid rows (<${MIN_VALID_FOR_VERDICT}). NO VERDICT.`);
    return { n: validRows.length, table: {}, verdict: 'NO VERDICT (insufficient data)' };
  }
  return report(label, validRows, metrics, primaryName, secondaryNames);
}

const ceilingRecallAt40 = at(rows.map((r) => r.baseRank), CANDIDATE_DEPTH);
console.log(`\nCEILING: base arm recall@${CANDIDATE_DEPTH} = ${f(ceilingRecallAt40)} (Jev cannot recover a target hippo never surfaced in the top ${CANDIDATE_DEPTH})`);

const validRows9a = rows.filter((r) => !r.failed9a);
const report9a = safeReport('LANE 9a -- choice rerank (base vs Jev pick hoisted to rank 1)', validRows9a, {
  'R@1': { base: (rs) => at(rs.map((r) => r.baseRank), 1), jev: (rs) => at(rs.map((r) => r.rank9a), 1) },
  MRR: { base: (rs) => mrr(rs.map((r) => r.baseRank)), jev: (rs) => mrr(rs.map((r) => r.rank9a)) },
}, 'R@1', ['MRR']);

const validRows9b = rows.filter((r) => !r.failed9b);
const report9b = safeReport('LANE 9b -- batched noul rerank at the real token budget', validRows9b, {
  'recall@budget': { base: (rs) => mean01(rs.map((r) => r.inBudgetBase)), jev: (rs) => mean01(rs.map((r) => r.inBudget9b)) },
  'R@1': { base: (rs) => at(rs.map((r) => r.baseRank), 1), jev: (rs) => at(rs.map((r) => r.rank9b), 1) },
  'R@5': { base: (rs) => at(rs.map((r) => r.baseRank), 5), jev: (rs) => at(rs.map((r) => r.rank9b), 5) },
}, 'recall@budget', ['R@1', 'R@5']);

const totalSearchMs = rows.reduce((a, r) => a + r.searchMs, 0);
const calls9b = gate.httpCalls + counter9b.n;
const lane11 = {
  baseline_search: { calls: rows.length, total_ms: totalSearchMs, mean_ms: totalSearchMs / rows.length, usd: 0 },
  lane_9a: { calls: counter9a.n, total_wall_ms: t9aWallMs, mean_ms_per_call: t9aWallMs === 0 ? 0 : results9a.reduce((a, r) => a + (r?.ms ?? 0), 0) / results9a.length, usd: counter9a.n * COST_PER_CALL_USD },
  lane_9b: { calls: calls9b, total_wall_ms: t9bWallMs, mean_ms_per_call: results9b.reduce((a, r) => a + (r?.ms ?? 0), 0) / results9b.length, usd: calls9b * COST_PER_CALL_USD },
};

console.log('\n=== LANE 11: cost and latency (diagnostic, does not gate the verdicts) ===\n');
console.log('arm               calls   total wall ms   mean ms/call   USD');
console.log(`baseline search   ${String(lane11.baseline_search.calls).padStart(5)}   ${String(lane11.baseline_search.total_ms).padStart(13)}   ${lane11.baseline_search.mean_ms.toFixed(1).padStart(12)}   $0.0000`);
console.log(`lane 9a           ${String(lane11.lane_9a.calls).padStart(5)}   ${String(lane11.lane_9a.total_wall_ms).padStart(13)}   ${lane11.lane_9a.mean_ms_per_call.toFixed(1).padStart(12)}   $${lane11.lane_9a.usd.toFixed(4)}`);
console.log(`lane 9b           ${String(lane11.lane_9b.calls).padStart(5)}   ${String(lane11.lane_9b.total_wall_ms).padStart(13)}   ${lane11.lane_9b.mean_ms_per_call.toFixed(1).padStart(12)}   $${lane11.lane_9b.usd.toFixed(4)}`);
console.log('\n(calls counts every HTTP request including 429/529 retries; lane 9b includes the 5 gate calls)');

const designNotes = [
  'Protocol doc lines 1554-1565 (original Lane 9a pre-registration) specify top-20 candidates and a recall@20 ceiling. This run follows the task instructions instead, which raise 9a to depth 40 (Amendment 2 only raised 9b) so both lanes share one candidate set and base rank; ceiling reported is recall@40.',
  'Amendment 2 gate scope: a FAIL stops both 9a and 9b, not just 9b, since the two lanes are meant to be paired over the same base ranks and a broken batching path calls the whole run into question.',
  'Amendment 2 non-degenerate check is applied per individual gate response (each of the 5 calls must itself clear >5 distinct values), not pooled across the 5.',
  'Lane 9b R@1/R@5 are computed on rank within the noul-reordered list before the token-budget cut, independent of recall@budget, mirroring how R@1/R@5/MRR are all rank-derived in jev-retrieval-ab-paraphrase.mjs.',
  'The token-budget cut replicates search.ts:777-788 exactly (skip an over-budget item but keep scanning for a smaller one below it), not a simple accumulate-and-stop prefix cut.',
  'Verified 0 of 1933 entries carry superseded_by, so reusing one preparedCorpus (built from the full unfiltered entry list) across hybridSearch calls cannot misalign BM25 doc indices here.',
];

writeFileSync(OUTPUT_PATH, JSON.stringify({
  protocol: 'docs/EXPERIMENT-PROTOCOL.md WAVE 2, Lanes 9a/9b/11',
  generated_at: new Date().toISOString(),
  design_notes: designNotes,
  population: { queries_merged: queries.length, usable_cases: cases.length, candidate_depth: CANDIDATE_DEPTH, corpus_entries: entries.length },
  amendment2_gate: gate,
  ceiling: { recall_at_40: ceilingRecallAt40, definition: 'fraction of queries where the base arm ranks the target at or above 40' },
  lane_9a: report9a,
  lane_9b: report9b,
  lane_11_cost_latency: lane11,
  rows: rows.map((r) => ({
    // JSON.stringify turns Infinity into null on its own, so "never surfaced" and
    // "call failed" both serialize as null with no extra mapping needed here.
    id: r.id, query: r.query, baseRank: r.baseRank,
    candidateCount: r.candidates.length, searchMs: r.searchMs,
    pick9a: r.pick9a, confidence9a: r.confidence9a, pickIsTarget9a: r.pickIsTarget9a ?? null,
    rank9a: r.rank9a, ms9a: r.ms9a, failed9a: !!r.failed9a,
    scores9b: r.scores9b, rank9b: r.rank9b,
    inBudgetBase: r.inBudgetBase, inBudget9b: r.inBudget9b, ms9b: r.ms9b, reused9b: !!r.reused9b, failed9b: !!r.failed9b,
  })),
}, null, 2));
console.log(`\nWrote ${OUTPUT_PATH}`);
