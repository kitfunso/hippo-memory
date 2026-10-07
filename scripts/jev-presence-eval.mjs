#!/usr/bin/env node
/** Lane 21 of docs/EXPERIMENT-PROTOCOL.md: one extra `present` noul, in the same
 *  batched request, vs. the free base/cross-encoder abstention signal. Setup is
 *  copied from Lane 15 (rerank-3arm-ab.mjs) so the pool and label match. */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hybridSearch } from '../dist/search/hybrid.js';
import { buildCorpus } from '../dist/search/bm25.js';
import { loadAllEntries } from '../dist/store/entry-reads.js';
import { getReranker } from '../dist/rerankers/index.js';

const NOW = new Date('2026-09-18T14:31:52.073Z'); // same clock as Lane 15, see rerank-3arm-ab.mjs:15
const CANDIDATE_TOPK = 40;
const TRUNCATE_CHARS = 1200; // matches src/rerankers/jev.ts TRUNCATE_CHARS
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-1.13.0'; // pinned: a threshold gets tuned on this run, per protocol
const TIMEOUT_MS = 30_000;
const RETRY_STATUS = new Set([429, 529]);
const CONCURRENCY = 4;
const CALL_CAP = 320;
const USD_PER_MTOK = 0.042;
const CACHE_DIR = join('results', 'lane21-cache');
const OUT_PATH = join('results', 'lane21-presence-2026-09-19.json');
const HANDLOOK_PATH = join('results', 'lane21-handlook.json');
const LANE15_PATH = join('results', 'rerank-3arm-2026-09-18.json');
const DEV_FILES = new Set(['queries1.json', 'queries2.json']);
const JUDGE_FILES = new Set(['queries3.json', 'queries4.json']);

// Frozen wording, copied verbatim from docs/EXPERIMENT-PROTOCOL.md LANE 21 section.
const PRESENT_QUESTION = {
  type: 'noul',
  instructions: {
    question: 'Does at least one numbered candidate memory contain the specific information needed to answer the query?',
    context: 'The candidates were fetched by a keyword and embedding search, so they often share words or a topic with the query without answering it.',
    focus: 'Judge whether the answer itself is present in a candidate, not whether a candidate is on the same topic or uses the same terms.',
  },
  criteria: {
    true: {
      what: 'At least one candidate states the fact, rule, fix or decision the query asks for.',
      not_for: 'Candidates that only mention the same tool, file, project or error name without giving what the query asks for.',
      examples: ['Query asks how to stop a flaky deploy script from hanging; one candidate says the deploy script hangs when stdin is open and the fix is to close stdin.'],
    },
    false: {
      what: 'No candidate gives what the query asks for, even if several are on a related topic.',
      not_for: 'Cases where one candidate answers the query in different words from the query.',
      examples: ['Query asks which port the staging database listens on; candidates discuss database migrations and backup schedules but none states a port.'],
    },
  },
};

const pilotIdx = process.argv.indexOf('--pilot');
const PILOT_N = pilotIdx >= 0 ? Number.parseInt(process.argv[pilotIdx + 1], 10) : null;
if (pilotIdx >= 0 && !Number.isFinite(PILOT_N)) { console.error('--pilot needs a number'); process.exit(1); }

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
if (!apiKey) { console.error('TYPESAFE_API_KEY is not set.'); process.exit(1); }

// The free lint() lives in a CJS hook lib; dynamic import gets its CJS default export in an .mjs file.
const { lint } = (await import(pathToFileURL(join(homedir(), '.claude/scripts/hooks/lib/jev.js')).href)).default;

// A third-party error body can echo the request; strip anything token-shaped before it hits a log or file.
function redact(s) {
  return String(s).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]');
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const quantile = (sortedAsc, p) => sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(sortedAsc.length * p)))];

// Mid-rank Mann-Whitney: mathematically equivalent to counting a tie as half a win.
function auc(scores, labels) {
  const n = scores.length;
  const order = [...scores.keys()].sort((a, b) => scores[a] - scores[b]);
  const ranks = Array.from({ length: n });
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && scores[order[j + 1]] === scores[order[i]]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]] = avgRank;
    i = j + 1;
  }
  let nPos = 0, nNeg = 0, rankSumPos = 0;
  for (let k = 0; k < n; k++) { if (labels[k]) { nPos++; rankSumPos += ranks[k]; } else nNeg++; }
  if (!nPos || !nNeg) return null;
  return (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

function rankByScore(pool, scores, targetId) {
  const order = pool.map((p, i) => ({ id: p.entry.id, score: scores[i] })).sort((a, b) => b.score - a.score);
  const idx = order.findIndex((o) => o.id === targetId);
  return idx < 0 ? Infinity : idx + 1;
}

async function runPool(items, worker, concurrency) {
  const out = Array.from({ length: items.length });
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) { const i = cursor++; out[i] = await worker(items[i]); }
  }));
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Load queries (Lane 15 setup), tagged with source file for the dev/judge split ----------
const hippoRoot = join(homedir(), '.hippo');
const dir = 'evals/paraphrase';
const queries = [];
for (const fn of readdirSync(dir).filter((x) => /^queries\d+\.json$/.test(x)).sort()) {
  const part = JSON.parse(readFileSync(join(dir, fn), 'utf8'));
  for (const q of part) queries.push({ ...q, file: fn });
  console.error(`  ${fn}: ${part.length} queries`);
}
console.error(`merged ${queries.length} paraphrase queries\n`);

const entries = loadAllEntries(hippoRoot);
const byId = new Map(entries.map((e) => [e.id, e]));
let cases = queries.filter((q) => byId.has(q.id) && q.query?.trim());
console.error(`corpus ${entries.length} entries; usable cases: ${cases.length}\n`);
if (PILOT_N) cases = cases.slice(0, PILOT_N);

const corpus = buildCorpus(entries.map((e) => `${e.content} ${e.tags.join(' ')}`));
const SEARCH_OPTS = { budget: 1000000, hippoRoot, preparedCorpus: corpus, minResults: 50, mmr: true, now: NOW };

const ceReranker = getReranker('cross-encoder');
const warmup = [{ entry: { id: '__warmup__', content: 'warm up the cross encoder' }, score: 1, tokens: 10 }];
let fallbackWarning = null;
const realWarn = console.warn;
console.warn = (...a) => { fallbackWarning = a.join(' '); realWarn(...a); };
await ceReranker('warm up query', warmup, { topK: 1 });
console.warn = realWarn;
if (fallbackWarning) {
  // A silent identity-order fallback would make F2 just the base score in disguise.
  console.error('CROSS-ENCODER UNAVAILABLE, aborting:', fallbackWarning);
  process.exit(1);
}

// ---------- Phase 1: hybridSearch + cross-encoder, one pass per query ----------
const rows = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const candidates = await hybridSearch(c.query, entries, SEARCH_OPTS);
  const pool = candidates.slice(0, CANDIDATE_TOPK);
  const answerable = pool.some((r) => r.entry.id === c.id);
  const F1 = pool[0]?.score ?? null;
  const ceHead = await ceReranker(c.query, candidates, { topK: CANDIDATE_TOPK });
  const F2 = ceHead.length ? Math.max(...ceHead.map((r) => r.rerankScore)) : null;
  rows.push({ id: c.id, query: c.query, file: c.file, pool, answerable, F1, F2 });
  if ((i + 1) % 50 === 0) console.error(`  phase 1: ${i + 1}/${cases.length}`);
}
console.error('phase 1 done\n');

// ---------- Phase 2: one Jev call per query, cached, capped ----------
mkdirSync(CACHE_DIR, { recursive: true });
const jevHttp = { calls: 0, ok: 0, failed: 0, code422: 0, retried: 0 };
let lintedOnce = false;
let inputTokensTotal = 0;

function buildRequestBody(query, pool) {
  const lines = pool.map((r, i) => `[${i + 1}] ${r.entry.content.length <= TRUNCATE_CHARS ? r.entry.content : `${r.entry.content.slice(0, TRUNCATE_CHARS)}...`}`);
  const state = `Query: ${query}\n\nNumbered candidate memories from an AI coding agent's project store:\n\n${lines.join('\n\n')}`;
  const questions = {};
  for (let i = 1; i <= pool.length; i++) {
    questions[`c${i}`] = { type: 'noul', instructions: `Probability that candidate ${i} (numbered in the state above) helps answer the query.` };
  }
  questions.present = PRESENT_QUESTION;
  return { state, questions };
}

async function callJevOnce(body) {
  if (jevHttp.calls >= CALL_CAP) throw new Error(`call cap (${CALL_CAP}) reached`);
  jevHttp.calls++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ state: body.state, model: MODEL, questions: body.questions }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
    if (res.status === 422) jevHttp.code422++;
    return { ok: res.ok, status: res.status, json, rawText: res.ok ? null : redact(text).slice(0, 2000) };
  } catch (err) {
    return { ok: false, status: null, json: null, error: redact(err?.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : (err?.message ?? String(err))), networkError: true };
  } finally {
    clearTimeout(timer);
  }
}

async function callJevWithRetry(body) {
  let result = await callJevOnce(body);
  if (result.networkError || RETRY_STATUS.has(result.status)) {
    jevHttp.retried++;
    await sleep(500);
    result = await callJevOnce(body);
  }
  return result;
}

const cachePath = (id) => join(CACHE_DIR, `${id}.json`);

async function getJevRaw(row) {
  const cp = cachePath(row.id);
  if (existsSync(cp)) {
    try { return { ...JSON.parse(readFileSync(cp, 'utf8')), fromCache: true }; } catch { /* corrupt cache, refetch below */ }
  }
  const body = buildRequestBody(row.query, row.pool);
  if (!lintedOnce) {
    lintedOnce = true;
    const problems = lint(body.state, body.questions).filter((p) => !p.startsWith('warn:'));
    if (problems.length) { console.error('LINT FAILED:', problems); process.exit(1); }
  }
  const result = await callJevWithRetry(body);
  if (result.ok) jevHttp.ok++; else jevHttp.failed++;
  const record = { id: row.id, query: row.query, request: body, response: result };
  // Only a success is cached: a failed shape must stay retryable on the next pilot round.
  if (result.ok) writeFileSync(cp, JSON.stringify(record, null, 2));
  return { ...record, fromCache: false };
}

const expectedNewCalls = rows.filter((r) => !existsSync(cachePath(r.id))).length;
console.error(`Jev: ${rows.length} rows, ${expectedNewCalls} need a new call (cap ${CALL_CAP})\n`);
if (expectedNewCalls > CALL_CAP) { console.error('STOPPING before any calls: expected new calls exceed the cap.'); process.exit(1); }

const jevOut = await runPool(rows, getJevRaw, CONCURRENCY);

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const raw = jevOut[i];
  row.jevOk = raw.response.ok;
  row.jevError = raw.response.ok ? null : (raw.response.error ?? raw.response.rawText ?? `status ${raw.response.status}`);
  const usage = raw.response.json?.usage;
  if (Number.isFinite(usage?.input_tokens)) inputTokensTotal += usage.input_tokens;
  else if (Number.isFinite(usage?.prompt_tokens)) inputTokensTotal += usage.prompt_tokens;

  const answers = raw.response.ok ? raw.response.json?.answers : null;
  if (answers) {
    const cScores = Array.from({ length: row.pool.length }, (_, k) => {
      const v = answers[`c${k + 1}`]?.noul;
      return Number.isFinite(v) ? v : null;
    });
    row.cScores = cScores;
    row.J1 = cScores.every((v) => Number.isFinite(v)) ? Math.max(...cScores) : null;
    row.J2 = Number.isFinite(answers.present?.noul) ? answers.present.noul : null;
    row.jevRank = row.J1 !== null ? rankByScore(row.pool, cScores, row.id) : Infinity;
  } else {
    row.cScores = null; row.J1 = null; row.J2 = null; row.jevRank = Infinity;
  }
}
console.error('phase 2 done\n');

if (PILOT_N) {
  console.log('\n=== PILOT GATE ===');
  let allOk = true;
  for (const r of rows) {
    const cComplete = Array.isArray(r.cScores) && r.cScores.length === r.pool.length && r.cScores.every((v) => Number.isFinite(v));
    const presentOk = Number.isFinite(r.J2) && r.J2 >= 0 && r.J2 <= 1;
    console.log(`${r.id}: ok=${r.jevOk} cComplete=${cComplete} (${r.cScores?.length ?? 0}/${r.pool.length}) present=${r.J2} presentOk=${presentOk}${r.jevError ? ` error=${r.jevError}` : ''}`);
    if (!r.jevOk || !cComplete || !presentOk) allOk = false;
  }
  console.log(`HTTP: ${jevHttp.ok} ok / ${jevHttp.failed} failed / ${jevHttp.code422} code422 / ${jevHttp.calls} calls`);
  console.log(allOk ? 'PILOT GATE: PASS' : 'PILOT GATE: FAIL');
  process.exit(allOk ? 0 : 2);
}

// ---------- Analysis (full run only) ----------
const usable = rows.filter((r) => r.F1 != null && r.F2 != null && r.J1 != null && r.J2 != null);
const excludedIncomplete = rows.length - usable.length;
const labels = usable.map((r) => r.answerable);
const arms = { F1: usable.map((r) => r.F1), F2: usable.map((r) => r.F2), J1: usable.map((r) => r.J1), J2: usable.map((r) => r.J2) };
const aucTable = Object.fromEntries(Object.entries(arms).map(([k, s]) => [k, auc(s, labels)]));
const bestFreeArm = (aucTable.F1 ?? -1) >= (aucTable.F2 ?? -1) ? 'F1' : 'F2';

const bootRng = mulberry32(21); // pinned per protocol
const nU = usable.length;
const draws = Array.from({ length: 2000 }, () => Array.from({ length: nU }, () => Math.floor(bootRng() * nU)));
function bootstrapDeltas(paidKey) {
  const out = [];
  for (const draw of draws) {
    const lab = draw.map((i) => labels[i]);
    const a = auc(draw.map((i) => arms[paidKey][i]), lab);
    const b = auc(draw.map((i) => arms[bestFreeArm][i]), lab);
    if (a !== null && b !== null) out.push(a - b);
  }
  return out.sort((x, y) => x - y);
}
const deltasJ2 = bootstrapDeltas('J2');
const deltasJ1 = bootstrapDeltas('J1');
const contrasts = {
  '21a_J2_minus_bestFree': { paid: 'J2', free: bestFreeArm, delta: aucTable.J2 - aucTable[bestFreeArm], ci_97_5: { lo: quantile(deltasJ2, 0.0125), hi: quantile(deltasJ2, 0.9875) } },
  '21b_J1_minus_bestFree': { paid: 'J1', free: bestFreeArm, delta: aucTable.J1 - aucTable[bestFreeArm], ci_97_5: { lo: quantile(deltasJ1, 0.0125), hi: quantile(deltasJ1, 0.9875) } },
};

const nullRng = mulberry32(2021); // separate stream from the bootstrap's seed 21
const nullStats = [];
for (let t = 0; t < 1000; t++) {
  const shuffled = labels.slice();
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(nullRng() * (i + 1));[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  const a1 = auc(arms.J1, shuffled), a2 = auc(arms.J2, shuffled), f1 = auc(arms.F1, shuffled), f2 = auc(arms.F2, shuffled);
  if (a1 !== null && a2 !== null && f1 !== null && f2 !== null) nullStats.push(Math.max(a1, a2) - Math.max(f1, f2));
}
nullStats.sort((a, b) => a - b);
const nullP95 = quantile(nullStats, 0.95);

// ---------- Operating point: dev picks the cut, judge reports it ----------
function pickThreshold(devScores, devLabels, wrongCap = 0.02) {
  const answerableScores = devScores.filter((_, i) => devLabels[i]).slice().sort((a, b) => a - b);
  if (!answerableScores.length) return null;
  const k = Math.min(answerableScores.length - 1, Math.floor(wrongCap * answerableScores.length));
  return answerableScores[k];
}
function applyThreshold(judgeScores, judgeLabels, t) {
  const notAnswerable = [], answerable = [];
  judgeScores.forEach((s, i) => (judgeLabels[i] ? answerable : notAnswerable).push(s));
  const caughtN = notAnswerable.filter((s) => s < t).length;
  const wrongN = answerable.filter((s) => s < t).length;
  return {
    t,
    caught: { n: caughtN, N: notAnswerable.length, share: notAnswerable.length ? caughtN / notAnswerable.length : null },
    wrong: { n: wrongN, N: answerable.length, share: answerable.length ? wrongN / answerable.length : null },
  };
}
const devRows = usable.filter((r) => DEV_FILES.has(r.file));
const judgeRows = usable.filter((r) => JUDGE_FILES.has(r.file));
const devLabels = devRows.map((r) => r.answerable);
const judgeLabels = judgeRows.map((r) => r.answerable);
const devNotAnswerable = devLabels.filter((x) => !x).length;
const judgeNotAnswerable = judgeLabels.filter((x) => !x).length;

const operatingPoint = {};
for (const armKey of ['F1', 'F2', 'J1', 'J2']) {
  const devScores = devRows.map((r) => r[armKey]);
  const judgeScores = judgeRows.map((r) => r[armKey]);
  const t = pickThreshold(devScores, devLabels);
  const res = applyThreshold(judgeScores, judgeLabels, t);
  if (armKey === 'J1' || armKey === 'J2') res.within_0_06_of_t = judgeScores.filter((s) => Math.abs(s - t) <= 0.06).length;
  operatingPoint[armKey] = res;
}
const underpowered = devNotAnswerable < 25 || judgeNotAnswerable < 25;

// ---------- Integrity ----------
function armStats(vals) {
  const finite = vals.filter((v) => Number.isFinite(v));
  return { count: finite.length, distinct: new Set(finite).size, min: finite.length ? Math.min(...finite) : null, max: finite.length ? Math.max(...finite) : null };
}
let lane15 = null;
const notes = [];
try {
  const d = JSON.parse(readFileSync(LANE15_PATH, 'utf8'));
  lane15 = { jev_r1: d.contrasts['jev-vs-base'].table['R@1'].b, base_r1: d.contrasts['jev-vs-base'].table['R@1'].a };
} catch (err) {
  notes.push(`could not read Lane 15 reference file: ${err.message}`);
}
const jevR1ThisRun = rows.length ? rows.filter((r) => r.jevRank === 1).length / rows.length : null;
if (excludedIncomplete > 0) notes.push(`${excludedIncomplete} row(s) excluded from AUC/bootstrap/operating-point analysis for a missing F1/F2/J1/J2 value`);
if (inputTokensTotal === 0) notes.push('usage.input_tokens/prompt_tokens was absent on every response; cost_usd is not computable from usage and is reported as 0');

mkdirSync('results', { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify({
  protocol: 'docs/EXPERIMENT-PROTOCOL.md, LANE 21 (presence)',
  now: NOW.toISOString(),
  usable_cases: rows.length,
  usable_for_analysis: usable.length,
  excluded_incomplete: excludedIncomplete,
  label_split: { answerable: usable.filter((r) => r.answerable).length, not_answerable: usable.filter((r) => !r.answerable).length },
  dev_judge_split: { dev_not_answerable: devNotAnswerable, judge_not_answerable: judgeNotAnswerable, underpowered },
  auc: aucTable,
  best_free_arm: bestFreeArm,
  contrasts,
  null_permutation: { draws: 1000, seed: 2021, p95: nullP95 },
  operating_point: operatingPoint,
  integrity: {
    jev_r1_this_run: jevR1ThisRun,
    lane15_reference: lane15,
    distinct_J2: new Set(usable.map((r) => r.J2)).size,
    arm_stats: { F1: armStats(arms.F1), F2: armStats(arms.F2), J1: armStats(arms.J1), J2: armStats(arms.J2) },
    http: jevHttp,
    input_tokens_total: inputTokensTotal,
    cost_usd: (inputTokensTotal / 1e6) * USD_PER_MTOK,
  },
  notes,
  rows: rows.map((r) => ({ id: r.id, query: r.query, file: r.file, answerable: r.answerable, F1: r.F1, F2: r.F2, J1: r.J1, J2: r.J2 })),
}, null, 2));

const notAnswerableUsable = usable.filter((r) => !r.answerable);
const handlook = notAnswerableUsable.slice().sort((a, b) => b.J2 - a.J2).slice(0, 15).map((r) => ({
  id: r.id,
  query: r.query,
  J2: r.J2,
  top3: r.pool
    .map((p, i) => ({ id: p.entry.id, cScore: r.cScores[i], content: p.entry.content }))
    .sort((a, b) => b.cScore - a.cScore)
    .slice(0, 3)
    .map((x) => ({ id: x.id, cScore: x.cScore, contentPreview: x.content.slice(0, 200) })),
}));
writeFileSync(HANDLOOK_PATH, JSON.stringify(handlook, null, 2));

console.log(`\nWrote ${OUT_PATH} and ${HANDLOOK_PATH}`);
console.log(`calls: ${jevHttp.calls} (ok ${jevHttp.ok}, failed ${jevHttp.failed}, 422 ${jevHttp.code422}), cost $${((inputTokensTotal / 1e6) * USD_PER_MTOK).toFixed(4)}`);
console.log(`AUC: F1=${aucTable.F1?.toFixed(4)} F2=${aucTable.F2?.toFixed(4)} J1=${aucTable.J1?.toFixed(4)} J2=${aucTable.J2?.toFixed(4)}`);
if (notes.length) console.log('NOTES:', notes.join(' | '));
