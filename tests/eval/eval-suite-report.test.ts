import { describe, it, expect } from 'vitest';
import {
  detectRegressions,
  formatResult,
  resultToBaseline,
  type EvalSuiteResult,
  type FeatureResult,
} from '../../src/eval/eval-suite.js';

const feature = (category: FeatureResult['category'], ndcgAt5: number, mrr = 0.8): FeatureResult => ({
  category,
  cases: 4,
  mrr,
  recallAt5: 0.9,
  ndcgAt5,
  passed: true,
});

const result = (features: FeatureResult[]): EvalSuiteResult => ({
  version: '9.9.9',
  timestamp: '2026-01-01T00:00:00.000Z',
  features,
  overall: { mrr: 0.8, recallAt5: 0.9, ndcgAt5: 0.7 },
  totalCases: 8,
  durationMs: 12,
});

describe('detectRegressions', () => {
  const base = resultToBaseline(result([feature('direct-recall', 0.7), feature('temporal', 0.7)]));

  it('passes a drop of exactly the threshold and flags one past it', () => {
    expect(detectRegressions(base, result([feature('direct-recall', 0.65), feature('temporal', 0.7)])).verdict).toBe(
      'PASS',
    );
    const report = detectRegressions(base, result([feature('direct-recall', 0.6), feature('temporal', 0.7)]));
    expect(report.verdict).toBe('REGRESSION');
    expect(report.regressions.map((r) => [r.category, r.metric])).toEqual([['direct-recall', 'ndcgAt5']]);
  });

  it('lists a gain past the threshold as an improvement and skips a category the baseline lacks', () => {
    const report = detectRegressions(base, result([feature('temporal', 0.9), feature('multi-hop', 0.1)]));
    expect(report.verdict).toBe('PASS');
    expect(report.improvements.map((i) => [i.category, i.metric])).toEqual([['temporal', 'ndcgAt5']]);
    expect(report.regressions).toEqual([]);
  });
});

describe('resultToBaseline', () => {
  it('keeps each category metrics and drops the case counts', () => {
    const baseline = resultToBaseline(result([feature('temporal', 0.5, 0.4)]));
    expect(baseline.features).toEqual({ temporal: { mrr: 0.4, recallAt5: 0.9, ndcgAt5: 0.5 } });
    expect(baseline.version).toBe('9.9.9');
  });
});

describe('formatResult', () => {
  it('marks every row as baseline when no baseline is given, and prints no verdict', () => {
    const text = formatResult(result([feature('temporal', 0.7)]));
    expect(text).toContain('Hippo Eval v9.9.9 — 8 queries, 12ms');
    expect(text).toMatch(/temporal\s+\|.*\| NEW\s+\| baseline/);
    expect(text).not.toContain('Verdict:');
  });

  it('reports a regression row and the verdict against a baseline', () => {
    const base = resultToBaseline(result([feature('temporal', 0.7)]));
    const text = formatResult(result([feature('temporal', 0.5)]), base);
    expect(text).toContain('REGRESS');
    expect(text).toContain('REGRESSIONS DETECTED');
    expect(text).toContain('Verdict: REGRESSION (1 regressions)');
  });
});
