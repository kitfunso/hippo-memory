// Round 4 prereg item 1: the synthetic generator builds either design, and its round 3 corpus is the one round 3's tests always read.
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { DESIGNS } from '../scripts/token-eval/arms.mjs';
import { analyzeZ0 } from '../scripts/token-eval/z0-analyze.mjs';
import { NOT_RUN } from '../scripts/token-eval/z0-hypotheses.mjs';
import { checkPrices, costOf } from '../scripts/token-eval/z0-prices.mjs';
import { parseZ0Records, validateCorpus } from '../scripts/token-eval/z0-records.mjs';
import { validateCorpus as contractCorpus } from './fixtures/z0-contract.js';
import { GRADING, PRICES_BY_MODEL, generate, jsonl, type Generated, type Z0Record } from './fixtures/z0-gen.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const R4 = DESIGNS.r4;
const armsOf = (g: Generated) => [...new Set(g.records.map((r) => r.arm))].sort();
// SAFETY: the generator writes every field z0-contract.ts reads; its types lack only fields of real runs that the contract never checks.
const underContract = (g: Generated) => contractCorpus(g.records as Parameters<typeof contractCorpus>[0], g.plan as Parameters<typeof contractCorpus>[1]);
const parse = (g: Generated) => parseZ0Records(jsonl(g.records), 'runs.jsonl').records;
const seedsOf = (g: Generated, arm: string) => [...new Set(g.records.filter((r) => r.arm === arm).map((r) => r.seed))].sort();

describe('the generator under DESIGNS.r3', () => {
  // sha256 of the corpus and plan that commit 04835462b's generator wrote at the same options.
  const BASE_HASHES: [string, Parameters<typeof generate>[0], number, string, string][] = [
    ['default', {}, 2328, '918b7933cf443919e8671a7f4f70ce79d3fa4493cb029d91203893374c22952f', 'e1ff227c850ee6739d60b42f1194850c4a1bec4e1522e82446a32991728d4b99'],
    ['A arms, 3 repos', { arms: ['A0', 'A1', 'A2', 'A4', 'A5'], repos: 3 }, 702, '3b0769598d47957c70206d8c0626d533bfcd5744a140e98aba7116a61c061be2', '6b03f27ce6b84ddb7ba3a95e90c2c7f7bc7eb538cc463eb2b945314d33c688d7'],
    ['knobs', { repos: 2, knobs: { A1: { fail: 0, resolve: 1 }, X2: { fail: 0.2, na: 0.1 } } }, 776, 'e22ad8c3ed35a74d7f5cb5a73e34c3a5928944327307514b3313a4196e32e5ae', '8145c098ae49d23ba91a07dd344d0070528887a612bc3ca0e82f8942f16abc0e'],
  ];

  it('is byte-identical to the base commit\'s corpus and plan at the same options', () => {
    for (const [name, opts, n, records, plan] of BASE_HASHES) {
      const g = generate(opts);
      expect([g.records.length, sha(jsonl(g.records)), sha(JSON.stringify(g.plan))], name).toEqual([n, records, plan]);
    }
    expect(generate({ design: DESIGNS.r3 }).records).toEqual(generate().records);
  });
});

describe('the generator under DESIGNS.r4', () => {
  const g = generate({ design: R4 });

  it('holds O1, S0, S1, S2, S4 and S5, S0 and S4 at 2 seeds, and capture on S2 only', () => {
    expect(armsOf(g)).toEqual(['O1', 'S0', 'S1', 'S2', 'S4', 'S5']);
    for (const arm of ['S0', 'S4']) expect(seedsOf(g, arm), arm).toEqual([1, 2]);
    for (const arm of ['O1', 'S1', 'S2', 'S5']) expect(seedsOf(g, arm), arm).toEqual([1, 2, 3]);
    const captured = new Set(g.records.filter((r) => r.chain?.captured === true).map((r) => r.arm));
    expect([...captured]).toEqual(['S2']);
    expect(g.records.every((r) => r.tool === 'claude-code' && r.set !== 'X')).toBe(true);
  });

  it('passes parseZ0Records, validateCorpus and the contract checks', () => {
    const records = parse(g);
    expect(validateCorpus(records, g.plan).unchecked).toEqual([]);
    expect(underContract(g)).toEqual([]);
    const r3 = generate({ arms: ['A0', 'A1', 'A2', 'A4', 'A5'] });
    expect(underContract(r3)).toEqual([]);
  });

  it('passes G2 under both codings, and fails it when S4 or S0 is missing while S1 and S2 are planned', () => {
    const analyze = (corpus: Generated) => analyzeZ0(parse(corpus), { planCells: corpus.plan, design: R4, prices: PRICES_BY_MODEL, grading: GRADING, iterations: 200, seed: 1 });
    const ok = analyze(g);
    expect([ok.status, ok.gates!.G2.claudeCode.status, ok.gates!.G2.codex]).toEqual(['valid', 'pass', { status: NOT_RUN, required: false, pass: true }]);
    for (const [name, left] of [['S4', 'S0'], ['S0', 'S4']] as const) {
      const without = generate({ design: R4, arms: R4.arms.filter((a: string) => a !== name) });
      const a = analyze(without);
      expect(a.gates!.G2.claudeCode, `${name} missing`).toEqual({ status: NOT_RUN, required: true, pass: false });
      expect([a.status, a.gates!.failed], left).toEqual(['invalid', ['G2']]);
    }
  });

  it('prices every record under PRICES_BY_MODEL with no NaN and passes checkPrices', () => {
    expect(() => checkPrices(PRICES_BY_MODEL, 'fixture', R4)).not.toThrow();
    const costs = g.records.map((r: Z0Record) => costOf(r, PRICES_BY_MODEL, { design: R4 }));
    expect(costs.every((c: number) => Number.isFinite(c) && c > 0)).toBe(true);
  });
});
