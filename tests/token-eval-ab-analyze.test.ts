/**
 * TE5 A/B analyzer on synthetic run records with a known effect: the hippo
 * arm resolves the same tasks for less, and the random-text control does not.
 * The records are generated here, not measured; they test the arithmetic.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error - .mjs script without a .d.ts
import { parseRuns, analyze, recordCost } from '../scripts/token-eval/ab-analyze.mjs';

function records(): string {
  const lines: string[] = [];
  for (let task = 0; task < 40; task++) {
    const cluster = `repo${task % 5}`;
    const resolvedBase = task % 4 !== 0;
    for (let seed = 1; seed <= 3; seed++) {
      const base = { taskId: `t${task}`, cluster, seed };
      lines.push(JSON.stringify({ ...base, arm: 'no-memory', resolved: resolvedBase,
        usage: { inputTokens: 20_000, cacheWriteTokens: 30_000, cacheReadTokens: 500_000, outputTokens: 8_000 },
        turns: 20, fileReads: 12, toolCalls: 30, repeatedErrors: 2 }));
      lines.push(JSON.stringify({ ...base, arm: 'hippo', resolved: resolvedBase || task % 8 === 0,
        usage: { inputTokens: 16_000, cacheWriteTokens: 24_000, cacheReadTokens: 380_000, outputTokens: 6_000 },
        turns: 15, fileReads: 8, toolCalls: 22, repeatedErrors: 1 }));
      lines.push(JSON.stringify({ ...base, arm: 'random-text', resolved: resolvedBase,
        usage: { inputTokens: 21_000, cacheWriteTokens: 31_000, cacheReadTokens: 520_000, outputTokens: 8_000 },
        turns: 20, fileReads: 12, toolCalls: 30, repeatedErrors: 2 }));
    }
  }
  return lines.join('\n');
}

describe('A/B analyzer (TE5)', () => {
  const prices = { inputPerMTok: 3, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3, outputPerMTok: 15 };

  it('reports a cheaper cost per resolved task and less work for the hippo arm', () => {
    const result = analyze(parseRuns(records()), { prices });
    const hippo = result.comparisons.find((c: { arm: string }) => c.arm === 'hippo');
    expect(hippo.tasks).toBe(40);
    expect(hippo.costPerResolved.relative.estimate).toBeLessThan(-0.2);
    expect(hippo.costPerResolved.relative.high).toBeLessThan(0);
    expect(hippo.resolveRate.arm).toBeGreaterThan(hippo.resolveRate.control);
    expect(hippo.work.fileReads.estimate).toBeCloseTo(-4, 10);
    expect(hippo.passHatK.arm).toBeGreaterThanOrEqual(hippo.passHatK.control);
  });

  it('does not credit a control arm that only adds tokens', () => {
    const result = analyze(parseRuns(records()), { prices });
    const random = result.comparisons.find((c: { arm: string }) => c.arm === 'random-text');
    expect(random.costPerResolved.relative.estimate).toBeGreaterThan(0);
    expect(random.resolveRate.delta.estimate).toBe(0);
  });

  it('prices in dollars with prices and in weighted tokens without', () => {
    const [r] = parseRuns(records().split('\n')[0]!);
    expect(recordCost(r, prices)).toBeCloseTo((20_000 * 3 + 30_000 * 3.75 + 500_000 * 0.3 + 8_000 * 15) / 1e6, 10);
    expect(recordCost(r, null)).toBeCloseTo(20_000 + 37_500 + 50_000 + 40_000, 6);
  });

  it('rejects records without usage instead of zero-filling', () => {
    expect(() => parseRuns(JSON.stringify({ taskId: 't', cluster: 'c', arm: 'a', seed: 1, resolved: true }))).toThrow(/usage is required/);
    expect(() => analyze(parseRuns(records()), { control: 'missing' })).toThrow(/control arm/);
  });
});

describe('A/B analyzer exclusions', () => {
  it('excludes unscored and invalid runs and reports them', () => {
    const base = { cluster: 'c', seed: 1, resolved: true, usage: { inputTokens: 1, cacheWriteTokens: 1, cacheReadTokens: 1, outputTokens: 1 } };
    const text = [
      { ...base, taskId: 't0', arm: 'no-memory', scored: false },
      { ...base, taskId: 't0', arm: 'hippo', scored: false },
      { ...base, taskId: 't1', arm: 'no-memory' },
      { ...base, taskId: 't1', arm: 'hippo' },
      { ...base, taskId: 't2', arm: 'no-memory' },
      { ...base, taskId: 't2', arm: 'hippo', usage: null, invalid: 'no-result' },
      { ...base, taskId: 't3', arm: 'hippo', invalid: 'leak' },
    ].map((r) => JSON.stringify(r)).join('\n');
    const result = analyze(parseRuns(text));
    expect(result.excluded).toEqual({ unscored: 2, invalid: { 'no-result': 1, leak: 1 } });
    expect(result.comparisons[0].tasks).toBe(1);
  });
});
