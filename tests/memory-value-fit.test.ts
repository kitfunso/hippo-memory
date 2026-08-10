/**
 * LC2-E2 memory-value fitter — deterministic mechanism tests.
 *
 * Two kinds of test here:
 *   - Pure-function tests (runES, selectWinner, bootstrapCI): synthetic
 *     objectives / toy inputs, no store fixture, hand-computable results.
 *   - Fixture tests (computeFit, runIntegrityGate): the real hand-specified
 *     2-question fixture from memory-value-fixtures.ts, run through the
 *     real pipeline (ingest -> simulate -> extract) into real SQLite
 *     scratch stores — same house rule as memory-value-harness.test.ts
 *     (no mocks). ES hyperparams are reduced (fewer restarts/generations)
 *     for these so the suite stays fast; the pinned 5/60/8 protocol lives
 *     only in fit.mjs's production defaults, not in every test.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';

// @ts-expect-error - .mjs harness modules have no type declarations
import { CONFIG } from '../benchmarks/memory-value/config.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { evaluateAll, buildScorers, evaluateStore } from '../benchmarks/memory-value/evaluate.mjs';
// @ts-expect-error - .mjs harness modules have no type declarations
import { mulberry32, featuresPathFor, readJsonl, writeJsonl } from '../benchmarks/memory-value/common.mjs';
import {
  FIT_DIMS,
  runES,
  selectWinner,
  cacheTrainRows,
  computeTrainObjective,
  computeFit,
  toWeights,
  runIntegrityGate,
  bootstrapCI,
  // @ts-expect-error - .mjs harness module has no type declarations
} from '../benchmarks/memory-value/fit.mjs';

import { clearAblationEnv, QUESTIONS, cleanupScratch, runPipeline } from './memory-value-fixtures.js';

// File-unique scratch root. Vitest runs test FILES in parallel workers, and
// memory-value-harness.test.ts uses the DEFAULT root with the same fixture
// question_ids — two files on one root cleanupScratch() each other's stores
// mid-test (full-suite failure 2026-08-10). Same isolation pattern as
// memory-value-determinism.test.ts; common.mjs reads the env fresh per call.
// Hook order matters: clearAblationEnv deletes HIPPO_MV_SCRATCH_ROOT, so the
// override is re-set in a LATER beforeEach (vitest runs same-level hooks in
// registration order).
const FIT_SCRATCH_ROOT = path.join(os.tmpdir(), 'hippo-mv-fit-test-scratch');

beforeEach(clearAblationEnv);
beforeEach(() => {
  process.env.HIPPO_MV_SCRATCH_ROOT = FIT_SCRATCH_ROOT;
});
afterEach(clearAblationEnv);
afterAll(() => {
  fs.rmSync(FIT_SCRATCH_ROOT, { recursive: true, force: true });
});

// Small ES budget for the fixture tests — proves the mechanism, not the
// pinned protocol depth (that lives in fit.mjs's own defaults).
const FAST_FIT_OPTS = { restarts: 2, maxGens: 10 };

function recencyVector(): number[] {
  return FIT_DIMS.map((f: string) => (f === 'age_days' ? -1 : 0));
}

// ---------------------------------------------------------------------------
// runES — pure mechanism tests (tests 4, 7)
// ---------------------------------------------------------------------------

describe('runES (pure, synthetic objectives)', () => {
  it('tie discipline: a flat objective (parent == every offspring) never replaces the parent', () => {
    const rng = mulberry32(123);
    const result = runES({
      objective: () => 0,
      dims: ['a', 'b'],
      rng,
      lambda: 8,
      sigma0: 0.3,
      flatGensBeforeHalve: 5,
      maxGens: 10,
      sigmaMin: 0.01,
      box: [-1, 1],
      init: [0.5, -0.5],
    });
    expect(result.best).toEqual([0.5, -0.5]);
    expect(result.bestObjective).toBe(0);
    expect(result.generations).toBe(10); // ran to maxGens; a tie is not termination
  });

  it('sigma halves after exactly 5 consecutive non-improving generations', () => {
    const rng = mulberry32(456);
    const result = runES({
      objective: () => 0, // always flat -> every generation is non-improving
      dims: ['a', 'b'],
      rng,
      lambda: 8,
      sigma0: 0.3,
      flatGensBeforeHalve: 5,
      maxGens: 6,
      sigmaMin: 0.0001, // low enough that only the halving schedule is under test
      box: [-1, 1],
      init: [0.1, 0.1],
    });
    expect(result.trajectory[4].sigma).toBe(0.3); // gens 1-4: still flat, no halving yet
    expect(result.trajectory[5].sigma).toBe(0.15); // gen 5: 5th consecutive flat gen -> halve
    expect(result.finalSigma).toBe(0.15);
  });

  it('terminates at maxGens when the objective keeps improving (sigma never halves)', () => {
    const rng = mulberry32(789);
    const result = runES({
      objective: (v: number[]) => v[0] + v[1], // strictly increasing while inside the box
      dims: ['a', 'b'],
      rng,
      lambda: 8,
      sigma0: 0.3,
      flatGensBeforeHalve: 5,
      maxGens: 8,
      sigmaMin: 0.0001,
      box: [-1, 1],
      init: [-0.9, -0.9],
    });
    expect(result.generations).toBe(8);
    expect(result.finalSigma).toBe(0.3); // no non-improving generation ever occurred
  });

  it('terminates when sigma drops below sigmaMin, before maxGens is reached', () => {
    const rng = mulberry32(101);
    const result = runES({
      objective: () => 0, // flat -> forces repeated halving
      dims: ['a', 'b'],
      rng,
      lambda: 8,
      sigma0: 0.3,
      flatGensBeforeHalve: 5,
      maxGens: 100, // generous cap; sigmaMin should stop the run first
      sigmaMin: 0.01,
      box: [-1, 1],
      init: [0.1, 0.1],
    });
    expect(result.generations).toBeLessThan(100);
    expect(result.generations).toBe(25); // 5 halvings x 5 flat gens each
    expect(result.finalSigma).toBeLessThan(0.01);
  });

  it('rejects a mutation whose L2 norm is < 1e-9 without resampling (offspring is simply skipped)', () => {
    // sigma effectively 0 -> every mutation lands within 1e-9 of the parent;
    // if the parent itself sits within 1e-9 of the origin, every offspring
    // is rejected and the objective must never be called on a degenerate
    // near-zero vector.
    let callCount = 0;
    const rng = mulberry32(202);
    const result = runES({
      objective: (v: number[]) => {
        callCount++;
        return v[0] + v[1];
      },
      dims: ['a', 'b'],
      rng,
      lambda: 8,
      sigma0: 1e-12,
      flatGensBeforeHalve: 5,
      maxGens: 2,
      sigmaMin: 1e-13,
      box: [-1, 1],
      init: [0, 0], // parent at the origin: any tiny mutation is also ~0
    });
    // The initial parent objective is always evaluated once; every offspring
    // this generation must be rejected (norm < 1e-9), so callCount stays 1.
    expect(callCount).toBe(1);
    expect(result.best).toEqual([0, 0]);
  });
});

// ---------------------------------------------------------------------------
// selectWinner — cross-restart tie-break (test 7, last clause)
// ---------------------------------------------------------------------------

describe('selectWinner', () => {
  it('breaks exact train-objective ties by ascending restart index', () => {
    const perRestart = [
      { restart: 0, trainObjective: 0.5 },
      { restart: 1, trainObjective: 0.7 },
      { restart: 2, trainObjective: 0.7 }, // tie with restart 1
      { restart: 3, trainObjective: 0.6 },
    ];
    expect(selectWinner(perRestart).restart).toBe(1);
  });

  it('a later restart only wins on STRICTLY greater objective', () => {
    const perRestart = [
      { restart: 0, trainObjective: 0.9 },
      { restart: 1, trainObjective: 0.9 }, // tie with restart 0 — restart 0 keeps it
    ];
    expect(selectWinner(perRestart).restart).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// bootstrapCI — pure percentile-method test (test 5)
// ---------------------------------------------------------------------------

describe('bootstrapCI', () => {
  it('matches hand-derived percentile bounds on a toy 4-question paired set', () => {
    // deltas for 4 questions; a 3-value rng cycle (period 3) against 4 draws
    // per resample deliberately does NOT align, so the 5 resample means are
    // not all identical — see the test file's PR description for the by-hand
    // derivation: resample means = [2.25, 2.75, 3.0, 2.25, 2.75].
    const deltas = [1, 2, 3, 4];
    const cycle = [0, 0.5, 0.99]; // -> indices [0, 2, 3] repeating
    let i = 0;
    const rng = () => cycle[i++ % cycle.length];

    const { point, ci95 } = bootstrapCI(deltas, 5, rng);
    expect(point).toBe(2.5); // mean(deltas), independent of resampling
    expect(ci95[0]).toBeCloseTo(2.25, 10);
    expect(ci95[1]).toBeCloseTo(2.975, 10);
  });

  it('returns null point/CI for an empty paired set (no shared non-zero-gold questions)', () => {
    const result = bootstrapCI([], 1000, () => 0.5);
    expect(result.point).toBeNull();
    expect(result.ci95).toEqual([null, null]);
  });
});

// ---------------------------------------------------------------------------
// Fixture-backed tests (real SQLite scratch stores, hand-specified fixture)
// ---------------------------------------------------------------------------

describe('computeFit (real fixture)', () => {
  beforeEach(cleanupScratch);

  it('(1) same seed => byte-identical weights JSON output', async () => {
    for (const q of QUESTIONS) await runPipeline(q);
    const trainIds = QUESTIONS.map((q) => q.question_id);
    const cachedRowsById = cacheTrainRows(trainIds);

    const run1 = computeFit(trainIds, cachedRowsById, FAST_FIT_OPTS);
    const run2 = computeFit(trainIds, cachedRowsById, FAST_FIT_OPTS);
    expect(JSON.stringify(run1.weights)).toBe(JSON.stringify(run2.weights));
  });

  it('(2) restart-0 invariant: final train objective >= the recency vector objective', async () => {
    for (const q of QUESTIONS) await runPipeline(q);
    const trainIds = QUESTIONS.map((q) => q.question_id);
    const cachedRowsById = cacheTrainRows(trainIds);

    const recencyObjective = computeTrainObjective(toWeights(recencyVector()), cachedRowsById, trainIds);
    const { winner } = computeFit(trainIds, cachedRowsById, FAST_FIT_OPTS);
    expect(winner.trainObjective).toBeGreaterThanOrEqual(recencyObjective as number);
  });

  it('(3) weights file contract: only FIT_DIMS keys; loads through buildScorers/evaluateStore without throw; dead dims absent', async () => {
    for (const q of QUESTIONS) await runPipeline(q);
    const trainIds = QUESTIONS.map((q) => q.question_id);
    const cachedRowsById = cacheTrainRows(trainIds);
    const { weights } = computeFit(trainIds, cachedRowsById, { restarts: 1, maxGens: 5 });

    expect(Object.keys(weights).sort()).toEqual([...FIT_DIMS].sort());
    const deadDims = (CONFIG.FEATURES as string[]).filter((f) => !FIT_DIMS.includes(f));
    for (const d of deadDims) expect(Object.prototype.hasOwnProperty.call(weights, d)).toBe(false);

    expect(() => buildScorers(CONFIG.FEATURES, weights)).not.toThrow();
    const rows = readJsonl(featuresPathFor(QUESTIONS[0].question_id));
    expect(() => evaluateStore(rows, [0.3], weights)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runIntegrityGate (real fixture, plus a tamper case)
// ---------------------------------------------------------------------------

describe('runIntegrityGate (real fixture)', () => {
  beforeEach(cleanupScratch);

  it('passes against a self-consistent synthetic split/registered pair built from the real fixture', async () => {
    for (const q of QUESTIONS) await runPipeline(q);
    const splitRegistered = { train: ['fixture_q_a'], heldout: ['fixture_q_b'] };
    const questionSplits = [
      { questionId: 'fixture_q_a', split: 'train' as const },
      { questionId: 'fixture_q_b', split: 'heldout' as const },
    ];
    const good = evaluateAll(questionSplits, { budgets: [0.3], primaryBudget: 0.3 });
    const registeredResults = {
      split: { trainCount: 1, heldoutCount: 1 },
      evaluate: { summary: good.summary, varyingFeatures: [...FIT_DIMS] },
    };

    const gateResult = runIntegrityGate({ splitRegistered, registeredResults });
    expect(gateResult.trainIds).toEqual(['fixture_q_a']);
    expect(gateResult.cachedRowsById.size).toBe(1);
  });

  it('(6) fails loudly, naming assertion (c), on a tampered features.jsonl value', async () => {
    for (const q of QUESTIONS) await runPipeline(q);
    const splitRegistered = { train: ['fixture_q_a'], heldout: ['fixture_q_b'] };
    const questionSplits = [
      { questionId: 'fixture_q_a', split: 'train' as const },
      { questionId: 'fixture_q_b', split: 'heldout' as const },
    ];
    const good = evaluateAll(questionSplits, { budgets: [0.3], primaryBudget: 0.3 });
    const registeredResults = {
      split: { trainCount: 1, heldoutCount: 1 },
      evaluate: { summary: good.summary, varyingFeatures: [...FIT_DIMS] },
    };

    // Sanity: the untampered gate passes against this synthetic reference.
    expect(() => runIntegrityGate({ splitRegistered, registeredResults })).not.toThrow();

    // Corrupt one non-gold row in the HELDOUT question so its recency
    // ranking (and therefore heldout recency retention) shifts.
    const path = featuresPathFor('fixture_q_b');
    const rows = readJsonl(path) as Array<{ gold: number; features: { age_days: number } }>;
    const target = rows.find((r) => r.gold === 0);
    expect(target, 'fixture must contain at least one non-gold row').toBeDefined();
    target!.features.age_days = 0; // make an old, non-gold row look newest
    writeJsonl(path, rows);

    expect(() => runIntegrityGate({ splitRegistered, registeredResults })).toThrow(/\(c\)/);
  });
});
