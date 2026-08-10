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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.mjs';
import { evaluateStore, evaluateAll } from './evaluate.mjs';
import { readJson, writeJson, readJsonl, featuresPathFor, rngFor, RESULTS_DIR, scratchRootDir } from './common.mjs';

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
// Committed registration copy (fix-round: mirrors E1's results-latest.json
// convention — the mutable results/ path is the run output, this one is the
// git-diffable record of the last registered report).
const REPORT_REGISTERED_PATH = path.join(HERE, 'fit-report-registered.json');

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
  const v = new Array(dims.length).fill(0);
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

/** Asserts `value` is present (not null/undefined) before any caller does a
 *  `.property`/`.toFixed()` access on it — every place this wraps a deep
 *  `registered`/`reproduced` dereference turns a would-be raw TypeError
 *  (malformed/tampered JSON) into a named assertGate failure instead
 *  (gate-hardening fix round). Returns `value` so call sites can inline it. */
function requireCell(value, message) {
  assertGate(value !== undefined && value !== null, message);
  return value;
}

/** Like `requireCell`, additionally requiring the summary-cell shape
 *  (`{meanRetention, questionsIncluded}`) that every `.toFixed(4)` /
 *  inclusion-integrity comparison below depends on — a cell object present
 *  but missing/non-numeric `meanRetention` would otherwise throw a raw
 *  TypeError at the `.toFixed()` call site rather than a named failure. */
function requireMeanCell(value, message) {
  assertGate(
    value !== undefined &&
      value !== null &&
      typeof value.meanRetention === 'number' &&
      typeof value.questionsIncluded === 'number',
    message,
  );
  return value;
}

/** (0) scratch existence pre-check (fix round): a wiped or never-populated
 *  scratch root turns every subsequent read (evaluateAll, cacheTrainRows)
 *  into a raw, unnamed ENOENT thrown from deep inside those calls. Checking
 *  every split id up front (fs.existsSync loop; milliseconds) turns that
 *  into one named, actionable failure before any real work starts. */
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

/** (a) split integrity: split-registered's train/heldout id arrays must be
 *  duplicate-free, disjoint, and their lengths must equal results-latest's
 *  split block. Targets come from `registered` itself (the committed file),
 *  not a duplicate hardcoded literal — a second copy of the same fact is a
 *  second place it can drift out of sync. */
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

/** `summary?.[splitName]?.[scorerName]?.[budget]`, guarded via requireMeanCell. */
function getMeanCell(summary, splitName, scorerName, budget, label) {
  return requireMeanCell(summary?.[splitName]?.[scorerName]?.[budget], label);
}

/** (b) inclusion integrity — `reproducedCell.questionsIncluded` must match
 *  the registered file's own recorded post-zero-gold count. `assertionTag`
 *  is 'b' for the original two checks, 'c' for the NEW train-uniform check
 *  (the fix that added it framed both its halves as part of extending (c)). */
function assertInclusionMatches(reproducedCell, registeredCell, label, assertionTag) {
  assertGate(
    reproducedCell.questionsIncluded === registeredCell.questionsIncluded,
    `(${assertionTag}) ${label} questionsIncluded must be ${registeredCell.questionsIncluded}, got ${reproducedCell.questionsIncluded}`,
  );
}

/** (c) baseline reproduction at 4dp against the committed results-latest.json.
 *  Compared as a numeric epsilon, not a toFixed(4) string, because float
 *  summation order differs between E1's run and the gate's reproduction
 *  (same math, different accumulation order) — string-rounding equality is
 *  boundary-fragile (0.12345 vs 0.123449999... can round to different 4dp
 *  strings). 5e-5 is the exact half-ULP-at-4dp tolerance, so the prereg
 *  intent (4-decimal-place reproduction) is unchanged; only the comparison
 *  mechanism is. Failure MESSAGES still print the 4dp-formatted numbers. */
function assertReproducesBaseline(reproducedCell, registeredCell, label) {
  assertGate(
    Math.abs(reproducedCell.meanRetention - registeredCell.meanRetention) < 5e-5,
    `(c) ${label} must reproduce ${registeredCell.meanRetention.toFixed(4)}, got ${reproducedCell.meanRetention.toFixed(4)}`,
  );
}

/**
 * Reproduces the no-weights (baseline scorers only) summary over the
 * COMMITTED split and checks it against `registered` (results-latest.json):
 * (b) inclusion integrity and (c) baseline reproduction at 4dp. The
 * train-uniform check is the all-features-sensitive baseline (fix round
 * addition): recency alone only exercises age_days, so a corruption in any
 * OTHER train feature is invisible to it — uniform sums all 30 features and
 * so surfaces non-age corruption that recency-only reproduction would miss.
 * (A committed per-question feature hash would be the airtight fix; this is
 * the practical stand-in until that lands.) Returns the reproduced
 * evaluateAll() result for the variance check.
 */
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
  // All-features-sensitive baseline (see function doc comment above).
  assertReproducesBaseline(trainUniform, registeredTrainUniform, 'train uniform');
  assertInclusionMatches(trainUniform, registeredTrainUniform, 'train uniform', 'c');

  return reproduced;
}

/**
 * Varying-features set (registered, committed) must equal `expectedFitDims`
 * exactly (production default: FIT_DIMS). NEW (gate-hardening fix round):
 * the live-scratch reproduced varying set must ALSO equal the registered
 * set — a scratch that has drifted (a feature gone dead, or a new one now
 * varying, since results-latest.json was registered) is caught here even if
 * assertions (b)/(c) above happen not to move at 4dp.
 */
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

/**
 * Row cache (caching contract, plan decision 1) + recency cross-check (plan
 * test 8): the fitter's OWN mean/skip-rule arithmetic, run on the pure
 * recency vector, must reproduce the registered train recency. Any drift
 * here means the objective's mean or skip rule disagrees with evaluateAll's.
 * Returns the row cache (for the caller to reuse across ES candidates) and
 * the cross-check value itself (runFit's non-tautological restart-0 bar).
 */
function crossCheckRecency(split, registered, budget) {
  const registeredTrainRecency = requireMeanCell(
    registered?.evaluate?.summary?.train?.recency?.[budget],
    '(b) registered summary missing train.recency cell',
  );
  const cachedRowsById = cacheTrainRows(split.train);
  const recencyWeights = toWeights(recencyVector());
  const recencyCrossCheck = computeTrainObjective(recencyWeights, cachedRowsById, split.train, budget);
  const registeredTrainRecency4dp = registeredTrainRecency.meanRetention.toFixed(4);
  // Epsilon compare, not toFixed(4) string equality — see assertReproducesBaseline's doc comment for why.
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
  // crossCheckRecency's own cacheTrainRows read is unavoidable here (the
  // cross-check IS a gate assertion, run unconditionally) — needTrainRows
  // only controls whether the caller gets the resulting cache back to reuse
  // (runFit needs it for thousands of ES candidate evaluations; runReport
  // never touches train rows again and would otherwise hold the cache in
  // memory for no reason). This drops the reference, it does not skip a read.
  const { cachedRowsById, recencyCrossCheck } = crossCheckRecency(split, registered, budget);

  return {
    splitRegistered: split,
    trainIds: split.train,
    cachedRowsById: needTrainRows ? cachedRowsById : null,
    reproduced,
    recencyCrossCheck,
  };
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
    // Non-finite guard (gate-hardening fix round): a restart whose winning
    // objective is NaN/Infinity means the objective function degenerated
    // (e.g. every candidate hit the zero-gold skip) — fail loudly rather
    // than silently propagate a non-finite value into selectWinner/meta.
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
  // Zero-norm guard (gate-hardening fix round): normalizing a (near-)zero
  // vector divides by (near-)zero and hands weights-learned.json NaNs —
  // fail loudly instead of freezing a broken scorer.
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
    // Seed provenance (gate-hardening fix round): documents which rngFor
    // namespaces produced this freeze. GLOBAL_SEED itself is NOT consumed
    // by the ES/bootstrap streams (see seedNote) — recorded here only so a
    // reader doesn't have to infer that from the source.
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
  if (resamples < 1) {
    throw new Error(`[fit-report] FAILED bootstrapCI: resamples must be >= 1, got ${resamples}`);
  }
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

// ---------------------------------------------------------------------------
// CLI orchestration
// ---------------------------------------------------------------------------

function runFit() {
  // Freeze enforcement (gate-hardening fix round): checked BEFORE the
  // (potentially ~60 min) gate + fit run, not after — an operator re-running
  // `fit.mjs` by mistake gets refused immediately, not after paying the full
  // cost. --force is the explicit, named override.
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

  // Restart-0 invariant, checked against the gate's OWN recency cross-check
  // rather than restart 0's own objective (the old check was tautological:
  // selectWinner can never pick a winner worse than restart 0, since restart
  // 0 IS one of the candidates it selects from). recencyCrossCheck is an
  // independent computation of the recency-vector objective on the SAME
  // cached rows, so "winner >= recencyCrossCheck" is a real invariant.
  // Non-finite objectives already throw inside computeFit (see its
  // per-restart guard).
  if (winner.trainObjective < recencyCrossCheck) {
    throw new Error(
      `restart-0 invariant violated: winner trainObjective ${winner.trainObjective} < recency cross-check ${recencyCrossCheck}`,
    );
  }

  writeJson(WEIGHTS_PATH, weights);
  // Freeze binding (codex round-2 P2): digest the weights FILE BYTES so
  // --report can refuse a weights file edited or swapped after freeze —
  // configHash alone binds only the protocol, not the model.
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
  // Gate FIRST (gate-hardening fix round): --report previously ran ungated,
  // so a stale/tampered scratch or split could produce a "bars met" report
  // that never touched verified data. The gate DOES read every train
  // features.jsonl too (baseline reproduction (b)/(c) + the recency
  // cross-check) even though --report itself only evaluates heldout below —
  // that read is a gate-integrity assertion, not something --report opted
  // into. needTrainRows:false just drops the resulting row-cache reference
  // once the gate returns (memory, not I/O — --report never uses the cache
  // again, so there is no reason to keep 300 stores' worth of rows alive).
  const { splitRegistered } = runIntegrityGate({ needTrainRows: false });

  // Freeze provenance (fix round): a half-frozen state — one of the two
  // frozen artifacts present, the other missing (e.g. an interrupted freeze,
  // or one file deleted by hand) — must be named explicitly rather than
  // surfacing as a raw ENOENT from whichever readJson() happens to run first.
  const weightsExists = fs.existsSync(WEIGHTS_PATH);
  const metaExists = fs.existsSync(META_PATH);
  if (weightsExists !== metaExists) {
    throw new Error(
      `[fit-report] FAILED freeze provenance: half-frozen state — ${weightsExists ? WEIGHTS_PATH : META_PATH} ` +
        `exists but ${weightsExists ? META_PATH : WEIGHTS_PATH} does not. --force refreezes both files together ` +
        '(node fit.mjs --force).',
    );
  }

  // Freeze provenance: refuse to report against weights frozen under a
  // DIFFERENT config.mjs than the one currently checked out — configHash is
  // written at freeze time (computeFit) precisely so this can be checked.
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

  // Reuse the gate's own parsed split (splitRegistered above) instead of a
  // second readJson(SPLIT_REGISTERED_PATH) — same file, same call graph,
  // no reason to parse it twice (fix round).
  const budget = CONFIG.PRIMARY_BUDGET;
  // Held-out ONLY for the evaluation BELOW (gate-hardening fix round): this
  // function's own evaluateAll call never touches train ids. The gate above
  // already read every train features.jsonl (baseline reproduction + recency
  // cross-check) — "never reads train" described this function, not the
  // gate it calls first.
  const questionSplits = splitRegistered.heldout.map((questionId) => ({ questionId, split: 'heldout' }));
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
  // Throws (never returns false) on a degenerate/empty paired-delta set —
  // see computeBarsMet's doc comment.
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
  // Committed registration copy (registration convention mirroring E1's
  // results-latest.json — see REPORT_REGISTERED_PATH's doc comment).
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

/** Argv whitelist (fix round): a `--flag` outside KNOWN_FLAGS is (almost
 *  always) a typo — e.g. `--reprot` — and without this check it silently
 *  falls through every `boolFlag()` check below to the default (destructive,
 *  freeze-writing) fit path. Checked BEFORE any dispatch, so a typo can
 *  never run the wrong command. */
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
