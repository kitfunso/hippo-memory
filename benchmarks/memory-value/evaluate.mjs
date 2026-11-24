#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, orientationOf } from './config.mjs';
import { readJson, readJsonl, featuresPathFor, RESULTS_DIR, writeJson } from './common.mjs';

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

/**
 * @param {Array<Array<{features: Record<string, number>}>>} storesRows  one
 *   raw-feature-row array PER STORE (question) processed this run — the
 *   store boundary is the unit variance is measured within.
 * @param {string[]} featureNames
 * @returns {{ varying: string[], dead: string[], detail: Record<string, {min:number|null,max:number|null,mean:number,variance:number,pooledVaries:boolean,varies:boolean}> }}
 */
export function computeDatasetVariance(storesRows, featureNames) {
  const pooled = {};
  const livesWithinStore = {};
  for (const f of featureNames) {
    pooled[f] = { min: Infinity, max: -Infinity, count: 0, sum: 0, sumSq: 0 };
    livesWithinStore[f] = false;
  }

  for (const rows of storesRows) {
    const storeMinMax = {};
    for (const f of featureNames) storeMinMax[f] = { min: Infinity, max: -Infinity };
    for (const row of rows) {
      for (const f of featureNames) {
        const v = row.features[f];
        const p = pooled[f];
        if (v < p.min) p.min = v;
        if (v > p.max) p.max = v;
        p.count++;
        p.sum += v;
        p.sumSq += v * v;
        const s = storeMinMax[f];
        if (v < s.min) s.min = v;
        if (v > s.max) s.max = v;
      }
    }
    for (const f of featureNames) {
      const s = storeMinMax[f];
      if (s.max > s.min) livesWithinStore[f] = true;
    }
  }

  const varying = [];
  const dead = [];
  const detail = {};
  for (const f of featureNames) {
    const p = pooled[f];
    const has = p.count > 0;
    const mean = has ? p.sum / p.count : 0;
    const variance = has ? Math.max(0, p.sumSq / p.count - mean * mean) : 0;
    const pooledVaries = has && p.max > p.min;
    const varies = livesWithinStore[f];
    detail[f] = { min: has ? p.min : null, max: has ? p.max : null, mean, variance, pooledVaries, varies };
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
  const minVarying = opts.minVarying ?? CONFIG.MIN_VARYING_FEATURES;
  return {
    passed: varying.length >= minVarying,
    minVarying,
    varyingCount: varying.length,
    varyingFeatures: varying,
    deadFeatures: dead,
  };
}

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

/**
 * @param {Array<{questionId: string, split: 'train'|'heldout'}>} questionSplits
 * @param {{ budgets?: number[], primaryBudget?: number, weights?: Record<string,number>, minVarying?: number }} [opts]
 */
export function evaluateAll(questionSplits, opts = {}) {
  const primaryBudget = opts.primaryBudget ?? CONFIG.PRIMARY_BUDGET;
  const budgetsIn = opts.budgets ?? CONFIG.KEEP_BUDGETS;
  const budgets = budgetsIn.includes(primaryBudget) ? budgetsIn : [...budgetsIn, primaryBudget].sort((a, b) => a - b);
  const weights = opts.weights;

  const featureNames = CONFIG.FEATURES;
  let scorerNames = null;
  const perQuestion = [];
  const aggregate = {};
  const pairedRecords = [];
  const rawRowsByStore = [];

  for (const { questionId, split } of questionSplits) {
    const rows = readJsonl(featuresPathFor(questionId));
    rawRowsByStore.push(rows);
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

  const { varying: varyingFeatures, dead: deadFeatures, detail: featureVarianceDetail } =
    computeDatasetVariance(rawRowsByStore, featureNames);
  const varianceGate = evaluateVarianceGate(varyingFeatures, deadFeatures, { minVarying: opts.minVarying });
  const deadFeatureSet = new Set(deadFeatures);
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
        };
        if (degenerate) {
          summary[split][scorerName][budget].degenerateReason = 'tie-break-only';
        }
      }
    }
  }

  const bestSingleFactor = {};
  for (const split of Object.keys(summary)) {
    bestSingleFactor[split] = {};
    for (const budget of budgets) {
      let best = null;
      for (const scorerName of scorerNames) {
        const underlyingFeature = singleFactorFeatureOf[scorerName];
        if (underlyingFeature === undefined) continue;
        if (deadFeatureSet.has(underlyingFeature)) continue;
        const cell = summary[split][scorerName][budget];
        if (cell.meanRetention === null) continue;
        if (best === null || cell.meanRetention > best.meanRetention) {
          best = { scorer: scorerName, meanRetention: cell.meanRetention, questionsIncluded: cell.questionsIncluded };
        }
      }
      bestSingleFactor[split][budget] = best;
    }
  }

  return {
    budgets,
    primaryBudget,
    scorers: scorerNames,
    summary,
    bestSingleFactor,
    varyingFeatures,
    deadFeatures,
    featureVarianceDetail,
    varianceGate,
    perQuestion,
    pairedRecords,
  };
}

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
