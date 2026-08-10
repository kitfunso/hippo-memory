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
  computeBarsMet,
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
    // varyingFeatures comes from the REPRODUCED value (`good.varyingFeatures`),
    // not a hardcoded [...FIT_DIMS] — the tiny 2-question, reduced-simulation
    // fixture does not vary across every one of the 8 production FIT_DIMS
    // (e.g. `strength` is constant within both toy stores), so hardcoding
    // FIT_DIMS here would fail the NEW reproduced==registered variance check
    // (gate-hardening fix round) even though the gate is behaving correctly.
    // `expectedFitDims` lets this fixture test the MECHANISM (registered==
    // expected AND reproduced==registered) without asserting production's
    // FIT_DIMS onto a toy dataset that was never meant to vary across all 8.
    const registeredResults = {
      split: { trainCount: 1, heldoutCount: 1 },
      evaluate: { summary: good.summary, varyingFeatures: good.varyingFeatures },
    };

    const gateResult = runIntegrityGate({ splitRegistered, registeredResults, expectedFitDims: good.varyingFeatures });
    expect(gateResult.trainIds).toEqual(['fixture_q_a']);
    expect(gateResult.cachedRowsById.size).toBe(1);
    expect(typeof gateResult.recencyCrossCheck).toBe('number');
  });

  it('(6) fails loudly, naming assertion (c), on a tampered features.jsonl value', async () => {
    for (const q of QUESTIONS) await runPipeline(q);
    const splitRegistered = { train: ['fixture_q_a'], heldout: ['fixture_q_b'] };
    const questionSplits = [
      { questionId: 'fixture_q_a', split: 'train' as const },
      { questionId: 'fixture_q_b', split: 'heldout' as const },
    ];
    const good = evaluateAll(questionSplits, { budgets: [0.3], primaryBudget: 0.3 });
    // See the previous test for why varyingFeatures/expectedFitDims come
    // from the fixture's own reproduced value rather than FIT_DIMS.
    const registeredResults = {
      split: { trainCount: 1, heldoutCount: 1 },
      evaluate: { summary: good.summary, varyingFeatures: good.varyingFeatures },
    };
    const gateOpts = { splitRegistered, registeredResults, expectedFitDims: good.varyingFeatures };

    // Sanity: the untampered gate passes against this synthetic reference.
    expect(() => runIntegrityGate(gateOpts)).not.toThrow();

    // Corrupt one non-gold row in the HELDOUT question so its recency
    // ranking (and therefore heldout recency retention) shifts.
    const featuresPath = featuresPathFor('fixture_q_b');
    const rows = readJsonl(featuresPath) as Array<{ gold: number; features: { age_days: number } }>;
    const target = rows.find((r) => r.gold === 0);
    expect(target, 'fixture must contain at least one non-gold row').toBeDefined();
    target!.features.age_days = 0; // make an old, non-gold row look newest
    writeJsonl(featuresPath, rows);

    expect(() => runIntegrityGate(gateOpts)).toThrow(/\(c\)/);
  });

  it('throws a named disjointness failure (not a raw comparison) when an id appears in both train and heldout', async () => {
    for (const q of QUESTIONS) await runPipeline(q);
    // train/heldout overlap on fixture_q_b — assertSplitIntegrity must catch
    // this before any evaluateAll/baseline work runs.
    const splitRegistered = { train: ['fixture_q_a', 'fixture_q_b'], heldout: ['fixture_q_b'] };
    const registeredResults = { split: { trainCount: 2, heldoutCount: 1 } };

    expect(() => runIntegrityGate({ splitRegistered, registeredResults })).toThrow(/\(a\).*overlap/);
  });

  it('throws a named failure (not a raw TypeError) when the registered summary is missing a cell', async () => {
    for (const q of QUESTIONS) await runPipeline(q);
    const splitRegistered = { train: ['fixture_q_a'], heldout: ['fixture_q_b'] };
    const questionSplits = [
      { questionId: 'fixture_q_a', split: 'train' as const },
      { questionId: 'fixture_q_b', split: 'heldout' as const },
    ];
    const good = evaluateAll(questionSplits, { budgets: [0.3], primaryBudget: 0.3 });
    // `train` summary is present but missing its recency/uniform cells — a
    // realistic "malformed committed JSON" shape, not just an absent key.
    const registeredResults = {
      split: { trainCount: 1, heldoutCount: 1 },
      evaluate: { summary: { heldout: good.summary.heldout, train: {} }, varyingFeatures: good.varyingFeatures },
    };

    let caught: unknown;
    try {
      runIntegrityGate({ splitRegistered, registeredResults, expectedFitDims: good.varyingFeatures });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as Error).message).toMatch(/\(b\).*missing train\.recency cell/);
  });
});

// ---------------------------------------------------------------------------
// computeBarsMet — pure bars-met/degenerate-pairing guard (test 7.iii)
// ---------------------------------------------------------------------------

describe('computeBarsMet', () => {
  it('throws a named data-integrity error when a bootstrap CI bound is null (empty paired-delta set)', () => {
    const heldout = { weighted: 0.5, recency: 0.3, uniform: 0.2 };
    const ciVsRecency = { point: null, ci95: [null, null] };
    const ciVsUniform = { point: 0.1, ci95: [0.05, 0.15] };
    expect(() => computeBarsMet(heldout, ciVsRecency, ciVsUniform)).toThrow(/data integrity/);
  });

  it('returns true when both deltas are positive and both CIs exclude 0', () => {
    const heldout = { weighted: 0.5, recency: 0.3, uniform: 0.2 };
    const ciVsRecency = { point: 0.2, ci95: [0.1, 0.3] };
    const ciVsUniform = { point: 0.3, ci95: [0.2, 0.4] };
    expect(computeBarsMet(heldout, ciVsRecency, ciVsUniform)).toBe(true);
  });

  it('returns false when a CI crosses 0 even though the point estimate is higher', () => {
    const heldout = { weighted: 0.5, recency: 0.3, uniform: 0.2 };
    const ciVsRecency = { point: 0.2, ci95: [-0.05, 0.3] };
    const ciVsUniform = { point: 0.3, ci95: [0.2, 0.4] };
    expect(computeBarsMet(heldout, ciVsRecency, ciVsUniform)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeFit — non-finite objective / zero-norm winner guards (tests 7.iv, 7.v)
// ---------------------------------------------------------------------------

describe('computeFit (degenerate-input guards)', () => {
  beforeEach(cleanupScratch);

  it('(iv) throws a named error when every candidate objective is non-finite (all-zero-gold cache)', () => {
    // No real pipeline run needed: a stubbed cachedRowsById whose only row
    // is non-gold forces computeTrainObjective to skip every id (zero-gold
    // skip rule), so computeTrainObjective returns null and the objective
    // wrapper maps that to -Infinity for every candidate ES ever evaluates.
    const zeroFeatures = Object.fromEntries(CONFIG.FEATURES.map((f: string) => [f, 0]));
    const cachedRowsById = new Map([
      ['synthetic_q', [{ memory_id: 'm0', sessionIndex: 0, turnIdx: 0, gold: 0, features: zeroFeatures }]],
    ]);
    expect(() => computeFit(['synthetic_q'], cachedRowsById, { restarts: 1, maxGens: 2 })).toThrow(
      /non-finite train objective/,
    );
  });

  it('(v) throws a named error when the winning vector has near-zero L2 norm (box=[0,0])', async () => {
    // box=[0,0] clips every init AND every mutation to exactly 0, so every
    // offspring's L2 norm is < 1e-9 and gets rejected (runES's own
    // zero-norm mutation guard) for the entire run — the parent, and
    // therefore the winner, never moves off the all-zero vector.
    for (const q of QUESTIONS) await runPipeline(q);
    const trainIds = QUESTIONS.map((q) => q.question_id);
    const cachedRowsById = cacheTrainRows(trainIds);
    expect(() => computeFit(trainIds, cachedRowsById, { restarts: 1, maxGens: 2, box: [0, 0] })).toThrow(
      /near-zero L2 norm/,
    );
  });
});
