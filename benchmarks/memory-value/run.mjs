#!/usr/bin/env node
/**
 * LC2-E1 — orchestrator CLI: split -> ingest -> simulate -> extract -> evaluate.
 *
 * Usage:
 *   node run.mjs --smoke
 *   node run.mjs --data <path> --questions 3
 *   node run.mjs --data <path> --budget 0.3 [--full] [--skip-simulate] [--keep-stores]
 *
 * --data <path>       Real LongMemEval dataset (required unless --smoke). In
 *                      the episode worktree this MUST be the main checkout's
 *                      copy: benchmarks/longmemeval/data/ is gitignored and
 *                      not populated in worktrees (see benchmarks/memory-value/README.md).
 * --smoke              Synthetic 12-question fixture (common.mjs
 *                      generateSmokeFixture), no --data needed. <60s.
 * --questions N        Seeded stratified-by-type subset of N questions
 *                      instead of the full dataset.
 * --budget B           Report emphasis only — evaluate.mjs always scores
 *                      every CONFIG.KEEP_BUDGETS value; B just becomes the
 *                      headline number in the printed summary. Default
 *                      CONFIG.PRIMARY_BUDGET (0.3).
 * --skip-simulate      Ablation: extract features WITHOUT the usage
 *                      simulation (retrieval_count/outcome_* stay at their
 *                      ingest-time defaults).
 * --keep-stores        Do not delete scratch stores after extraction
 *                      (default: cleaned up once features.jsonl exists).
 * --weights <file>     Forwarded to evaluate.mjs's --weights hook (E2).
 * --seed N             Overrides CONFIG.GLOBAL_SEED for this run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.mjs';
import {
  loadDataset,
  generateSmokeFixture,
  rngFor,
  seededShuffle,
  apportionLargestRemainder,
  questionDir,
  hippoRootFor,
  safeRemoveScratchDir,
  writeJson,
  readJson,
  RESULTS_DIR,
} from './common.mjs';
import { computeSplit } from './split.mjs';
import { ingestQuestion } from './ingest.mjs';
import { simulateQuestion } from './simulate.mjs';
import { extractQuestion } from './extract.mjs';
import { evaluateAll } from './evaluate.mjs';

/** Seeded stratified-by-type subset of `n` question ids from `questions`. */
function selectSubset(questions, n, seed) {
  if (n >= questions.length) return questions.map((q) => q.question_id);
  const byType = new Map();
  for (const q of questions) {
    if (!byType.has(q.question_type)) byType.set(q.question_type, []);
    byType.get(q.question_type).push(q.question_id);
  }
  const counts = {};
  for (const [type, ids] of byType) counts[type] = ids.length;
  const perType = apportionLargestRemainder(counts, n);
  const selected = [];
  for (const [type, ids] of byType) {
    const rand = rngFor('subset', String(seed), type);
    const shuffled = seededShuffle(rand, ids.slice().sort());
    selected.push(...shuffled.slice(0, perType[type] ?? 0));
  }
  return selected.sort();
}

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function boolFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const smoke = boolFlag('smoke');
  const dataPathArg = flag('data');
  const questionsN = flag('questions') ? parseInt(flag('questions'), 10) : null;
  const budgetHeadline = parseFloat(flag('budget', String(CONFIG.PRIMARY_BUDGET)));
  const skipSimulate = boolFlag('skip-simulate');
  const keepStores = boolFlag('keep-stores');
  const weightsPath = flag('weights');
  const seed = parseInt(flag('seed', String(CONFIG.GLOBAL_SEED)), 10);

  if (!smoke && !dataPathArg) {
    console.error('Usage: run.mjs --smoke | --data <path> [--questions N] [--budget 0.3] [--skip-simulate] [--keep-stores] [--weights <file>]');
    process.exit(2);
  }

  let questions;
  let dataLabel;
  if (smoke) {
    questions = generateSmokeFixture();
    dataLabel = 'smoke-fixture (synthetic, in-memory)';
  } else {
    questions = loadDataset(dataPathArg);
    dataLabel = dataPathArg;
  }

  const splitResult = computeSplit(questions, { seed });
  const splitById = new Map();
  for (const id of splitResult.train) splitById.set(id, 'train');
  for (const id of splitResult.heldout) splitById.set(id, 'heldout');
  // Persist split.json so a later standalone `evaluate.mjs --weights <file>`
  // (E2's re-scoring path, no re-ingest/simulate/extract needed) has a
  // split to read by default, not just `split.mjs` run in isolation.
  writeJson(path.join(RESULTS_DIR, 'split.json'), { ...splitResult, generatedAt: new Date().toISOString(), source: dataLabel });

  const targetIds = questionsN !== null ? selectSubset(questions, questionsN, seed) : questions.map((q) => q.question_id);
  const byId = new Map(questions.map((q) => [q.question_id, q]));

  console.log(
    `[run] ${smoke ? 'SMOKE' : 'REAL'} data=${dataLabel} questions=${targetIds.length}/${questions.length} ` +
      `skipSimulate=${skipSimulate} budget=${budgetHeadline} seed=${seed}`,
  );

  const timings = { ingestMs: 0, simulateMs: 0, extractMs: 0, perQuestion: [] };
  const goldModeCounts = { 'evidence-turn': 0, 'answer-session-all': 0 };
  const processed = [];

  const overallT0 = Date.now();
  for (const questionId of targetIds) {
    const q = byId.get(questionId);
    const per = { questionId, ingestMs: 0, simulateMs: 0, extractMs: 0 };

    let t0 = Date.now();
    const ingestResult = ingestQuestion(q);
    per.ingestMs = Date.now() - t0;
    timings.ingestMs += per.ingestMs;
    goldModeCounts[ingestResult.goldMode] = (goldModeCounts[ingestResult.goldMode] ?? 0) + 1;

    if (!skipSimulate) {
      t0 = Date.now();
      const meta = readJson(path.join(questionDir(questionId), 'meta.json'));
      await simulateQuestion(questionId, meta.questionDate, { seed });
      per.simulateMs = Date.now() - t0;
      timings.simulateMs += per.simulateMs;
    }

    t0 = Date.now();
    const meta = readJson(path.join(questionDir(questionId), 'meta.json'));
    extractQuestion(questionId, meta.questionDate);
    per.extractMs = Date.now() - t0;
    timings.extractMs += per.extractMs;

    timings.perQuestion.push(per);
    processed.push({ questionId, split: splitById.get(questionId) ?? 'train', memoryCount: ingestResult.memoryCount });
  }

  // evaluate.mjs reads each question's features.jsonl from its scratch dir,
  // so cleanup MUST happen after evaluation, not right after extraction.
  const evalT0 = Date.now();
  const weights = weightsPath ? readJson(weightsPath) : undefined;
  const evaluation = evaluateAll(
    processed.map(({ questionId, split }) => ({ questionId, split })),
    { weights, primaryBudget: budgetHeadline },
  );
  const evaluateMs = Date.now() - evalT0;
  const totalMs = Date.now() - overallT0;

  // Cleanup deletes ONLY the SQLite store dir (codex review fix round,
  // 2026-08-09), not the whole question dir: gold.json/meta.json/
  // features.jsonl survive, so a later standalone `evaluate.mjs --weights`
  // (E2's re-scoring path) can run against this run's features without
  // re-ingesting. safeRemoveScratchDir re-verifies containment before
  // every delete (common.mjs).
  if (!keepStores) {
    for (const { questionId } of processed) {
      safeRemoveScratchDir(hippoRootFor(questionId));
    }
  }

  const results = {
    meta: {
      generatedAt: new Date().toISOString(),
      mode: smoke ? 'smoke' : 'real',
      dataPath: smoke ? null : dataPathArg,
      seed,
      questionsRequested: targetIds.length,
      questionsProcessed: processed.length,
      goldModeCounts,
      skipSimulate,
      keepStores,
      headlineBudget: budgetHeadline,
      config: CONFIG,
    },
    split: {
      seed: splitResult.seed,
      trainFraction: splitResult.trainFraction,
      totalQuestions: splitResult.totalQuestions,
      trainCount: splitResult.train.length,
      heldoutCount: splitResult.heldout.length,
    },
    timings: {
      ...timings,
      evaluateMs,
      totalMs,
    },
    evaluate: evaluation,
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(RESULTS_DIR, `${stamp}${smoke ? '-smoke' : ''}.json`);
  writeJson(outPath, results);
  writeJson(path.join(RESULTS_DIR, 'latest.json'), results);

  console.log(`[run] stages: ingest=${timings.ingestMs}ms simulate=${timings.simulateMs}ms extract=${timings.extractMs}ms evaluate=${evaluateMs}ms total=${totalMs}ms`);
  console.log(`[run] gold modes: ${JSON.stringify(goldModeCounts)}`);

  // Runtime variance gate (code-review-critic fix round, 2026-08-09): a real
  // (non-smoke) run where fewer than 6 features vary dataset-wide means the
  // substrate degenerated (e.g. an ingest regression froze every lifecycle
  // field) — fail loudly instead of silently shipping a uniform/best-single
  // comparison built on dead dims. Results are written FIRST so the failure
  // is debuggable. Exempt for --smoke: a 12-question synthetic fixture can
  // legitimately have thinner variance than the acceptance bar cares about.
  const gate = evaluation.varianceGate;
  console.log(
    `[run] variance gate: ${gate.varyingCount}/${CONFIG.FEATURES.length} features vary dataset-wide (min required: ${gate.minVarying})`,
  );
  console.log(`[run] varying: ${gate.varyingFeatures.join(', ') || '(none)'}`);
  console.log(`[run] dead: ${gate.deadFeatures.join(', ') || '(none)'}`);
  if (!smoke && !gate.passed) {
    console.error(
      `[run] VARIANCE GATE FAILED: only ${gate.varyingCount} feature(s) vary dataset-wide, need >= ${gate.minVarying}.`,
    );
    console.error(`[run] dead dims: ${gate.deadFeatures.join(', ')}`);
    console.error(`[run] results were still written to ${outPath} for debugging.`);
    process.exit(1);
  }

  for (const split of Object.keys(evaluation.summary)) {
    const s = evaluation.summary[split];
    const uniform = s.uniform?.[budgetHeadline];
    const recency = s.recency?.[budgetHeadline];
    console.log(
      `[run] ${split}: uniform@${budgetHeadline}=${uniform?.meanRetention?.toFixed(4)} ` +
        `recency@${budgetHeadline}=${recency?.meanRetention?.toFixed(4)} ` +
        `(n=${uniform?.questionsIncluded}, skipped0gold=${uniform?.questionsSkippedZeroGold})`,
    );
  }
  console.log(`[run] wrote ${outPath}`);
  console.log(`[run] wrote ${path.join(RESULTS_DIR, 'latest.json')}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
