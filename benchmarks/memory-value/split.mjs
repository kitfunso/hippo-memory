#!/usr/bin/env node
/**
 * LC2-E1 — seeded, question-level, stratified-by-question_type split.
 *
 * 60/40 train/held-out over all 500 questions of longmemeval_s_cleaned.json
 * (pre-reg: seed 42, counts multi-session 133, temporal-reasoning 133,
 * knowledge-update 78, single-session-user 70, single-session-assistant 56,
 * single-session-preference 30 -> exactly 300 train / 200 held-out via
 * largest-remainder apportionment per type, see common.mjs
 * apportionLargestRemainder).
 *
 * Determinism: within each question_type bucket, questions are shuffled by
 * a seeded PRNG namespaced 'split'+type, then the first N (per apportionment)
 * go to train. No Math.random.
 *
 * Usage:
 *   node split.mjs --data <path> [--out <path>] [--seed 42] [--train-fraction 0.6]
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.mjs';
import {
  loadDataset,
  rngFor,
  seededShuffle,
  apportionLargestRemainder,
  writeJson,
  RESULTS_DIR,
} from './common.mjs';

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

/**
 * Pure function (no file IO) so run.mjs can call it in-process without a
 * subprocess round trip, and tests can exercise it directly.
 *
 * @param {Array<{question_id:string, question_type:string}>} questions
 * @param {{seed?: number, trainFraction?: number}} [opts]
 */
export function computeSplit(questions, opts = {}) {
  const seed = opts.seed ?? CONFIG.GLOBAL_SEED;
  const trainFraction = opts.trainFraction ?? CONFIG.TRAIN_FRACTION;

  const byType = new Map();
  for (const q of questions) {
    if (!byType.has(q.question_type)) byType.set(q.question_type, []);
    byType.get(q.question_type).push(q.question_id);
  }

  const counts = {};
  for (const [type, ids] of byType) counts[type] = ids.length;
  const totalTarget = Math.round(questions.length * trainFraction);
  const trainTargetByType = apportionLargestRemainder(counts, totalTarget);

  const train = [];
  const heldout = [];
  const perType = {};
  for (const [type, ids] of byType) {
    const rand = rngFor('split', String(seed), type);
    const shuffled = seededShuffle(rand, ids.slice().sort()); // sort first: input order must not matter
    const nTrain = trainTargetByType[type] ?? 0;
    const trainIds = shuffled.slice(0, nTrain);
    const heldoutIds = shuffled.slice(nTrain);
    train.push(...trainIds);
    heldout.push(...heldoutIds);
    perType[type] = { total: ids.length, train: trainIds.length, heldout: heldoutIds.length };
  }

  train.sort();
  heldout.sort();

  return {
    seed,
    trainFraction,
    totalQuestions: questions.length,
    counts: perType,
    train,
    heldout,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dataPath = flag('data');
  if (!dataPath) {
    console.error('Usage: split.mjs --data <path> [--out <path>] [--seed 42] [--train-fraction 0.6]');
    process.exit(2);
  }
  const out = flag('out', path.join(RESULTS_DIR, 'split.json'));
  const seed = parseInt(flag('seed', String(CONFIG.GLOBAL_SEED)), 10);
  const trainFraction = parseFloat(flag('train-fraction', String(CONFIG.TRAIN_FRACTION)));

  const questions = loadDataset(dataPath);
  const split = computeSplit(questions, { seed, trainFraction });
  writeJson(out, { ...split, generatedAt: new Date().toISOString(), source: dataPath });
  console.log(
    `[split] ${split.totalQuestions} questions -> train=${split.train.length} heldout=${split.heldout.length} ` +
      `(seed=${seed}, trainFraction=${trainFraction})`,
  );
  console.log(`[split] wrote ${out}`);
}
