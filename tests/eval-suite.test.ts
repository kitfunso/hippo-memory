import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFeatureEval, detectRegressions, resultToBaseline, formatResult } from '../src/eval-suite.js';
import { cmdEval } from '../src/cli/eval.js';
import { runInProcess } from './_helpers/run-in-process.js';

describe('eval-suite scoring', () => {
  it('scores the synthetic corpus deterministically with every category present', async () => {
    const a = await runFeatureEval('t');
    const b = await runFeatureEval('t');

    expect(a.features.map((f) => f.category).sort()).toEqual(
      ['direct-recall', 'dag-drilldown', 'extraction-preference', 'multi-hop', 'noise-resistance', 'temporal'].sort(),
    );
    expect(a.totalCases).toBe(a.features.reduce((s, f) => s + f.cases, 0));
    expect(a.overall).toEqual(b.overall);
    expect(a.features.find((f) => f.category === 'direct-recall')!.mrr).toBe(1);
  });

  it('a result compared with its own baseline passes; a degraded result is flagged', async () => {
    const result = await runFeatureEval('t');
    const baseline = resultToBaseline(result);
    expect(detectRegressions(baseline, result)).toMatchObject({ verdict: 'PASS', regressions: [] });

    const degraded = { ...result, features: result.features.map((f) => (f.category === 'temporal' ? { ...f, ndcgAt5: f.ndcgAt5 - 0.2 } : f)) };
    const report = detectRegressions(baseline, degraded);
    expect(report.verdict).toBe('REGRESSION');
    expect(report.regressions.map((r) => `${r.category}.${r.metric}`)).toEqual(['temporal.ndcgAt5']);
    expect(formatResult(degraded, baseline)).toContain('Verdict: REGRESSION (1 regressions)');
  });
});

describe('hippo eval --suite', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hippo-eval-suite-'));
    vi.stubEnv('HIPPO_HOME', join(dir, 'home'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (extra: Record<string, boolean> = {}) =>
    runInProcess(() => cmdEval(join(dir, '.hippo'), null, { suite: true, baseline: join(dir, 'base.json'), ...extra }));

  it('writes a baseline file on --save-baseline and then passes against it', async () => {
    const saved = await run({ 'save-baseline': true });
    expect(saved.status).toBe(0);
    const baseline = JSON.parse(readFileSync(join(dir, 'base.json'), 'utf8'));
    expect(Object.keys(baseline.features)).toHaveLength(6);

    const again = await run();
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('Verdict: PASS');
  });

  it('exits 1 when the metrics fall below a saved baseline', async () => {
    await run({ 'save-baseline': true });
    const baseline = JSON.parse(readFileSync(join(dir, 'base.json'), 'utf8'));
    for (const f of Object.values<{ mrr: number }>(baseline.features)) f.mrr = 2;
    writeFileSync(join(dir, 'base.json'), JSON.stringify(baseline));

    const res = await run();
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('REGRESSIONS DETECTED');
    expect(existsSync(join(dir, 'base.json'))).toBe(true);
  });
});
