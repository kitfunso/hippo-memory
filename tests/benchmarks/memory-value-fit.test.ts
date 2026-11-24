import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

import { CONFIG } from '../../benchmarks/memory-value/config.mjs';
import { evaluateAll, buildScorers, evaluateStore } from '../../benchmarks/memory-value/evaluate.mjs';
import { featuresPathFor, readJsonl, writeJsonl } from '../../benchmarks/memory-value/common.mjs';
import { mulberry32 } from '../../scripts/lib/prng.mjs';
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
  verifyFrozenWeights,
  recencyVector,
  initVectorForRestart,
} from '../../benchmarks/memory-value/fit.mjs';

import { clearAblationEnv, QUESTIONS, cleanupScratch, runPipeline } from './memory-value-fixtures.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

type GateOptions = {
  splitRegistered?: object;
  registeredResults?: object;
  expectedFitDims?: readonly string[];
  needTrainRows?: boolean;
};
// SAFETY: fit.mjs destructures all four options, but its inferred parameter type omits splitRegistered and registeredResults.
const gate = runIntegrityGate as (opts?: GateOptions) => ReturnType<typeof runIntegrityGate>;

const FIT_SCRATCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mv-fit-test-scratch-'));

beforeEach(clearAblationEnv);
beforeEach(() => {
  vi.stubEnv('HIPPO_MV_SCRATCH_ROOT', FIT_SCRATCH_ROOT);
});
afterEach(clearAblationEnv);
afterAll(() => {
  fs.rmSync(FIT_SCRATCH_ROOT, { recursive: true, force: true });
});

const FAST_FIT_OPTS = { restarts: 2, maxGens: 10 };

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
    expect(result.generations).toBe(10);
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
    expect(result.trajectory[4].sigma).toBe(0.3);
    expect(result.trajectory[5].sigma).toBe(0.15);
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
    expect(result.finalSigma).toBe(0.3);
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
    expect(result.generations).toBe(25);
    expect(result.finalSigma).toBeLessThan(0.01);
  });

  it('rejects a mutation whose L2 norm is < 1e-9 without resampling (offspring is simply skipped)', () => {
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
    expect(callCount).toBe(1);
    expect(result.best).toEqual([0, 0]);
  });
});

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

describe('bootstrapCI', () => {
  it('matches hand-derived percentile bounds on a toy 4-question paired set', () => {
    const deltas = [1, 2, 3, 4];
    const cycle = [0, 0.5, 0.99];
    let i = 0;
    const rng = () => cycle[i++ % cycle.length];

    const { point, ci95 } = bootstrapCI(deltas, 5, rng);
    expect(point).toBe(2.5);
    expect(ci95[0]).toBeCloseTo(2.25, 10);
    expect(ci95[1]).toBeCloseTo(2.975, 10);
  });

  it('returns null point/CI for an empty paired set (no shared non-zero-gold questions)', () => {
    const result = bootstrapCI([], 1000, () => 0.5);
    expect(result.point).toBeNull();
    expect(result.ci95).toEqual([null, null]);
  });

  it('throws a named error when resamples < 1', () => {
    expect(() => bootstrapCI([1, 2, 3], 0, () => 0.5)).toThrow(/resamples must be >= 1/);
  });
});

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
    if (recencyObjective === null) throw new Error('every train id was skipped');
    expect(winner.trainObjective).toBeGreaterThanOrEqual(recencyObjective);
  });

  it('(3) weights file contract: only FIT_DIMS keys; loads through buildScorers/evaluateStore without throw; dead dims absent', async () => {
    for (const q of QUESTIONS) await runPipeline(q);
    const trainIds = QUESTIONS.map((q) => q.question_id);
    const cachedRowsById = cacheTrainRows(trainIds);
    const { weights } = computeFit(trainIds, cachedRowsById, { restarts: 1, maxGens: 5 });

    expect(Object.keys(weights).sort()).toEqual([...FIT_DIMS].sort());
    const deadDims = CONFIG.FEATURES.filter((f: string) => !FIT_DIMS.includes(f));
    for (const d of deadDims) expect(Object.prototype.hasOwnProperty.call(weights, d)).toBe(false);

    expect(() => buildScorers(CONFIG.FEATURES, weights)).not.toThrow();
    const rows = readJsonl(featuresPathFor(QUESTIONS[0].question_id));
    // SAFETY: computeFit returns one numeric weight per FIT_DIMS entry (asserted above); the inferred type is {}.
    type Scored = {
      N: number;
      goldCount: number;
      perScorer: Record<string, Record<number, { retention: number; keepN: number }>>;
    };
    // SAFETY: evaluateStore is untyped .mjs; this is the shape its return statement builds.
    const fitted = evaluateStore(rows, [0.3], weights as Record<string, number>) as Scored;
    // SAFETY: same return shape, without the weights.
    const unfitted = evaluateStore(rows, [0.3]) as Scored;
    expect(fitted.N).toBe(rows.length);
    expect(fitted.goldCount).toBe(1);
    expect(Object.keys(fitted.perScorer).sort()).toEqual([...Object.keys(unfitted.perScorer), 'weighted'].sort());
    for (const [name, byBudget] of Object.entries(fitted.perScorer)) {
      const { retention, keepN } = byBudget[0.3];
      expect(Number.isFinite(retention), name).toBe(true);
      expect(retention, name).toBeGreaterThanOrEqual(0);
      expect(retention, name).toBeLessThanOrEqual(1);
      expect(keepN, name).toBe(Math.ceil(0.3 * rows.length));
    }
    expect(fitted.perScorer.recency[0.3].retention).toBe(unfitted.perScorer.recency[0.3].retention);
  });
});

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
      evaluate: { summary: good.summary, varyingFeatures: good.varyingFeatures },
    };

    const gateResult = gate({ splitRegistered, registeredResults, expectedFitDims: good.varyingFeatures });
    expect(gateResult.trainIds).toEqual(['fixture_q_a']);
    expect(gateResult.cachedRowsById?.size).toBe(1);
    expect(gateResult.recencyCrossCheck).toEqual(expect.any(Number));
  });

  it('assertVarianceLiveness: registered varyingFeatures must equal expectedFitDims exactly (non-tautological)', async () => {
    for (const q of QUESTIONS) await runPipeline(q);
    const splitRegistered = { train: ['fixture_q_a'], heldout: ['fixture_q_b'] };
    const questionSplits = [
      { questionId: 'fixture_q_a', split: 'train' as const },
      { questionId: 'fixture_q_b', split: 'heldout' as const },
    ];
    const good = evaluateAll(questionSplits, { budgets: [0.3], primaryBudget: 0.3 });
    const registeredResults = {
      split: { trainCount: 1, heldoutCount: 1 },
      evaluate: { summary: good.summary, varyingFeatures: good.varyingFeatures },
    };
    const bogusExpectedFitDims = [...good.varyingFeatures, 'not_a_real_dim'];

    expect(() => gate({ splitRegistered, registeredResults, expectedFitDims: bogusExpectedFitDims })).toThrow(
      /varying-features set must equal FIT_DIMS/,
    );
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
      evaluate: { summary: good.summary, varyingFeatures: good.varyingFeatures },
    };
    const gateOpts = { splitRegistered, registeredResults, expectedFitDims: good.varyingFeatures };

    expect(() => gate(gateOpts)).not.toThrow();

    const featuresPath = featuresPathFor('fixture_q_b');
    // SAFETY: readJsonl is untyped (.mjs harness module); featuresPath is a
    // features.jsonl written by extract.mjs earlier in this test's own
    // pipeline run, whose rows always carry `gold` and `features.age_days`.
    const rows = readJsonl(featuresPath) as Array<{ gold: number; features: { age_days: number } }>;
    const target = rows.find((r) => r.gold === 0);
    expect(target?.gold, 'fixture must contain at least one non-gold row').toBe(0);
    target!.features.age_days = 0;
    writeJsonl(featuresPath, rows);

    expect(() => gate(gateOpts)).toThrow(/\(c\)/);
  });

  it('throws a named disjointness failure (not a raw comparison) when an id appears in both train and heldout', async () => {
    for (const q of QUESTIONS) await runPipeline(q);
    const splitRegistered = { train: ['fixture_q_a', 'fixture_q_b'], heldout: ['fixture_q_b'] };
    const registeredResults = { split: { trainCount: 2, heldoutCount: 1 } };

    expect(() => gate({ splitRegistered, registeredResults })).toThrow(/\(a\).*overlap/);
  });

  it('throws a named failure (not a raw TypeError) when the registered summary is missing a cell', async () => {
    for (const q of QUESTIONS) await runPipeline(q);
    const splitRegistered = { train: ['fixture_q_a'], heldout: ['fixture_q_b'] };
    const questionSplits = [
      { questionId: 'fixture_q_a', split: 'train' as const },
      { questionId: 'fixture_q_b', split: 'heldout' as const },
    ];
    const good = evaluateAll(questionSplits, { budgets: [0.3], primaryBudget: 0.3 });
    // SAFETY: evaluateAll's summary carries a heldout block (evaluate.mjs); the inferred type is {}.
    const heldoutSummary = (good.summary as { heldout: unknown }).heldout;
    const registeredResults = {
      split: { trainCount: 1, heldoutCount: 1 },
      evaluate: { summary: { heldout: heldoutSummary, train: {} }, varyingFeatures: good.varyingFeatures },
    };

    let caught: unknown;
    try {
      gate({ splitRegistered, registeredResults, expectedFitDims: good.varyingFeatures });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
    // SAFETY: narrowed by the toBeInstanceOf(Error) assertion just above.
    expect((caught as Error).message).toMatch(/\(b\).*missing train\.recency cell/);
  });
});

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

describe('computeFit (degenerate-input guards)', () => {
  beforeEach(cleanupScratch);

  it('(iv) throws a named error when every candidate objective is non-finite (all-zero-gold cache)', () => {
    const zeroFeatures = Object.fromEntries(CONFIG.FEATURES.map((f: string) => [f, 0]));
    const cachedRowsById = new Map([
      ['synthetic_q', [{ memory_id: 'm0', sessionIndex: 0, turnIdx: 0, gold: 0, features: zeroFeatures }]],
    ]);
    expect(() => computeFit(['synthetic_q'], cachedRowsById, { restarts: 1, maxGens: 2 })).toThrow(
      /non-finite train objective/,
    );
  });

  it('(v) throws a named error when the winning vector has near-zero L2 norm (box=[0,0])', async () => {
    for (const q of QUESTIONS) await runPipeline(q);
    const trainIds = QUESTIONS.map((q) => q.question_id);
    const cachedRowsById = cacheTrainRows(trainIds);
    expect(() => computeFit(trainIds, cachedRowsById, { restarts: 1, maxGens: 2, box: [0, 0] })).toThrow(
      /near-zero L2 norm/,
    );
  });

  it('(vi) throws a named error when opts.restarts < 1', () => {
    expect(() => computeFit([], new Map(), { restarts: 0 })).toThrow(/restarts must be >= 1/);
  });
});

describe('initVectorForRestart / recencyVector', () => {
  it('initVectorForRestart throws a named error when dims is missing "age_days" (restart 0)', () => {
    expect(() => initVectorForRestart(0, ['strength', 'content_length'], () => 0.5)).toThrow(/missing "age_days"/);
  });

  it('recencyVector throws a named error directly when dims is missing "age_days"', () => {
    expect(() => recencyVector(['strength'])).toThrow(/missing "age_days"/);
  });
});

describe('verifyFrozenWeights', () => {
  const goodWeights = { age_days: -0.5, content_length: -0.6 };
  const digest = 'abc123';
  const goodMeta = { weightsFileSha256: digest };

  it('accepts a well-formed weights object whose file digest matches the frozen sidecar', () => {
    expect(() => verifyFrozenWeights(goodWeights, digest, goodMeta)).not.toThrow();
  });

  it('throws a named error on an unknown dim (a weights file with a non-FIT_DIMS key)', () => {
    expect(() => verifyFrozenWeights({ ...goodWeights, schema_fit: 0.4 }, digest, goodMeta)).toThrow(
      /unknown dim "schema_fit"/,
    );
  });

  it('throws a named error on a non-finite weight value', () => {
    expect(() => verifyFrozenWeights({ age_days: Number.NaN }, digest, goodMeta)).toThrow(/not a finite number/);
  });

  it('throws a named error when the meta sidecar has no frozen digest (pre-binding freeze)', () => {
    expect(() => verifyFrozenWeights(goodWeights, digest, {})).toThrow(/no weightsFileSha256/);
  });

  it('throws a named error when the weights file digest does not match the frozen digest', () => {
    expect(() => verifyFrozenWeights(goodWeights, 'tampered', goodMeta)).toThrow(/changed after freeze/);
  });
});
