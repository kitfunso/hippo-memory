import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSyntheticCorpus, runFeatureEval, detectRegressions, resultToBaseline, formatResult } from '../src/eval-suite.js';
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

describe('buildSyntheticCorpus', () => {
  it('builds the same 58 entries and 23 cases, each expected id pointing at a corpus entry', () => {
    const { entries, cases } = buildSyntheticCorpus();
    expect(entries).toHaveLength(58);
    expect(cases.map((c) => c.id)).toEqual([
      'dr-q1', 'dr-q2', 'dr-q3', 'dr-q4', 'dr-q5', 'dr-q6', 'dr-q7', 'dr-q8',
      'ep-q1', 'ep-q2', 'ep-q3', 'dag-q1', 'dag-q2',
      'tmp-q1', 'tmp-q2', 'tmp-q3', 'tmp-q4', 'nr-q1', 'nr-q2', 'nr-q3', 'nr-q4', 'mh-q1', 'mh-q2',
    ]);
    const byCategory: Record<string, number> = {};
    for (const c of cases) byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
    expect(byCategory).toEqual({
      'direct-recall': 8, 'extraction-preference': 3, 'dag-drilldown': 2, temporal: 4, 'noise-resistance': 4, 'multi-hop': 2,
    });
    const ids = new Set(entries.map((e) => e.id));
    expect(ids.size).toBe(entries.length);
    expect(cases.flatMap((c) => c.expectedIds).filter((id) => !ids.has(id))).toEqual([]);
  });
});
