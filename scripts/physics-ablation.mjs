#!/usr/bin/env node
/**
 * Physics-search ablation: physics ON vs physics OFF on the same corpus.
 *
 * Builds a fresh store from a LongMemEval subset (50 questions -> ~113
 * sessions ingested as memories). Each memory is tagged with its source
 * session ID so ground truth is recoverable. Runs both hybridSearch
 * (classic BM25+cosine+MMR) and physicsSearch (particle simulation) in-
 * process. Reports MRR, NDCG@5, Recall@5, and mean query latency.
 *
 * Run:
 *   node scripts/physics-ablation.mjs
 *
 * Flags:
 *   --num-questions N   (default 50)
 *   --store DIR         (default benchmarks/physics-ablation/store)
 *   --rebuild           force re-ingest even if store exists
 *   --out DIR           (default benchmarks/physics-ablation)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// hippo internals — use dist so we call production code paths
import { createMemory } from '../dist/memory.js';
import { writeEntry, loadAllEntries, initStore } from '../dist/store.js';
import { embedMemory, loadEmbeddingIndex, isEmbeddingAvailable, resolveEmbeddingModel } from '../dist/embeddings.js';
import { resetAllPhysicsState, loadPhysicsState } from '../dist/physics-state.js';
import { openHippoDb, closeHippoDb } from '../dist/db.js';
import { hybridSearch, physicsSearch, buildCorpus } from '../dist/search.js';
import { DEFAULT_PHYSICS_CONFIG } from '../dist/physics-config.js';

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUT_DIR = flag('--out', path.join(REPO, 'benchmarks', 'physics-ablation'));
const STORE_DIR = flag('--store', path.join(OUT_DIR, 'store'));
const HIPPO_ROOT = path.join(STORE_DIR, '.hippo');
const NUM_QUESTIONS = parseInt(flag('--num-questions', '50'), 10);
const REBUILD = process.argv.includes('--rebuild');
const DATA_PATH = path.join(REPO, 'benchmarks', 'longmemeval', 'data', 'longmemeval_oracle.json');

fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Metrics (matching src/eval.ts)
// ---------------------------------------------------------------------------

function mrr(returned, expectedSet) {
  for (let i = 0; i < returned.length; i++) {
    if (expectedSet.has(returned[i])) return 1 / (i + 1);
  }
  return 0;
}

function recallAtK(returned, expectedSet, k) {
  if (expectedSet.size === 0) return 0;
  const top = returned.slice(0, k);
  let hits = 0;
  for (const id of top) if (expectedSet.has(id)) hits++;
  return hits / expectedSet.size;
}

function ndcgAtK(returned, expectedSet, k) {
  if (expectedSet.size === 0) return 0;
  let dcg = 0;
  for (let i = 0; i < Math.min(k, returned.length); i++) {
    if (expectedSet.has(returned[i])) dcg += 1 / Math.log2(i + 2);
  }
  const ideal = Math.min(k, expectedSet.size);
  let idcg = 0;
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

// ---------------------------------------------------------------------------
// Paired bootstrap CI for the difference of means (physics - classic).
// ---------------------------------------------------------------------------

function pairedBootstrapCI(diffs, iters = 5000, alpha = 0.05) {
  const n = diffs.length;
  if (n === 0) return { meanDiff: 0, low: 0, high: 0 };
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const boots = new Array(iters);
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      s += diffs[Math.floor(Math.random() * n)];
    }
    boots[b] = s / n;
  }
  boots.sort((a, b) => a - b);
  const lo = boots[Math.floor((alpha / 2) * iters)];
  const hi = boots[Math.floor((1 - alpha / 2) * iters)];
  return { meanDiff: mean, low: lo, high: hi };
}

// ---------------------------------------------------------------------------
// Ingest: build a fresh store from LongMemEval subset
// ---------------------------------------------------------------------------

function sessionToContent(questionDate, sessionId, turns) {
  const header = `[Date: ${questionDate || 'unknown'}]\n[Session: ${sessionId}]\n\n`;
  const body = turns
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
    .join('\n');
  return header + body;
}

async function buildStore(questions) {
  // fresh dir
  if (fs.existsSync(HIPPO_ROOT)) {
    fs.rmSync(HIPPO_ROOT, { recursive: true, force: true });
  }
  fs.mkdirSync(STORE_DIR, { recursive: true });
  initStore(HIPPO_ROOT);

  console.error(`Ingesting into ${HIPPO_ROOT}...`);
  const sessionToMemId = new Map(); // answer_session_id -> mem id
  let totalSessions = 0;

  for (const q of questions) {
    for (let i = 0; i < q.haystack_sessions.length; i++) {
      const sid = q.haystack_session_ids[i];
      if (sessionToMemId.has(sid)) continue; // dedup: some sessions appear in multiple questions
      const date = q.haystack_dates ? q.haystack_dates[i] : '';
      const content = sessionToContent(date, sid, q.haystack_sessions[i]);
      // trim excessive length: embedding model has limits
      const trimmed = content.length > 8000 ? content.slice(0, 8000) : content;
      const entry = createMemory(trimmed, {
        tags: [`session:${sid}`],
        source: 'physics-ablation',
      });
      writeEntry(HIPPO_ROOT, entry);
      sessionToMemId.set(sid, entry.id);
      totalSessions++;
      if (totalSessions % 25 === 0) {
        console.error(`  wrote ${totalSessions} session-memories`);
      }
    }
  }
  console.error(`Ingest complete: ${totalSessions} sessions -> memories`);
  return sessionToMemId;
}

async function embedStoreAndInitPhysics() {
  if (!isEmbeddingAvailable()) {
    throw new Error('Embeddings not available — physics engine needs them');
  }
  const entries = loadAllEntries(HIPPO_ROOT);
  console.error(`Embedding ${entries.length} memories (this populates physics state)...`);
  const eStart = Date.now();
  let done = 0;
  for (const e of entries) {
    await embedMemory(HIPPO_ROOT, e);
    done++;
    if (done % 10 === 0) {
      const rate = done / ((Date.now() - eStart) / 1000);
      console.error(`  ${done}/${entries.length}  ${rate.toFixed(1)}/s`);
    }
  }
  console.error(`Embedding done in ${((Date.now() - eStart) / 1000).toFixed(1)}s`);

  // Verify physics state exists for all entries
  const db = openHippoDb(HIPPO_ROOT);
  try {
    const n = db.prepare('SELECT COUNT(*) as c FROM memory_physics').get();
    console.error(`Physics particles: ${n.c}/${entries.length}`);
  } finally {
    closeHippoDb(db);
  }
}

// ---------------------------------------------------------------------------
// Run evals
// ---------------------------------------------------------------------------

async function runAblation(cases, entries) {
  // Pre-build BM25 corpus once (same for both passes — it's a function of
  // entries, not of toggle).
  const corpus = buildCorpus(entries.map((e) => `${e.content} ${e.tags.join(' ')}`));

  const passes = [
    {
      name: 'classic',
      label: 'hybrid BM25+cosine+MMR (physics OFF)',
      run: async (q) => hybridSearch(q, entries, {
        hippoRoot: HIPPO_ROOT,
        preparedCorpus: corpus,
        budget: 1_000_000,
        minResults: 10,
      }),
    },
    {
      name: 'physics',
      label: 'physicsSearch (physics ON)',
      run: async (q) => physicsSearch(q, entries, {
        hippoRoot: HIPPO_ROOT,
        physicsConfig: { ...DEFAULT_PHYSICS_CONFIG, enabled: true },
        budget: 1_000_000,
        minResults: 10,
      }),
    },
  ];

  // Warmup: run each pass once on the first query to prime caches, disk,
  // and embedding-model JIT. Prevents the first pass from eating the I/O
  // tax on cold starts and making its latency look worse.
  if (cases.length > 0) {
    console.error('Warmup (1 query each pass)...');
    for (const p of passes) {
      await p.run(cases[0].query);
    }
  }

  const summary = {};
  for (const p of passes) {
    console.error(`\n=== Running pass: ${p.label} ===`);
    const perCase = [];
    const start = Date.now();
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const qStart = Date.now();
      let results;
      try {
        results = await p.run(c.query);
      } catch (err) {
        console.error(`  [${i}] ${c.id} FAILED: ${err.message}`);
        results = [];
      }
      const elapsed = Date.now() - qStart;
      const returnedIds = results.map((r) => r.entry.id);
      const expectedSet = new Set(c.expectedIds);
      perCase.push({
        id: c.id,
        query: c.query,
        questionType: c.questionType,
        returnedIds,
        expectedIds: c.expectedIds,
        mrr: mrr(returnedIds, expectedSet),
        recallAt5: recallAtK(returnedIds, expectedSet, 5),
        ndcgAt5: ndcgAtK(returnedIds, expectedSet, 5),
        ndcgAt10: ndcgAtK(returnedIds, expectedSet, 10),
        latencyMs: elapsed,
      });
      if ((i + 1) % 10 === 0) {
        const rate = (i + 1) / ((Date.now() - start) / 1000);
        console.error(`  ${i + 1}/${cases.length}  ${rate.toFixed(1)}/s`);
      }
    }
    const n = Math.max(1, perCase.length);
    summary[p.name] = {
      label: p.label,
      n: perCase.length,
      meanMrr: perCase.reduce((s, r) => s + r.mrr, 0) / n,
      meanRecallAt5: perCase.reduce((s, r) => s + r.recallAt5, 0) / n,
      meanNdcgAt5: perCase.reduce((s, r) => s + r.ndcgAt5, 0) / n,
      meanNdcgAt10: perCase.reduce((s, r) => s + r.ndcgAt10, 0) / n,
      meanLatencyMs: perCase.reduce((s, r) => s + r.latencyMs, 0) / n,
      totalMs: Date.now() - start,
      cases: perCase,
    };
  }

  return summary;
}

function fmtPct(x) { return (100 * x).toFixed(2) + '%'; }
function fmtMs(x) { return x.toFixed(1) + 'ms'; }
function sign(x) { return x >= 0 ? '+' : ''; }

function writeReport(summary, metadata) {
  const cl = summary.classic;
  const ph = summary.physics;

  // Per-case paired diffs
  const byId = new Map(cl.cases.map((c) => [c.id, c]));
  const diffsMrr = [], diffsR5 = [], diffsNdcg5 = [], diffsLat = [];
  // Per-question-type breakdown
  const byType = new Map();
  for (const pc of ph.cases) {
    const cc = byId.get(pc.id);
    if (!cc) continue;
    diffsMrr.push(pc.mrr - cc.mrr);
    diffsR5.push(pc.recallAt5 - cc.recallAt5);
    diffsNdcg5.push(pc.ndcgAt5 - cc.ndcgAt5);
    diffsLat.push(pc.latencyMs - cc.latencyMs);
    const t = pc.questionType || 'unknown';
    if (!byType.has(t)) byType.set(t, { n: 0, cNdcg5: 0, pNdcg5: 0, cMrr: 0, pMrr: 0 });
    const b = byType.get(t);
    b.n++;
    b.cNdcg5 += cc.ndcgAt5;
    b.pNdcg5 += pc.ndcgAt5;
    b.cMrr += cc.mrr;
    b.pMrr += pc.mrr;
  }
  const typeRows = [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([t, b]) => ({
    type: t, n: b.n,
    classicNdcg5: b.cNdcg5 / b.n,
    physicsNdcg5: b.pNdcg5 / b.n,
    classicMrr: b.cMrr / b.n,
    physicsMrr: b.pMrr / b.n,
  }));
  const ciMrr = pairedBootstrapCI(diffsMrr);
  const ciR5 = pairedBootstrapCI(diffsR5);
  const ciNdcg5 = pairedBootstrapCI(diffsNdcg5);
  const ciLat = pairedBootstrapCI(diffsLat);

  // Verdict
  const ndcgDelta = ph.meanNdcgAt5 - cl.meanNdcgAt5;
  const latRatio = ph.meanLatencyMs / Math.max(cl.meanLatencyMs, 1e-9);
  const ciCrossesZero = ciNdcg5.low < 0 && ciNdcg5.high > 0;

  // Check per-type signals — is there any type where physics wins by >2pp?
  const winningTypes = typeRows.filter(r => (r.physicsNdcg5 - r.classicNdcg5) > 0.02);
  const losingTypes = typeRows.filter(r => (r.physicsNdcg5 - r.classicNdcg5) < -0.02);

  let verdict, verdictReason;
  if (ndcgDelta < -0.02 && !ciCrossesZero) {
    if (winningTypes.length > 0 && losingTypes.length > 0) {
      verdict = 'CONDITIONAL';
      verdictReason = `Aggregate loss of ${(ndcgDelta * 100).toFixed(2)} pp NDCG@5, but physics wins on ${winningTypes.map(r => r.type).join(', ')} and loses on ${losingTypes.map(r => r.type).join(', ')}. Consider a per-query-type gate rather than blanket keep/cut.`;
    } else {
      verdict = 'CUT';
      verdictReason = `Physics loses by ${(ndcgDelta * 100).toFixed(2)} pp NDCG@5 (95% CI ${(ciNdcg5.low * 100).toFixed(2)}..${(ciNdcg5.high * 100).toFixed(2)} pp, excludes 0). No query type gives physics an edge. Recommend removal.`;
    }
  } else if (ciCrossesZero && Math.abs(ndcgDelta) < 0.02) {
    verdict = latRatio > 2 ? 'CUT' : 'CUT';
    verdictReason = `Physics ties classic on NDCG@5 (delta ${sign(ndcgDelta)}${(ndcgDelta * 100).toFixed(2)} pp, 95% CI includes 0). At ${latRatio.toFixed(2)}x latency, 500 LOC of physics buys nothing. Recommend removal.`;
  } else if (ndcgDelta > 0 && Math.abs(ndcgDelta) < 0.02 && latRatio > 2) {
    verdict = 'CUT';
    verdictReason = `Physics wins trivially (<2 pp NDCG@5) at ${latRatio.toFixed(2)}x latency — not worth 500 LOC debt.`;
  } else if (ndcgDelta > 0.02 && !ciCrossesZero) {
    verdict = 'KEEP';
    verdictReason = `Physics beats classic by ${sign(ndcgDelta)}${(ndcgDelta * 100).toFixed(2)} pp NDCG@5 (95% CI ${(ciNdcg5.low * 100).toFixed(2)}..${(ciNdcg5.high * 100).toFixed(2)} pp), latency ${latRatio.toFixed(2)}x.`;
  } else {
    verdict = 'CONDITIONAL';
    verdictReason = `Signal is mixed (delta ${sign(ndcgDelta)}${(ndcgDelta * 100).toFixed(2)} pp, CI ${(ciNdcg5.low * 100).toFixed(2)}..${(ciNdcg5.high * 100).toFixed(2)}). Review per-case regressions.`;
  }

  const results = {
    metadata: {
      ...metadata,
      hippoVersion: '0.31.0',
      generatedAt: new Date().toISOString(),
      config: { embeddingModel: resolveEmbeddingModel(HIPPO_ROOT) },
    },
    summary: {
      classic: {
        label: cl.label,
        n: cl.n,
        meanMrr: cl.meanMrr,
        meanRecallAt5: cl.meanRecallAt5,
        meanNdcgAt5: cl.meanNdcgAt5,
        meanNdcgAt10: cl.meanNdcgAt10,
        meanLatencyMs: cl.meanLatencyMs,
        totalMs: cl.totalMs,
      },
      physics: {
        label: ph.label,
        n: ph.n,
        meanMrr: ph.meanMrr,
        meanRecallAt5: ph.meanRecallAt5,
        meanNdcgAt5: ph.meanNdcgAt5,
        meanNdcgAt10: ph.meanNdcgAt10,
        meanLatencyMs: ph.meanLatencyMs,
        totalMs: ph.totalMs,
      },
    },
    deltas: {
      mrr: { mean: ciMrr.meanDiff, ci95: [ciMrr.low, ciMrr.high] },
      recallAt5: { mean: ciR5.meanDiff, ci95: [ciR5.low, ciR5.high] },
      ndcgAt5: { mean: ciNdcg5.meanDiff, ci95: [ciNdcg5.low, ciNdcg5.high] },
      latencyMs: { mean: ciLat.meanDiff, ci95: [ciLat.low, ciLat.high] },
    },
    verdict,
    verdictReason,
    perType: typeRows,
    perCase: {
      classic: cl.cases,
      physics: ph.cases,
    },
  };

  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));

  const md = `# Physics Search Ablation

**Hippo version:** 0.31.0
**Generated:** ${results.metadata.generatedAt}
**Dataset:** LongMemEval subset (${metadata.numQuestions} stratified questions across 6 types), ${cl.n} eval cases, ${metadata.corpusSize} memories
**Ground truth:** \`answer_session_ids\` from LongMemEval oracle. A retrieval is a hit if any returned memory is tagged with one of the correct session IDs.

## Results

| Metric | Physics OFF (classic) | Physics ON | Delta | 95% CI (paired bootstrap) |
|---|---|---|---|---|
| MRR | ${cl.meanMrr.toFixed(4)} | ${ph.meanMrr.toFixed(4)} | ${sign(ciMrr.meanDiff)}${ciMrr.meanDiff.toFixed(4)} | [${ciMrr.low.toFixed(4)}, ${ciMrr.high.toFixed(4)}] |
| Recall@5 | ${fmtPct(cl.meanRecallAt5)} | ${fmtPct(ph.meanRecallAt5)} | ${sign(ciR5.meanDiff * 100)}${(ciR5.meanDiff * 100).toFixed(2)} pp | [${(ciR5.low * 100).toFixed(2)}, ${(ciR5.high * 100).toFixed(2)}] pp |
| NDCG@5 | ${cl.meanNdcgAt5.toFixed(4)} | ${ph.meanNdcgAt5.toFixed(4)} | ${sign(ciNdcg5.meanDiff)}${ciNdcg5.meanDiff.toFixed(4)} | [${ciNdcg5.low.toFixed(4)}, ${ciNdcg5.high.toFixed(4)}] |
| NDCG@10 | ${cl.meanNdcgAt10.toFixed(4)} | ${ph.meanNdcgAt10.toFixed(4)} | ${sign(ph.meanNdcgAt10 - cl.meanNdcgAt10)}${(ph.meanNdcgAt10 - cl.meanNdcgAt10).toFixed(4)} | — |
| Mean latency / query | ${fmtMs(cl.meanLatencyMs)} | ${fmtMs(ph.meanLatencyMs)} | ${sign(ciLat.meanDiff)}${ciLat.meanDiff.toFixed(1)}ms (${latRatio.toFixed(2)}x) | [${ciLat.low.toFixed(1)}, ${ciLat.high.toFixed(1)}] ms |

**Total runtime:** classic ${(cl.totalMs / 1000).toFixed(1)}s, physics ${(ph.totalMs / 1000).toFixed(1)}s.

## Per question type

| Type | N | Classic NDCG@5 | Physics NDCG@5 | Delta | Classic MRR | Physics MRR |
|---|---|---|---|---|---|---|
${typeRows.map(r => `| ${r.type} | ${r.n} | ${r.classicNdcg5.toFixed(4)} | ${r.physicsNdcg5.toFixed(4)} | ${sign(r.physicsNdcg5 - r.classicNdcg5)}${(r.physicsNdcg5 - r.classicNdcg5).toFixed(4)} | ${r.classicMrr.toFixed(4)} | ${r.physicsMrr.toFixed(4)} |`).join('\n')}

## Verdict: ${verdict}

${verdictReason}

## Methodology

- **Corpus:** ${metadata.corpusSize} memories, each representing one conversation session from LongMemEval oracle. Each memory tagged with its \`session:<id>\`.
- **Queries:** ${cl.n} natural-language questions from LongMemEval. Ground truth = the set of sessions that actually contain the answer.
- **Classic path:** \`hybridSearch\` — BM25 + cosine + MMR re-ranking + path/scope/outcome/recency boosts. Calls the exact production code path used when \`config.physics.enabled === false\`.
- **Physics path:** \`physicsSearch\` — gravitational attraction to query, velocity momentum, cluster amplification from nearby high-scoring memories. Calls the exact production code path used when \`config.physics.enabled === true\`.
- **Shared:** same store, same embedding index, same budget (unbounded tokens, minResults=10). Embeddings populated via \`embedMemory\` which also initializes physics state. No physics simulation steps were run between embedding and evaluation — particles are at their t=0 positions (= the original embedding).
- **CI:** paired bootstrap, 5000 iterations, alpha=0.05, over per-case differences.

## Caveats

- **Static physics state.** Physics state was initialized from embeddings but no \`simulate()\` cycles were run, so particle positions equal embedding positions. In production, \`hippo sleep\` evolves the state via Verlet integration. This eval measures the cluster-amplification + query-gravity scoring contribution, NOT the long-run benefit of drifted positions. A separate eval with N simulation cycles would test that.
- **Single corpus.** LongMemEval conversations are one style (chatty, long form). Results may differ on terse technical rules, code-dominant content, or other distributions.
- **No real-user queries.** All queries are from a benchmark designed for chatbot LLM memory, not for IDE/agent recall patterns that production hippo serves.
- **Bootstrap CI** assumes paired per-case differences are exchangeable — reasonable here since each question is independent.
`;
  fs.writeFileSync(path.join(OUT_DIR, 'README.md'), md);

  // Stdout table
  console.log('');
  console.log(md);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.error(`Physics Ablation — hippo-memory 0.31.0`);
  console.error(`Output: ${OUT_DIR}`);

  // Load LongMemEval
  console.error(`Loading LongMemEval from ${DATA_PATH}...`);
  const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const all = Array.isArray(raw) ? raw : (raw.data ?? raw.questions ?? raw.entries);

  // Stratified sample across question types so we don't over-weight one type
  // (the oracle dataset is sorted by type, so a naive slice(0, N) returns
  // N cases all of the same type — useless for a general-purpose ablation).
  const byType = new Map();
  for (const q of all) {
    if (!byType.has(q.question_type)) byType.set(q.question_type, []);
    byType.get(q.question_type).push(q);
  }
  const types = [...byType.keys()];
  const perType = Math.ceil(NUM_QUESTIONS / types.length);
  const questions = [];
  for (const t of types) {
    const pool = byType.get(t);
    // Deterministic: take first `perType` in dataset order; each type's pool
    // is already in a fixed order in the oracle file, so runs are reproducible.
    for (let i = 0; i < Math.min(perType, pool.length); i++) {
      questions.push(pool[i]);
    }
  }
  // Trim back to NUM_QUESTIONS
  questions.length = Math.min(NUM_QUESTIONS, questions.length);
  console.error(`  ${questions.length} questions stratified across ${types.length} types (of ${all.length} total)`);
  const typeCounts = {};
  for (const q of questions) typeCounts[q.question_type] = (typeCounts[q.question_type] || 0) + 1;
  console.error(`  type mix: ${JSON.stringify(typeCounts)}`);

  // Build store or reuse
  let sessionToMemId;
  const existingStore = fs.existsSync(path.join(HIPPO_ROOT, 'hippo.db'));
  if (existingStore && !REBUILD) {
    console.error(`Reusing existing store at ${HIPPO_ROOT} (pass --rebuild to re-ingest)`);
    // Rebuild session->mem map from entries
    const entries = loadAllEntries(HIPPO_ROOT);
    sessionToMemId = new Map();
    for (const e of entries) {
      const sTag = e.tags.find((t) => t.startsWith('session:'));
      if (sTag) sessionToMemId.set(sTag.slice('session:'.length), e.id);
    }
    console.error(`  recovered ${sessionToMemId.size} session->memory mappings`);
  } else {
    sessionToMemId = await buildStore(questions);
    await embedStoreAndInitPhysics();
  }

  // Build eval cases. Expected = set of memory IDs for this question's answer sessions.
  const cases = [];
  let dropped = 0;
  for (const q of questions) {
    const expectedIds = (q.answer_session_ids || [])
      .map((sid) => sessionToMemId.get(sid))
      .filter(Boolean);
    if (expectedIds.length === 0) {
      dropped++;
      continue;
    }
    cases.push({
      id: q.question_id,
      query: q.question,
      expectedIds,
      questionType: q.question_type,
    });
  }
  console.error(`Eval cases: ${cases.length} (${dropped} dropped: no matching session in store)`);

  if (cases.length < 50) {
    console.error(`WARNING: only ${cases.length} cases — below the N>=50 target. Consider --num-questions 75.`);
  }

  // Load entries once for in-process searches
  const entries = loadAllEntries(HIPPO_ROOT);

  // Run the two passes
  const summary = await runAblation(cases, entries);

  // Report
  writeReport(summary, {
    numQuestions: NUM_QUESTIONS,
    corpusSize: entries.length,
  });
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
