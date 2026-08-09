#!/usr/bin/env node
/**
 * LC2-E1 — scorers, normalization, keep-selection, retention.
 *
 * Normalization: min-max PER STORE (robust to cross-store scale drift,
 * pre-reg). A feature constant within a store (min === max) normalizes to 0
 * for every row in that store, never 0/0.
 *
 * Scorers:
 *   - uniform: equal weights (1/K) over the oriented, normalized K-dim vector.
 *   - single-factor (both signs): score = +-norm(f) for each feature f,
 *     independent of the declared orientation map, so orientation choices
 *     can never hide a better-inverted factor.
 *   - recency: score = -norm(age_days) (the declared-orientation reading).
 *   - weighted (opt-in via --weights <file>, the E2 fitter hook): score =
 *     sum(weight[f] * norm(f)) using literal weights (the weights already
 *     encode sign/orientation; no additional orientation multiply).
 *
 * Keep set: top ceil(budget * N) under (score DESC, sessionIndex ASC,
 * turnIdx ASC, memory_id ASC as final fallback), a stable total order
 * applied identically to every scorer. sessionIndex/turnIdx come BEFORE
 * memory_id (codex review fix round, 2026-08-09 P1 fix): memory_id is
 * crypto.randomUUID(), fresh on every ingest, so a memory_id-primary
 * tie-break made the keep-budget cutoff (and therefore retention, for any
 * tie-heavy scorer — most single-factor scorers over a dead/near-constant
 * feature) non-reproducible ACROSS re-ingests of the identical dataset+seed,
 * even though it was internally consistent within one ingest.
 * (sessionIndex, turnIdx) is dataset-fixed and never changes across
 * re-ingests; memory_id remains only as the final fallback for the
 * vanishingly-rare case of two DIFFERENT logical turns tying on score AND
 * provenance (impossible for real per-turn provenance, kept for totality).
 * Cutoff-boundary score pairs (last-kept vs first-dropped, full float
 * precision) are recorded so a tie-heavy scorer is visible in the results
 * JSON rather than silently resolved by the tie-break (measure-ties
 * discipline).
 *
 * Retention(q) = |gold ∩ kept| / |gold|; questions with 0 gold are SKIPPED
 * from the mean but still counted (goldCount: 0 rows are not an error).
 *
 * Variance-aware reporting (code-review-critic fix round, 2026-08-09): a
 * feature that is structurally constant DATASET-WIDE (not just per-store) is
 * provably inert for the uniform/weighted scorers (min-max normalizes it to
 * 0 in every store) and its single-factor score is a pure tie-break, not a
 * real ranking signal. `evaluateAll` computes dataset-wide variance per
 * feature across every processed question BEFORE scoring, reports
 * `varyingFeatures`/`deadFeatures` explicitly, restricts `bestSingleFactor`
 * to varying-feature scorers only, and tags every single-factor summary cell
 * for a dead feature with `degenerate: true` so it is never silently mixed
 * into a "best single factor beats uniform" claim.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, orientationOf } from './config.mjs';
import { readJson, readJsonl, featuresPathFor, RESULTS_DIR, writeJson } from './common.mjs';

// ---------------------------------------------------------------------------
// Scorers
// ---------------------------------------------------------------------------

/** @returns {Array<{name: string, score: (normedFeatures: Record<string, number>) => number}>} */
export function buildScorers(featureNames, weights) {
  const scorers = [];

  scorers.push({
    name: 'uniform',
    score: (nf) => {
      let sum = 0;
      for (const f of featureNames) sum += orientationOf(f) * nf[f];
      return sum / featureNames.length;
    },
  });

  for (const f of featureNames) {
    scorers.push({ name: `${f}__pos`, score: (nf) => nf[f] });
    scorers.push({ name: `${f}__neg`, score: (nf) => -nf[f] });
  }

  scorers.push({ name: 'recency', score: (nf) => -nf['age_days'] });

  if (weights) {
    for (const key of Object.keys(weights)) {
      if (!featureNames.includes(key)) {
        throw new Error(`buildScorers: --weights file has unknown feature "${key}"`);
      }
    }
    scorers.push({
      name: 'weighted',
      score: (nf) => {
        let sum = 0;
        for (const f of featureNames) sum += (weights[f] ?? 0) * nf[f];
        return sum;
      },
    });
  }

  return scorers;
}

// ---------------------------------------------------------------------------
// Dataset-wide variance (across every processed question, RAW feature
// values — pre-normalization, since per-store min-max would hide a feature
// that varies store-to-store but happens to be point-constant within one
// store). variance = 0 iff min === max for finite numeric features, so the
// boolean gate uses the exact min/max comparison; the numeric variance is
// reported alongside for diagnostics.
// ---------------------------------------------------------------------------

/**
 * @param {Array<{features: Record<string, number>}>} rows  raw feature rows,
 *   pooled across every question/store processed this run.
 * @param {string[]} featureNames
 * @returns {{ varying: string[], dead: string[], detail: Record<string, {min:number|null,max:number|null,mean:number,variance:number,varies:boolean}> }}
 */
export function computeDatasetVariance(rows, featureNames) {
  const stats = {};
  for (const f of featureNames) stats[f] = { min: Infinity, max: -Infinity, count: 0, sum: 0, sumSq: 0 };
  for (const row of rows) {
    for (const f of featureNames) {
      const v = row.features[f];
      const s = stats[f];
      if (v < s.min) s.min = v;
      if (v > s.max) s.max = v;
      s.count++;
      s.sum += v;
      s.sumSq += v * v;
    }
  }
  const varying = [];
  const dead = [];
  const detail = {};
  for (const f of featureNames) {
    const s = stats[f];
    const has = s.count > 0;
    const mean = has ? s.sum / s.count : 0;
    const variance = has ? Math.max(0, s.sumSq / s.count - mean * mean) : 0;
    const varies = has && s.max > s.min;
    detail[f] = { min: has ? s.min : null, max: has ? s.max : null, mean, variance, varies };
    (varies ? varying : dead).push(f);
  }
  return { varying, dead, detail };
}

/**
 * Pure gate logic (no I/O): fewer than `minVarying` dataset-wide-varying
 * features means the run is degenerate and should fail loudly rather than
 * silently produce a uniform/best-single-factor comparison over dead dims.
 * @param {string[]} varying
 * @param {string[]} dead
 * @param {{ minVarying?: number }} [opts]
 */
export function evaluateVarianceGate(varying, dead, opts = {}) {
  const minVarying = opts.minVarying ?? 6;
  return {
    passed: varying.length >= minVarying,
    minVarying,
    varyingCount: varying.length,
    varyingFeatures: varying,
    deadFeatures: dead,
  };
}

// ---------------------------------------------------------------------------
// Per-store evaluation
// ---------------------------------------------------------------------------

/**
 * @param {Array<{memory_id: string, sessionIndex: number, turnIdx: number, gold: 0|1, features: Record<string, number>}>} rows
 * @param {number[]} budgets
 * @param {Record<string, number>} [weights]
 * @returns {{ N: number, goldCount: number, perScorer: Record<string, Record<number, object>> }}
 */
export function evaluateStore(rows, budgets, weights) {
  const featureNames = CONFIG.FEATURES;
  const N = rows.length;

  const minMax = {};
  for (const f of featureNames) {
    let min = Infinity;
    let max = -Infinity;
    for (const r of rows) {
      const v = r.features[f];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    minMax[f] = { min, max };
  }
  const norm = (f, v) => {
    const { min, max } = minMax[f];
    return max === min ? 0 : (v - min) / (max - min);
  };
  const normed = rows.map((r) => {
    const nf = {};
    for (const f of featureNames) nf[f] = norm(f, r.features[f]);
    return nf;
  });

  const goldSet = new Set(rows.filter((r) => r.gold === 1).map((r) => r.memory_id));
  const goldCount = goldSet.size;

  const scorers = buildScorers(featureNames, weights);
  const perScorer = {};
  for (const scorer of scorers) {
    const scored = rows.map((r, i) => ({
      memory_id: r.memory_id,
      sessionIndex: r.sessionIndex,
      turnIdx: r.turnIdx,
      gold: r.gold === 1,
      score: scorer.score(normed[i]),
    }));
    // (score DESC, sessionIndex ASC, turnIdx ASC, memory_id ASC) — see header
    // comment for why memory_id is the LAST fallback, not the primary tie-break.
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.sessionIndex !== b.sessionIndex) return a.sessionIndex - b.sessionIndex;
      if (a.turnIdx !== b.turnIdx) return a.turnIdx - b.turnIdx;
      return a.memory_id.localeCompare(b.memory_id);
    });

    const perBudget = {};
    for (const budget of budgets) {
      const keepN = Math.min(N, Math.ceil(budget * N));
      const kept = scored.slice(0, keepN);
      const keptGold = kept.reduce((acc, x) => acc + (x.gold ? 1 : 0), 0);
      const retention = goldCount > 0 ? keptGold / goldCount : null;
      perBudget[budget] = {
        retention,
        goldCount,
        keptGold,
        N,
        keepN,
        cutoffBoundary: {
          lastKeptScore: keepN > 0 ? scored[keepN - 1].score : null,
          firstDroppedScore: keepN < N ? scored[keepN].score : null,
        },
      };
    }
    perScorer[scorer.name] = perBudget;
  }

  return { N, goldCount, perScorer };
}

// ---------------------------------------------------------------------------
// Multi-question orchestration
// ---------------------------------------------------------------------------

/**
 * @param {Array<{questionId: string, split: 'train'|'heldout'}>} questionSplits
 * @param {{ budgets?: number[], primaryBudget?: number, weights?: Record<string,number> }} [opts]
 */
export function evaluateAll(questionSplits, opts = {}) {
  const primaryBudget = opts.primaryBudget ?? CONFIG.PRIMARY_BUDGET;
  const budgetsIn = opts.budgets ?? CONFIG.KEEP_BUDGETS;
  // pairedRecords is keyed off primaryBudget; guarantee it's always evaluated
  // even if a caller passes a custom --budget list that omits it.
  const budgets = budgetsIn.includes(primaryBudget) ? budgetsIn : [...budgetsIn, primaryBudget].sort((a, b) => a - b);
  const weights = opts.weights;

  const featureNames = CONFIG.FEATURES;
  let scorerNames = null;
  const perQuestion = [];
  const aggregate = {}; // split -> scorer -> budget -> { sum, count, skipped }
  // Per-question paired records: PRIMARY_BUDGET only, every scorer (bootstrap
  // input; other budgets stay aggregate-only per the pre-reg's descriptive-
  // only framing for 0.1/0.2/0.5). Built from the SAME evaluateStore() call
  // as the aggregate below — one pass per question, not two.
  const pairedRecords = [];
  // Pooled RAW rows across every processed question, for the dataset-wide
  // variance gate (see computeDatasetVariance doc comment: must be computed
  // on raw values, not per-store normalized ones).
  const allRawRows = [];

  for (const { questionId, split } of questionSplits) {
    const rows = readJsonl(featuresPathFor(questionId));
    allRawRows.push(...rows);
    const result = evaluateStore(rows, budgets, weights);
    if (scorerNames === null) scorerNames = Object.keys(result.perScorer);

    perQuestion.push({
      questionId,
      split,
      N: result.N,
      goldCount: result.goldCount,
    });

    for (const scorerName of scorerNames) {
      aggregate[split] ??= {};
      aggregate[split][scorerName] ??= {};
      for (const budget of budgets) {
        const cell = result.perScorer[scorerName][budget];
        aggregate[split][scorerName][budget] ??= { sum: 0, count: 0, skippedZeroGold: 0 };
        const bucket = aggregate[split][scorerName][budget];
        if (cell.retention === null) bucket.skippedZeroGold++;
        else {
          bucket.sum += cell.retention;
          bucket.count++;
        }
        if (budget === primaryBudget) {
          pairedRecords.push({
            questionId,
            split,
            scorer: scorerName,
            budget,
            retention: cell.retention,
            goldCount: cell.goldCount,
            keptGold: cell.keptGold,
            N: cell.N,
            keepN: cell.keepN,
            cutoffBoundary: cell.cutoffBoundary,
          });
        }
      }
    }
  }

  // Dataset-wide variance (raw, pre-normalization) — determines which
  // single-factor scorers are "degenerate: tie-break-only" (dead feature,
  // min-max normalizes to 0 everywhere) vs real ranking signal.
  const { varying: varyingFeatures, dead: deadFeatures, detail: featureVarianceDetail } =
    computeDatasetVariance(allRawRows, featureNames);
  const varianceGate = evaluateVarianceGate(varyingFeatures, deadFeatures);
  const deadFeatureSet = new Set(deadFeatures);
  // Single-factor scorer name -> its underlying feature, so degenerate
  // marking and bestSingleFactor filtering share one source of truth.
  const singleFactorFeatureOf = {};
  for (const f of featureNames) {
    singleFactorFeatureOf[`${f}__pos`] = f;
    singleFactorFeatureOf[`${f}__neg`] = f;
  }

  const summary = {};
  for (const split of Object.keys(aggregate)) {
    summary[split] = {};
    for (const scorerName of scorerNames) {
      summary[split][scorerName] = {};
      const underlyingFeature = singleFactorFeatureOf[scorerName];
      const degenerate = underlyingFeature !== undefined && deadFeatureSet.has(underlyingFeature);
      for (const budget of budgets) {
        const b = aggregate[split][scorerName][budget];
        summary[split][scorerName][budget] = {
          meanRetention: b.count > 0 ? b.sum / b.count : null,
          questionsIncluded: b.count,
          questionsSkippedZeroGold: b.skippedZeroGold,
          degenerate,
          ...(degenerate ? { degenerateReason: 'tie-break-only' } : {}),
        };
      }
    }
  }

  // bestSingleFactor: the best single-factor scorer per (split, budget),
  // restricted to VARYING-feature scorers only — a dead-dim single-factor
  // "win" (a min-max-normalized-to-0 tie broken purely by memory_id) must
  // never be reported as if it were a real ranking signal.
  const bestSingleFactor = {};
  for (const split of Object.keys(summary)) {
    bestSingleFactor[split] = {};
    for (const budget of budgets) {
      let best = null;
      for (const scorerName of scorerNames) {
        const underlyingFeature = singleFactorFeatureOf[scorerName];
        if (underlyingFeature === undefined) continue; // uniform/recency/weighted are not single-factor
        if (deadFeatureSet.has(underlyingFeature)) continue; // never mix a degenerate scorer into "best"
        const cell = summary[split][scorerName][budget];
        if (cell.meanRetention === null) continue;
        if (best === null || cell.meanRetention > best.meanRetention) {
          best = { scorer: scorerName, meanRetention: cell.meanRetention, questionsIncluded: cell.questionsIncluded };
        }
      }
      bestSingleFactor[split][budget] = best; // null if every varying-feature scorer had 0 eligible questions
    }
  }

  return {
    budgets,
    primaryBudget,
    scorers: scorerNames,
    summary, // split -> scorer -> budget -> { meanRetention, questionsIncluded, questionsSkippedZeroGold, degenerate, degenerateReason? }
    bestSingleFactor, // split -> budget -> { scorer, meanRetention, questionsIncluded } | null, VARYING features only
    varyingFeatures, // dataset-wide (raw, pre-normalization) non-constant feature names
    deadFeatures, // dataset-wide constant feature names (provably inert for uniform/weighted; single-factor rows marked degenerate)
    featureVarianceDetail, // feature -> { min, max, mean, variance, varies }
    varianceGate, // { passed, minVarying, varyingCount, varyingFeatures, deadFeatures }
    perQuestion, // split/N/goldCount per question (bookkeeping)
    pairedRecords, // primaryBudget only, every scorer, every question (bootstrap input)
  };
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------
function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const splitPath = flag('split', path.join(RESULTS_DIR, 'split.json'));
  const weightsPath = flag('weights');
  const out = flag('out', path.join(RESULTS_DIR, 'evaluate-standalone.json'));

  const split = readJson(splitPath);
  const questionSplits = [
    ...split.train.map((questionId) => ({ questionId, split: 'train' })),
    ...split.heldout.map((questionId) => ({ questionId, split: 'heldout' })),
  ];
  const weights = weightsPath ? readJson(weightsPath) : undefined;

  const t0 = Date.now();
  const result = evaluateAll(questionSplits, { weights });
  writeJson(out, result);
  console.log(`[evaluate] ${questionSplits.length} questions in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${out}`);
}
