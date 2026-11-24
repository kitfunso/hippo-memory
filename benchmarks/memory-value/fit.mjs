#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.mjs';
import { evaluateStore, evaluateAll } from './evaluate.mjs';
import { readJson, writeJson, readJsonl, featuresPathFor, rngFor, RESULTS_DIR, scratchRootDir } from './common.mjs';

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
const REPORT_REGISTERED_PATH = path.join(HERE, 'fit-report-registered.json');

function clipTo([lo, hi], v) {
  return Math.min(hi, Math.max(lo, v));
}

function l2norm(vec) {
  return Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
}

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
      const candidate = Array(D);
      for (let i = 0; i < D; i++) candidate[i] = clipTo(box, parent[i] + sigma * gaussianFromRng(rng));
      if (l2norm(candidate) < 1e-9) continue;
      const candObjective = objective(candidate);
      if (candObjective > bestOffspringObjective) {
        bestOffspringObjective = candObjective;
        bestOffspring = candidate;
      }
    }

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

/** Shared recency vector (age_days = -1, rest 0), in `dims` order. Restart
 *  0's init and crossCheckRecency's independent objective computation both
 *  need the IDENTICAL vector — a single exported source prevents the two
 *  call sites from silently drifting apart (fix round: previously each had
 *  its own inline literal). Throws a named error if `dims` lacks 'age_days'
 *  — the recency init/cross-check contract cannot hold without that dim. */
export function recencyVector(dims = FIT_DIMS) {
  const ageIdx = dims.indexOf('age_days');
  if (ageIdx === -1) {
    throw new Error(
      '[fit] FAILED recencyVector: dims is missing "age_days" — the recency init/cross-check contract requires it',
    );
  }
  const v = Array(dims.length).fill(0);
  v[ageIdx] = -1;
  return v;
}

/** Restart 0 starts at the recency vector (age_days = -1, rest 0) — the
 *  search begins at the incumbent best single factor, so winner >= recency
 *  on TRAIN by construction. Restarts 1-4 start at a seeded random point in
 *  the box. */
export function initVectorForRestart(restartIndex, dims, rng, box = BOX) {
  if (restartIndex === 0) {
    return recencyVector(dims);
  }
  const [lo, hi] = box;
  return dims.map(() => lo + rng() * (hi - lo));
}

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
    if (cell.retention === null) continue;
    sum += cell.retention;
    count++;
  }
  return count > 0 ? sum / count : null;
}

function assertGate(cond, message) {
  if (!cond) throw new Error(`[integrity-gate] FAILED ${message}`);
}

function isNumber(value) {
  return Object.prototype.toString.call(value) === '[object Number]';
}

function requireCell(value, message) {
  assertGate(value !== undefined && value !== null, message);
  return value;
}

function requireMeanCell(value, message) {
  assertGate(
    value !== undefined &&
      value !== null &&
      isNumber(value.meanRetention) &&
      isNumber(value.questionsIncluded),
    message,
  );
  return value;
}

function assertScratchExists(split) {
  const root = scratchRootDir();
  if (!fs.existsSync(root)) {
    throw new Error(
      `[integrity-gate] FAILED (scratch) scratch root does not exist: ${root} — re-run the E1 pipeline: ` +
        'node benchmarks/memory-value/run.mjs --data <path>',
    );
  }
  const allIds = [...split.train, ...split.heldout];
  const missing = allIds.filter((id) => !fs.existsSync(featuresPathFor(id)));
  if (missing.length > 0) {
    throw new Error(
      `[integrity-gate] FAILED (scratch) ${missing.length} split id(s) have no features.jsonl (first: ` +
        `${missing[0]}) — re-run the E1 pipeline: node benchmarks/memory-value/run.mjs --data <path>`,
    );
  }
}

function assertSplitIntegrity(split, registered) {
  const trainIds = requireCell(split?.train, '(a) split-registered is missing a train id array');
  const heldoutIds = requireCell(split?.heldout, '(a) split-registered is missing a heldout id array');
  const trainCount = requireCell(registered?.split?.trainCount, '(a) results-latest split block is missing trainCount');
  const heldoutCount = requireCell(registered?.split?.heldoutCount, '(a) results-latest split block is missing heldoutCount');

  assertGate(
    trainIds.length === trainCount && heldoutIds.length === heldoutCount,
    `(a) split-registered train/heldout lengths (${trainIds.length}/${heldoutIds.length}) must equal ` +
      `results-latest split block (${trainCount}/${heldoutCount})`,
  );

  const trainSet = new Set(trainIds);
  const heldoutSet = new Set(heldoutIds);
  assertGate(
    trainSet.size === trainIds.length,
    `(a) split-registered train contains duplicate ids (${trainIds.length} entries, ${trainSet.size} unique)`,
  );
  assertGate(
    heldoutSet.size === heldoutIds.length,
    `(a) split-registered heldout contains duplicate ids (${heldoutIds.length} entries, ${heldoutSet.size} unique)`,
  );
  let overlap = 0;
  for (const id of trainSet) if (heldoutSet.has(id)) overlap++;
  assertGate(overlap === 0, `(a) split-registered train and heldout overlap on ${overlap} id(s) — splits must be disjoint`);
}

function getMeanCell(summary, splitName, scorerName, budget, label) {
  return requireMeanCell(summary?.[splitName]?.[scorerName]?.[budget], label);
}

function assertInclusionMatches(reproducedCell, registeredCell, label, assertionTag) {
  assertGate(
    reproducedCell.questionsIncluded === registeredCell.questionsIncluded,
    `(${assertionTag}) ${label} questionsIncluded must be ${registeredCell.questionsIncluded}, got ${reproducedCell.questionsIncluded}`,
  );
}

function assertReproducesBaseline(reproducedCell, registeredCell, label) {
  assertGate(
    Math.abs(reproducedCell.meanRetention - registeredCell.meanRetention) < 5e-5,
    `(c) ${label} must reproduce ${registeredCell.meanRetention.toFixed(4)}, got ${reproducedCell.meanRetention.toFixed(4)}`,
  );
}

function reproduceAndAssertBaselines(split, registered, budget) {
  const registeredSummary = registered?.evaluate?.summary;
  const registeredTrainRecency = getMeanCell(registeredSummary, 'train', 'recency', budget, '(b) registered summary missing train.recency cell');
  const registeredHeldoutRecency = getMeanCell(registeredSummary, 'heldout', 'recency', budget, '(b) registered summary missing heldout.recency cell');
  const registeredHeldoutUniform = getMeanCell(registeredSummary, 'heldout', 'uniform', budget, '(b) registered summary missing heldout.uniform cell');
  const registeredTrainUniform = getMeanCell(registeredSummary, 'train', 'uniform', budget, '(b) registered summary missing train.uniform cell');

  const questionSplits = [
    ...split.train.map((questionId) => ({ questionId, split: 'train' })),
    ...split.heldout.map((questionId) => ({ questionId, split: 'heldout' })),
  ];
  const reproduced = evaluateAll(questionSplits, { budgets: [budget], primaryBudget: budget });

  const trainRecency = getMeanCell(reproduced.summary, 'train', 'recency', budget, '(b) reproduced summary is missing the train.recency cell');
  const heldoutRecency = getMeanCell(reproduced.summary, 'heldout', 'recency', budget, '(b) reproduced summary is missing the heldout.recency cell');
  const heldoutUniform = getMeanCell(reproduced.summary, 'heldout', 'uniform', budget, '(b) reproduced summary is missing the heldout.uniform cell');
  const trainUniform = getMeanCell(reproduced.summary, 'train', 'uniform', budget, '(b) reproduced summary is missing the train.uniform cell');

  assertInclusionMatches(trainRecency, registeredTrainRecency, 'train recency', 'b');
  assertInclusionMatches(heldoutRecency, registeredHeldoutRecency, 'heldout recency', 'b');

  assertReproducesBaseline(heldoutRecency, registeredHeldoutRecency, 'heldout recency');
  assertReproducesBaseline(heldoutUniform, registeredHeldoutUniform, 'heldout uniform');
  assertReproducesBaseline(trainRecency, registeredTrainRecency, 'train recency');
  assertReproducesBaseline(trainUniform, registeredTrainUniform, 'train uniform');
  assertInclusionMatches(trainUniform, registeredTrainUniform, 'train uniform', 'c');

  return reproduced;
}

function assertVarianceLiveness(reproduced, registered, expectedFitDims) {
  const registeredVarying = requireCell(
    registered?.evaluate?.varyingFeatures,
    '(b) registered evaluate block is missing varyingFeatures',
  );
  const registeredVaryingSorted = [...registeredVarying].sort();
  const fitDimsSorted = [...expectedFitDims].sort();
  assertGate(
    JSON.stringify(registeredVaryingSorted) === JSON.stringify(fitDimsSorted),
    `varying-features set must equal FIT_DIMS, got ${JSON.stringify(registeredVaryingSorted)}`,
  );

  const reproducedVaryingSorted = [...reproduced.varyingFeatures].sort();
  assertGate(
    JSON.stringify(reproducedVaryingSorted) === JSON.stringify(registeredVaryingSorted),
    `live-scratch varying-features must equal the registered set ${JSON.stringify(registeredVaryingSorted)}, got ${JSON.stringify(reproducedVaryingSorted)}`,
  );
}

function crossCheckRecency(split, registered, budget) {
  const registeredTrainRecency = requireMeanCell(
    registered?.evaluate?.summary?.train?.recency?.[budget],
    '(b) registered summary missing train.recency cell',
  );
  const cachedRowsById = cacheTrainRows(split.train);
  const recencyWeights = toWeights(recencyVector());
  const recencyCrossCheck = computeTrainObjective(recencyWeights, cachedRowsById, split.train, budget);
  const registeredTrainRecency4dp = registeredTrainRecency.meanRetention.toFixed(4);
  assertGate(
    recencyCrossCheck !== null && Math.abs(recencyCrossCheck - registeredTrainRecency.meanRetention) < 5e-5,
    `recency cross-check: fitter's own objective must reproduce train recency ${registeredTrainRecency4dp}, got ${recencyCrossCheck?.toFixed(4)}`,
  );
  return { cachedRowsById, recencyCrossCheck };
}

/**
 * Split integrity + baseline reproduction + variance liveness + recency
 * cross-check (plan test 8). Any failure throws with the assertion named —
 * the CLI turns that into a nonzero exit. No fit runs on a failed gate.
 *
 * Accepts pre-parsed `splitRegistered`/`registeredResults` (tests only) so
 * a tampered scratch root can be gated without writing throwaway files —
 * default reads the committed files. `expectedFitDims` (tests only) lets a
 * toy fixture whose reproduced varying set differs from production's
 * FIT_DIMS still exercise the mechanism (registered==expected AND
 * reproduced==registered) without weakening the check on the real path,
 * which always uses the FIT_DIMS default.
 */
export function runIntegrityGate({
  splitRegistered,
  registeredResults,
  expectedFitDims = FIT_DIMS,
  needTrainRows = true,
} = {}) {
  const split = splitRegistered ?? readJson(SPLIT_REGISTERED_PATH);
  const registered = registeredResults ?? readJson(RESULTS_LATEST_PATH);
  const budget = CONFIG.PRIMARY_BUDGET;

  assertSplitIntegrity(split, registered);
  assertScratchExists(split);
  const reproduced = reproduceAndAssertBaselines(split, registered, budget);
  assertVarianceLiveness(reproduced, registered, expectedFitDims);
  const { cachedRowsById, recencyCrossCheck } = crossCheckRecency(split, registered, budget);

  return {
    splitRegistered: split,
    trainIds: split.train,
    cachedRowsById: needTrainRows ? cachedRowsById : null,
    reproduced,
    recencyCrossCheck,
  };
}

/**
 * No file I/O — callers write the two frozen artifacts. Exposed separately
 * from runFit() so tests can fit against a cached fixture without touching
 * weights-learned.json.
 */
export function computeFit(trainIds, cachedRowsById, opts = {}) {
  const restarts = opts.restarts ?? RESTARTS;
  if (restarts < 1) {
    throw new Error(`[fit] FAILED computeFit: restarts must be >= 1, got ${restarts}`);
  }
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
    if (!Number.isFinite(es.bestObjective)) {
      throw new Error(
        `[fit] restart ${r} produced a non-finite train objective (${es.bestObjective}) — the objective ` +
          'function returned a degenerate value for every candidate (likely a zero-gold or malformed cache).',
      );
    }
    perRestart.push({
      restart: r,
      init,
      best: es.best,
      generations: es.generations,
      finalSigma: es.finalSigma,
      trainObjective: es.bestObjective,
      trajectory: es.trajectory,
    });
  }

  const winner = selectWinner(perRestart);
  const norm = l2norm(winner.best);
  if (norm < 1e-9) {
    throw new Error(
      `[fit] winning vector has near-zero L2 norm (${norm}) — restart ${winner.restart} converged to (near-)zero ` +
        'and cannot be normalized.',
    );
  }
  const normalized = winner.best.map((x) => x / norm);
  const weights = toWeights(normalized);

  const meta = {
    globalSeed: CONFIG.GLOBAL_SEED,
    restarts,
    esSeedNamespaces: Array.from({ length: restarts }, (_, r) => `fit|${r}`),
    reportSeedNamespace: 'report',
    seedNote:
      'GLOBAL_SEED parameterizes the E1 split/simulation substrate; the ES and bootstrap streams are ' +
      'namespaced by rngFor and do not consume GLOBAL_SEED.',
    perRestart: perRestart.map(({ restart, init, generations, finalSigma, trainObjective, trajectory }) => ({
      restart,
      init,
      generations,
      finalSigma,
      trainObjective,
      trajectory,
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
  if (resamples < 1) {
    throw new Error(`[fit-report] FAILED bootstrapCI: resamples must be >= 1, got ${resamples}`);
  }
  const n = deltas.length;
  if (n === 0) return { point: null, ci95: [null, null] };
  const point = mean(deltas);
  const means = Array(resamples);
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

/**
 * Bars-met logic (gate-hardening fix round), pulled out to a pure function
 * so it is unit-testable without file I/O. A null CI bound only ever comes
 * from an empty paired-delta set (bootstrapCI's own contract: `n === 0` =>
 * `ci95: [null, null]`); a non-finite (NaN/Infinity) bound is the same class
 * of degenerate result under a different symptom (e.g. NaN contamination
 * upstream) — both must never silently produce a barsMet=false report, they
 * must throw and refuse to write one at all.
 */
export function computeBarsMet(heldout, ciVsRecency, ciVsUniform) {
  const isBadBound = (b) => b === null || !Number.isFinite(b);
  const ciBoundsAreBad =
    isBadBound(ciVsRecency.ci95[0]) ||
    isBadBound(ciVsRecency.ci95[1]) ||
    isBadBound(ciVsUniform.ci95[0]) ||
    isBadBound(ciVsUniform.ci95[1]);
  if (ciBoundsAreBad) {
    throw new Error(
      '[fit-report] FAILED data integrity: a bootstrap CI bound is null or non-finite (empty paired-delta set, ' +
        'or NaN/Infinity contamination) — refusing to write a barsMet report from degenerate pairing.',
    );
  }
  return (
    heldout.weighted > heldout.recency &&
    heldout.weighted > heldout.uniform &&
    ciVsRecency.ci95[0] > 0 &&
    ciVsUniform.ci95[0] > 0
  );
}

function runFit() {
  if (fs.existsSync(WEIGHTS_PATH) && !boolFlag('force')) {
    throw new Error(
      `[fit] refusing to overwrite existing ${WEIGHTS_PATH} — weights are already frozen. Pass --force to ` +
        're-fit and overwrite (this also overwrites weights-learned.meta.json).',
    );
  }

  console.log('[fit] running integrity gate...');
  const { trainIds, cachedRowsById, recencyCrossCheck } = runIntegrityGate();
  console.log(`[fit] integrity gate passed; ${trainIds.length} train rows cached`);

  const { weights, meta, perRestart, winner } = computeFit(trainIds, cachedRowsById);
  for (const r of perRestart) {
    console.log(
      `[fit] restart ${r.restart}: trainObjective=${r.trainObjective.toFixed(4)} generations=${r.generations} finalSigma=${r.finalSigma.toFixed(4)}`,
    );
  }

  if (winner.trainObjective < recencyCrossCheck) {
    throw new Error(
      `restart-0 invariant violated: winner trainObjective ${winner.trainObjective} < recency cross-check ${recencyCrossCheck}`,
    );
  }

  writeJson(WEIGHTS_PATH, weights);
  meta.weightsFileSha256 = sha256Hex(fs.readFileSync(WEIGHTS_PATH));
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

/**
 * Freeze binding (codex round-2 P2): the report must be bound to the EXACT
 * frozen weights file, not just the config it was frozen under — an edited
 * or cherry-picked weights-learned.json (including one with dims the meta
 * claims are pinned to zero) must be refused. Pure; throws named errors.
 */
export function verifyFrozenWeights(weights, weightsFileSha256, meta, fitDims = FIT_DIMS) {
  for (const [key, value] of Object.entries(weights)) {
    if (!fitDims.includes(key)) {
      throw new Error(`[fit-report] FAILED freeze binding: weights file carries unknown dim "${key}"`);
    }
    if (!Number.isFinite(value)) {
      throw new Error(`[fit-report] FAILED freeze binding: weights dim "${key}" is not a finite number (${value})`);
    }
  }
  if (!meta.weightsFileSha256) {
    throw new Error(
      '[fit-report] FAILED freeze binding: weights-learned.meta.json has no weightsFileSha256 — ' +
        'refreeze with the current fitter (node fit.mjs --force)',
    );
  }
  if (meta.weightsFileSha256 !== weightsFileSha256) {
    throw new Error(
      `[fit-report] FAILED freeze binding: weights-learned.json digest (${weightsFileSha256}) does not match ` +
        `the frozen digest in the meta sidecar (${meta.weightsFileSha256}) — the weights file changed after freeze`,
    );
  }
}

function runReport() {
  const { splitRegistered } = runIntegrityGate({ needTrainRows: false });

  const weightsExists = fs.existsSync(WEIGHTS_PATH);
  const metaExists = fs.existsSync(META_PATH);
  if (weightsExists !== metaExists) {
    throw new Error(
      `[fit-report] FAILED freeze provenance: half-frozen state — ${weightsExists ? WEIGHTS_PATH : META_PATH} ` +
        `exists but ${weightsExists ? META_PATH : WEIGHTS_PATH} does not. --force refreezes both files together ` +
        '(node fit.mjs --force).',
    );
  }

  const weights = readJson(WEIGHTS_PATH);
  const meta = readJson(META_PATH);
  const currentConfigHash = sha256Hex(JSON.stringify(CONFIG));
  if (meta.configHash !== currentConfigHash) {
    throw new Error(
      `[fit-report] FAILED freeze provenance: weights-learned.meta.json configHash (${meta.configHash}) does ` +
        `not match the current CONFIG hash (${currentConfigHash}) — the weights were frozen against a ` +
        'different config.mjs; refusing to report against a stale freeze.',
    );
  }
  verifyFrozenWeights(weights, sha256Hex(fs.readFileSync(WEIGHTS_PATH)), meta);

  const budget = CONFIG.PRIMARY_BUDGET;
  const questionSplits = splitRegistered.heldout.map((questionId) => ({ questionId, split: 'heldout' }));
  const evalResult = evaluateAll(questionSplits, { weights, budgets: [budget], primaryBudget: budget });

  const heldoutPaired = evalResult.pairedRecords.filter((r) => r.split === 'heldout');
  const weightedMap = buildRetentionMap(heldoutPaired, 'weighted');
  const recencyMap = buildRetentionMap(heldoutPaired, 'recency');
  const uniformMap = buildRetentionMap(heldoutPaired, 'uniform');

  const rng = rngFor('report');
  const ciVsRecency = bootstrapCI(pairedDeltas(weightedMap, recencyMap), CONFIG.E2_BOOTSTRAP_RESAMPLES, rng);
  const ciVsUniform = bootstrapCI(pairedDeltas(weightedMap, uniformMap), CONFIG.E2_BOOTSTRAP_RESAMPLES, rng);

  const s = evalResult.summary.heldout;
  const heldout = {
    weighted: s.weighted[budget].meanRetention,
    recency: s.recency[budget].meanRetention,
    uniform: s.uniform[budget].meanRetention,
  };
  const barsMet = computeBarsMet(heldout, ciVsRecency, ciVsUniform);

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
  writeJson(REPORT_REGISTERED_PATH, report);
  console.log(`[fit] wrote ${REPORT_REGISTERED_PATH}`);
}

function printUsage() {
  console.log(
    [
      'Usage: fit.mjs [--force] [--dry-run-timing | --report | --help]',
      '  (default)          integrity gate -> 5-restart ES fit -> weights-learned.json + .meta.json',
      '                     refuses to overwrite an existing weights-learned.json unless --force is passed',
      '  --force            allow the default fit to overwrite an existing weights-learned.json',
      '  --dry-run-timing   gate, then measure ~20 candidates, project total, exit without fitting',
      '  --report           post-freeze: evaluate weights-learned.json on heldout, paired bootstrap CIs',
      '  --help             print this message and exit',
    ].join('\n'),
  );
}

function boolFlag(name) {
  return process.argv.includes(`--${name}`);
}

const KNOWN_FLAGS = ['help', 'dry-run-timing', 'report', 'force'];

function checkKnownFlags(argv) {
  for (const arg of argv) {
    if (arg.startsWith('--') && !KNOWN_FLAGS.includes(arg.slice(2))) {
      console.error(`[fit] FAILED: unknown flag ${arg}`);
      printUsage();
      process.exit(1);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  checkKnownFlags(process.argv.slice(2));
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
