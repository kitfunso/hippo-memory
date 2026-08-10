#!/usr/bin/env node
/**
 * LC2-E2 — linear memory-value weight fitter.
 *
 * Fits signed weights over the 8 live lifecycle dims (FIT_DIMS) that
 * maximize TRAIN mean gold retention at CONFIG.PRIMARY_BUDGET (0.3), using
 * the SHIPPED scoring path (evaluateStore/evaluateAll, imported unmodified
 * from evaluate.mjs) as the objective. See
 * docs/plans/2026-08-10-lc2-e2-memory-value-fit.md for the full protocol —
 * every constant below is pinned there, not invented here.
 *
 * Contract (plan decision 1): the ONLY new arithmetic in this file is the
 * train-mean-with-zero-gold-skip in computeTrainObjective. All
 * normalization, keep-selection, and retention math stays in the imported,
 * unmodified evaluateStore/evaluateAll.
 *
 * Usage:
 *   node fit.mjs                 integrity gate -> 5-restart ES fit -> freeze
 *   node fit.mjs --dry-run-timing  gate, time ~20 candidates, project total
 *   node fit.mjs --report        post-freeze: heldout paired bootstrap CIs
 *   node fit.mjs --help          print usage and exit
 */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.mjs';
import { evaluateStore, evaluateAll } from './evaluate.mjs';
import { readJson, writeJson, readJsonl, featuresPathFor, rngFor, RESULTS_DIR } from './common.mjs';

// ---------------------------------------------------------------------------
// Pinned constants (plan decisions 2, 3, 6). None of these live in
// config.mjs — that file is E1's frozen protocol block and is off limits
// here (hard constraint: no changes to config.mjs).
// ---------------------------------------------------------------------------

/** The 8 live lifecycle dims (plan decision 2). Chosen from E1's
 *  within-store variance gate (results-latest.json `varyingFeatures`) — the
 *  22 remaining CONFIG.FEATURES are pinned to zero by OMISSION from the
 *  weights file (buildScorers treats a missing key as weight 0). */
export const FIT_DIMS = Object.freeze([
  'age_days',
  'half_life_days',
  'strength',
  'retrieval_count',
  'outcome_positive',
  'outcome_negative',
  'outcome_ratio',
  'content_length',
]);

const RESTARTS = 5;
const LAMBDA = 8;
const SIGMA0 = 0.3;
const FLAT_GENS_BEFORE_HALVE = 5;
const MAX_GENS = 60;
const SIGMA_MIN = 0.01;
const BOX = Object.freeze([-1, 1]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEIGHTS_PATH = path.join(HERE, 'weights-learned.json');
const META_PATH = path.join(HERE, 'weights-learned.meta.json');
const SPLIT_REGISTERED_PATH = path.join(HERE, 'split-registered.json');
const RESULTS_LATEST_PATH = path.join(HERE, 'results-latest.json');
const REPORT_PATH = path.join(RESULTS_DIR, 'fit-report-latest.json');

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function clipTo([lo, hi], v) {
  return Math.min(hi, Math.max(lo, v));
}

function l2norm(vec) {
  return Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
}

/** One Gaussian sample, exactly two rng() draws (Box-Muller). `rng()` can
 *  return 0 (mulberry32's range is [0,1)); floor u1 at Number.EPSILON so
 *  log() never returns -Infinity. */
function gaussianFromRng(rng) {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function sha256Hex(str) {
  return createHash('sha256').update(str).digest('hex');
}

/** Vector (FIT_DIMS order) -> flat {feature: weight} object. Missing dims
 *  are never emitted, so the result loads through buildScorers unchanged. */
export function toWeights(vector, dims = FIT_DIMS) {
  const w = {};
  dims.forEach((f, i) => {
    w[f] = vector[i];
  });
  return w;
}

// ---------------------------------------------------------------------------
// (1+lambda)-ES — objective-agnostic pure function (plan decision 3).
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   objective: (vector: number[]) => number,
 *   dims: unknown[],  // only .length is read (vector dimensionality)
 *   rng: () => number,
 *   lambda?: number, sigma0?: number, flatGensBeforeHalve?: number,
 *   maxGens?: number, sigmaMin?: number, box?: [number, number],
 *   init: number[],
 * }} opts
 * @returns {{ best: number[], bestObjective: number, generations: number,
 *   finalSigma: number, trajectory: Array<{gen:number, bestObjective:number, sigma:number}> }}
 */
export function runES({
  objective,
  dims,
  rng,
  lambda = 8,
  sigma0 = 0.3,
  flatGensBeforeHalve = 5,
  maxGens = 60,
  sigmaMin = 0.01,
  box = [-1, 1],
  init,
}) {
  const D = dims.length;
  let parent = init.map((v) => clipTo(box, v));
  let parentObjective = objective(parent);
  let sigma = sigma0;
  let flatCount = 0;
  let generations = 0;
  const trajectory = [{ gen: 0, bestObjective: parentObjective, sigma }];

  while (generations < maxGens && sigma >= sigmaMin) {
    generations++;
    let bestOffspring = null;
    let bestOffspringObjective = -Infinity;

    for (let k = 0; k < lambda; k++) {
      const candidate = new Array(D);
      for (let i = 0; i < D; i++) candidate[i] = clipTo(box, parent[i] + sigma * gaussianFromRng(rng));
      if (l2norm(candidate) < 1e-9) continue; // reject; skip this offspring, no resample
      const candObjective = objective(candidate);
      if (candObjective > bestOffspringObjective) {
        bestOffspringObjective = candObjective;
        bestOffspring = candidate;
      }
    }

    // Parent moves ONLY on strictly greater objective — a tie never replaces it.
    let improved = false;
    if (bestOffspring !== null && bestOffspringObjective > parentObjective) {
      parent = bestOffspring;
      parentObjective = bestOffspringObjective;
      improved = true;
    }

    if (improved) {
      flatCount = 0;
    } else {
      flatCount++;
      if (flatCount >= flatGensBeforeHalve) {
        sigma /= 2;
        flatCount = 0;
      }
    }
    trajectory.push({ gen: generations, bestObjective: parentObjective, sigma });
  }

  return { best: parent, bestObjective: parentObjective, generations, finalSigma: sigma, trajectory };
}

/** Best train objective across restarts; exact ties keep the LOWER restart
 *  index (ascending scan, strict-greater replacement only — plan decision 3). */
export function selectWinner(perRestart) {
  let winner = perRestart[0];
  for (let i = 1; i < perRestart.length; i++) {
    if (perRestart[i].trainObjective > winner.trainObjective) winner = perRestart[i];
  }
  return winner;
}

/** Restart 0 starts at the recency vector (age_days = -1, rest 0) — the
 *  search begins at the incumbent best single factor, so winner >= recency
 *  on TRAIN by construction. Restarts 1-4 start at a seeded random point in
 *  the box. */
export function initVectorForRestart(restartIndex, dims, rng, box = BOX) {
  if (restartIndex === 0) {
    const v = new Array(dims.length).fill(0);
    v[dims.indexOf('age_days')] = -1;
    return v;
  }
  const [lo, hi] = box;
  return dims.map(() => lo + rng() * (hi - lo));
}

// ---------------------------------------------------------------------------
// Objective: train mean `weighted` retention, evaluateStore-backed
// ---------------------------------------------------------------------------

/** Read every train question's features.jsonl ONCE (caching contract, plan
 *  decision 1) — never re-read per ES candidate. gold is already embedded
 *  in each row; gold.json is not part of evaluateStore's contract. */
export function cacheTrainRows(trainIds) {
  const cache = new Map();
  for (const id of trainIds) cache.set(id, readJsonl(featuresPathFor(id)));
  return cache;
}

/**
 * Mean `weighted` retention at `budget` over `trainIds`, applying the
 * IDENTICAL zero-gold skip rule as evaluateAll's aggregate (skip from both
 * sum and count; never pre-filter the id list — iterate all of them).
 * Returns null if every id was skipped (no id should ever hit this on the
 * real 300-train split, but the gate treats it as a hard failure either way).
 */
export function computeTrainObjective(weights, cachedRowsById, trainIds, budget = CONFIG.PRIMARY_BUDGET) {
  let sum = 0;
  let count = 0;
  for (const id of trainIds) {
    const rows = cachedRowsById.get(id);
    const result = evaluateStore(rows, [budget], weights);
    const cell = result.perScorer.weighted[budget];
    if (cell.retention === null) continue; // zero-gold skip, mirrors evaluateAll
    sum += cell.retention;
    count++;
  }
  return count > 0 ? sum / count : null;
}

// ---------------------------------------------------------------------------
// Integrity gate (plan decision 4) — runs before any fitting.
// ---------------------------------------------------------------------------

function assertGate(cond, message) {
  if (!cond) throw new Error(`[integrity-gate] FAILED ${message}`);
}

/**
 * Three assertions plus the varying-features check plus the recency
 * cross-check (plan test 8). Any failure throws with the assertion named —
 * the CLI turns that into a nonzero exit. No fit runs on a failed gate.
 *
 * Accepts pre-parsed `splitRegistered`/`registeredResults` (tests only) so
 * a tampered scratch root can be gated without writing throwaway files —
 * default reads the committed files.
 */
export function runIntegrityGate({ splitRegistered, registeredResults } = {}) {
  const split = splitRegistered ?? readJson(SPLIT_REGISTERED_PATH);
  const registered = registeredResults ?? readJson(RESULTS_LATEST_PATH);
  const budget = CONFIG.PRIMARY_BUDGET;

  // (a) split integrity: split-registered's counts must equal results-
  // latest's split block. Targets come from `registered` itself (the
  // committed file), not a duplicate hardcoded literal — a second copy of
  // the same fact is a second place it can drift out of sync.
  assertGate(
    split.train.length === registered.split.trainCount && split.heldout.length === registered.split.heldoutCount,
    `(a) split-registered train/heldout lengths (${split.train.length}/${split.heldout.length}) must equal ` +
      `results-latest split block (${registered.split.trainCount}/${registered.split.heldoutCount})`,
  );

  const registeredTrainRecency = registered.evaluate.summary.train.recency[budget];
  const registeredHeldoutRecency = registered.evaluate.summary.heldout.recency[budget];
  const registeredHeldoutUniform = registered.evaluate.summary.heldout.uniform[budget];

  // Reproduced summary over the COMMITTED split, no weights (baseline
  // scorers only) — the input to assertions (b) and (c).
  const questionSplits = [
    ...split.train.map((questionId) => ({ questionId, split: 'train' })),
    ...split.heldout.map((questionId) => ({ questionId, split: 'heldout' })),
  ];
  const reproduced = evaluateAll(questionSplits, { budgets: [budget], primaryBudget: budget });

  const trainRecency = reproduced.summary.train?.recency?.[budget];
  const heldoutRecency = reproduced.summary.heldout?.recency?.[budget];
  const heldoutUniform = reproduced.summary.heldout?.uniform?.[budget];
  assertGate(
    Boolean(trainRecency && heldoutRecency && heldoutUniform),
    '(b) reproduced summary is missing a train/heldout recency or uniform cell',
  );

  // (b) inclusion integrity — reproduced questionsIncluded must match the
  // registered file's own recorded post-zero-gold counts.
  assertGate(
    trainRecency.questionsIncluded === registeredTrainRecency.questionsIncluded,
    `(b) train recency questionsIncluded must be ${registeredTrainRecency.questionsIncluded}, got ${trainRecency.questionsIncluded}`,
  );
  assertGate(
    heldoutRecency.questionsIncluded === registeredHeldoutRecency.questionsIncluded,
    `(b) heldout recency questionsIncluded must be ${registeredHeldoutRecency.questionsIncluded}, got ${heldoutRecency.questionsIncluded}`,
  );

  // (c) baseline reproduction, 4dp, against the committed results-latest.json.
  assertGate(
    heldoutRecency.meanRetention.toFixed(4) === registeredHeldoutRecency.meanRetention.toFixed(4),
    `(c) heldout recency must reproduce ${registeredHeldoutRecency.meanRetention.toFixed(4)}, got ${heldoutRecency.meanRetention.toFixed(4)}`,
  );
  assertGate(
    heldoutUniform.meanRetention.toFixed(4) === registeredHeldoutUniform.meanRetention.toFixed(4),
    `(c) heldout uniform must reproduce ${registeredHeldoutUniform.meanRetention.toFixed(4)}, got ${heldoutUniform.meanRetention.toFixed(4)}`,
  );
  assertGate(
    trainRecency.meanRetention.toFixed(4) === registeredTrainRecency.meanRetention.toFixed(4),
    `(c) train recency must reproduce ${registeredTrainRecency.meanRetention.toFixed(4)}, got ${trainRecency.meanRetention.toFixed(4)}`,
  );

  // Varying-features set (registered, committed) must equal FIT_DIMS exactly.
  const registeredVarying = [...registered.evaluate.varyingFeatures].sort();
  const fitDimsSorted = [...FIT_DIMS].sort();
  assertGate(
    JSON.stringify(registeredVarying) === JSON.stringify(fitDimsSorted),
    `varying-features set must equal FIT_DIMS, got ${JSON.stringify(registeredVarying)}`,
  );

  // Row cache (caching contract, plan decision 1) + recency cross-check
  // (plan test 8): the fitter's OWN mean/skip-rule arithmetic, run on the
  // pure recency vector, must reproduce the registered train recency. Any
  // drift here means the objective's mean or skip rule disagrees with
  // evaluateAll's.
  const cachedRowsById = cacheTrainRows(split.train);
  const recencyWeights = toWeights(FIT_DIMS.map((f) => (f === 'age_days' ? -1 : 0)));
  const recencyCrossCheck = computeTrainObjective(recencyWeights, cachedRowsById, split.train, budget);
  const registeredTrainRecency4dp = registeredTrainRecency.meanRetention.toFixed(4);
  assertGate(
    recencyCrossCheck !== null && recencyCrossCheck.toFixed(4) === registeredTrainRecency4dp,
    `recency cross-check: fitter's own objective must reproduce train recency ${registeredTrainRecency4dp}, got ${recencyCrossCheck?.toFixed(4)}`,
  );

  return { splitRegistered: split, trainIds: split.train, cachedRowsById, reproduced };
}

// ---------------------------------------------------------------------------
// Fit (pure): 5 restarts, winner selection, L2-normalize on emit.
// ---------------------------------------------------------------------------

/**
 * No file I/O — callers write the two frozen artifacts. Exposed separately
 * from runFit() so tests can fit against a cached fixture without touching
 * weights-learned.json.
 */
export function computeFit(trainIds, cachedRowsById, opts = {}) {
  const restarts = opts.restarts ?? RESTARTS;
  const esOpts = {
    lambda: opts.lambda ?? LAMBDA,
    sigma0: opts.sigma0 ?? SIGMA0,
    flatGensBeforeHalve: opts.flatGensBeforeHalve ?? FLAT_GENS_BEFORE_HALVE,
    maxGens: opts.maxGens ?? MAX_GENS,
    sigmaMin: opts.sigmaMin ?? SIGMA_MIN,
    box: opts.box ?? BOX,
  };

  const objective = (vector) => {
    const result = computeTrainObjective(toWeights(vector), cachedRowsById, trainIds);
    return result === null ? -Infinity : result;
  };

  const perRestart = [];
  for (let r = 0; r < restarts; r++) {
    const rng = rngFor('fit', r);
    const init = initVectorForRestart(r, FIT_DIMS, rng, esOpts.box);
    const es = runES({ objective, dims: FIT_DIMS, rng, init, ...esOpts });
    perRestart.push({
      restart: r,
      init,
      best: es.best,
      generations: es.generations,
      finalSigma: es.finalSigma,
      trainObjective: es.bestObjective,
    });
  }

  const winner = selectWinner(perRestart);
  const norm = l2norm(winner.best);
  const normalized = winner.best.map((x) => x / norm);
  const weights = toWeights(normalized);

  const meta = {
    globalSeed: CONFIG.GLOBAL_SEED,
    restarts,
    perRestart: perRestart.map(({ restart, init, generations, finalSigma, trainObjective }) => ({
      restart,
      init,
      generations,
      finalSigma,
      trainObjective,
    })),
    winnerRestart: winner.restart,
    trainObjective: winner.trainObjective,
    featureList: [...FIT_DIMS],
    pinnedZero: CONFIG.FEATURES.filter((f) => !FIT_DIMS.includes(f)),
    configHash: sha256Hex(JSON.stringify(CONFIG)),
    frozenAt: new Date().toISOString(),
  };

  return { weights, meta, perRestart, winner };
}

// ---------------------------------------------------------------------------
// Bootstrap CI (plan decision 6) — paired per-question, percentile method.
// ---------------------------------------------------------------------------

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function percentile(sortedArr, p) {
  const idx = p * (sortedArr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  const frac = idx - lo;
  return sortedArr[lo] * (1 - frac) + sortedArr[hi] * frac;
}

/**
 * Resample question indices with replacement, `resamples` times; each
 * resample's statistic is its own mean delta. CI = 2.5/97.5 percentiles of
 * the resample-mean distribution (linear interpolation between order stats).
 */
export function bootstrapCI(deltas, resamples, rng) {
  const n = deltas.length;
  if (n === 0) return { point: null, ci95: [null, null] };
  const point = mean(deltas);
  const means = new Array(resamples);
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += deltas[Math.floor(rng() * n)];
    means[i] = sum / n;
  }
  means.sort((a, b) => a - b);
  return { point, ci95: [percentile(means, 0.025), percentile(means, 0.975)] };
}

function buildRetentionMap(pairedRecords, scorerName) {
  const m = new Map();
  for (const r of pairedRecords) {
    if (r.scorer === scorerName && r.retention !== null) m.set(r.questionId, r.retention);
  }
  return m;
}

function pairedDeltas(mapA, mapB) {
  const deltas = [];
  for (const [qid, a] of mapA) {
    if (mapB.has(qid)) deltas.push(a - mapB.get(qid));
  }
  return deltas;
}

// ---------------------------------------------------------------------------
// CLI orchestration
// ---------------------------------------------------------------------------

function runFit() {
  console.log('[fit] running integrity gate...');
  const { trainIds, cachedRowsById } = runIntegrityGate();
  console.log(`[fit] integrity gate passed; ${trainIds.length} train rows cached`);

  const { weights, meta, perRestart, winner } = computeFit(trainIds, cachedRowsById);
  for (const r of perRestart) {
    console.log(
      `[fit] restart ${r.restart}: trainObjective=${r.trainObjective.toFixed(4)} generations=${r.generations} finalSigma=${r.finalSigma.toFixed(4)}`,
    );
  }

  // Restart-0 invariant: impossible by construction (restart 0 starts at
  // recency and only moves on strict improvement). A violation is a fitter
  // bug, not a data outcome — fail loudly rather than freeze a bad result.
  const restart0Objective = perRestart[0].trainObjective;
  if (winner.trainObjective < restart0Objective) {
    throw new Error(
      `restart-0 invariant violated: winner trainObjective ${winner.trainObjective} < restart-0 (recency-init) ${restart0Objective}`,
    );
  }

  writeJson(WEIGHTS_PATH, weights);
  writeJson(META_PATH, meta);
  console.log(`[fit] winner: restart ${meta.winnerRestart}, trainObjective=${meta.trainObjective.toFixed(4)}`);
  console.log(`[fit] wrote ${WEIGHTS_PATH}`);
  console.log(`[fit] wrote ${META_PATH}`);
}

function dryRunTiming() {
  console.log('[fit] running integrity gate...');
  const { trainIds, cachedRowsById } = runIntegrityGate();
  console.log(`[fit] integrity gate passed; ${trainIds.length} train rows cached`);

  const N = 20;
  const rng = rngFor('fit', 'dry-run-timing');
  const [lo, hi] = BOX;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    const vector = FIT_DIMS.map(() => lo + rng() * (hi - lo));
    computeTrainObjective(toWeights(vector), cachedRowsById, trainIds);
  }
  const elapsedSec = Number(process.hrtime.bigint() - t0) / 1e9;
  const perCandidateSec = elapsedSec / N;
  const totalCandidates = RESTARTS * MAX_GENS * LAMBDA;
  const projectedMin = (perCandidateSec * totalCandidates) / 60;

  console.log(`[fit] dry-run-timing: ${perCandidateSec.toFixed(4)}s/candidate over ${N} candidates`);
  console.log(
    `[fit] projected total (${RESTARTS} restarts x ${MAX_GENS} gens x ${LAMBDA} offspring = ${totalCandidates} candidates): ${projectedMin.toFixed(1)} min`,
  );
  if (projectedMin > 75) {
    console.log(
      '[fit] projection exceeds 75 min: pre-registered fallback is 2 restarts (0, 1) — record the amendment before the real fit.',
    );
  }
}

function runReport() {
  const weights = readJson(WEIGHTS_PATH);
  const split = readJson(SPLIT_REGISTERED_PATH);
  const budget = CONFIG.PRIMARY_BUDGET;
  const questionSplits = [
    ...split.train.map((questionId) => ({ questionId, split: 'train' })),
    ...split.heldout.map((questionId) => ({ questionId, split: 'heldout' })),
  ];
  const evalResult = evaluateAll(questionSplits, { weights, budgets: [budget], primaryBudget: budget });

  const heldoutPaired = evalResult.pairedRecords.filter((r) => r.split === 'heldout');
  const weightedMap = buildRetentionMap(heldoutPaired, 'weighted');
  const recencyMap = buildRetentionMap(heldoutPaired, 'recency');
  const uniformMap = buildRetentionMap(heldoutPaired, 'uniform');

  // One shared rng stream (rngFor('report')), consumed sequentially by both
  // CIs — plan decision 6.
  const rng = rngFor('report');
  const ciVsRecency = bootstrapCI(pairedDeltas(weightedMap, recencyMap), CONFIG.E2_BOOTSTRAP_RESAMPLES, rng);
  const ciVsUniform = bootstrapCI(pairedDeltas(weightedMap, uniformMap), CONFIG.E2_BOOTSTRAP_RESAMPLES, rng);

  const s = evalResult.summary.heldout;
  const heldout = {
    weighted: s.weighted[budget].meanRetention,
    recency: s.recency[budget].meanRetention,
    uniform: s.uniform[budget].meanRetention,
  };
  const barsMet =
    heldout.weighted > heldout.recency &&
    heldout.weighted > heldout.uniform &&
    ciVsRecency.ci95[0] > 0 &&
    ciVsUniform.ci95[0] > 0;

  const report = {
    heldout,
    deltas: {
      vsRecency: { point: ciVsRecency.point, ci95: ciVsRecency.ci95 },
      vsUniform: { point: ciVsUniform.point, ci95: ciVsUniform.ci95 },
    },
    barsMet,
  };

  console.log(JSON.stringify(report, null, 2));
  writeJson(REPORT_PATH, report);
  console.log(`[fit] wrote ${REPORT_PATH}`);
}

function printUsage() {
  console.log(
    [
      'Usage: fit.mjs [--dry-run-timing | --report | --help]',
      '  (default)          integrity gate -> 5-restart ES fit -> weights-learned.json + .meta.json',
      '  --dry-run-timing   gate, then measure ~20 candidates, project total, exit without fitting',
      '  --report           post-freeze: evaluate weights-learned.json on heldout, paired bootstrap CIs',
      '  --help             print this message and exit',
    ].join('\n'),
  );
}

function boolFlag(name) {
  return process.argv.includes(`--${name}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    if (boolFlag('help')) printUsage();
    else if (boolFlag('dry-run-timing')) dryRunTiming();
    else if (boolFlag('report')) runReport();
    else runFit();
  } catch (err) {
    console.error(`[fit] FAILED: ${err.message}`);
    process.exit(1);
  }
}
