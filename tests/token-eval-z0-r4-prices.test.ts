// Round 4 prereg item 7: a record is priced at its tool's row under round 3 and at its arm's model row under round 4.
import { describe, it, expect } from 'vitest';
import { addUsage, priceUsage } from '../dist/eval/eval-stats.js';
import { DESIGNS, OPUS_MODEL, SONNET_MODEL } from '../scripts/token-eval/arms.mjs';
import { filterRecords } from '../scripts/token-eval/z0-filters.mjs';
import { inSets, taskUnits } from '../scripts/token-eval/z0-hypotheses.mjs';
import { PRICE_FIELDS, checkPrices, costOf, partCost, priceRow } from '../scripts/token-eval/z0-prices.mjs';
import { PRICES, PRICES_BY_MODEL, generate, type Z0Record } from './fixtures/z0-gen.js';

const [OPUS, SONNET] = [PRICES_BY_MODEL.models[OPUS_MODEL], PRICES_BY_MODEL.models[SONNET_MODEL]];
const R3_FILE = { asOf: '2026-11-01', 'claude-code': { ...PRICES['claude-code'], model: OPUS_MODEL } };
const r4 = { design: DESIGNS.r4 };
const RATE_FIELDS = ['inputPerMTok', 'cacheWritePerMTok', 'cacheReadPerMTok', 'outputPerMTok'] as const;
type Rates = typeof OPUS;
const byHand = (r: Z0Record, row: Rates) => priceUsage(addUsage(r.usage!.firstSession, r.usage!.extra), row);
const first = (records: readonly Z0Record[], arm: string, kind = 'apply') => records.find((r) => r.arm === arm && r.kind === kind)!;

describe('the price row of one record', () => {
  const { records } = generate({ design: DESIGNS.r4, repos: 1 });

  it('is the arm\'s model row under r4: an S2 and an O1 record at two rows, and rowModel moves S2 to Opus', () => {
    const [s2, o1] = [first(records, 'S2'), first(records, 'O1')];
    expect(priceRow(PRICES_BY_MODEL, s2, r4)).toBe(SONNET);
    expect(priceRow(PRICES_BY_MODEL, o1, r4)).toBe(OPUS);
    expect([costOf(s2, PRICES_BY_MODEL, r4), costOf(o1, PRICES_BY_MODEL, r4)]).toEqual([byHand(s2, SONNET), byHand(o1, OPUS)]);
    expect(costOf(s2, PRICES_BY_MODEL, { ...r4, rowModel: OPUS_MODEL })).toBe(byHand(s2, OPUS));
    expect(costOf(s2, PRICES_BY_MODEL, r4)).toBeCloseTo(costOf(s2, PRICES_BY_MODEL, { ...r4, rowModel: OPUS_MODEL }) / 2, 9);
    expect(partCost(s2.usage!.extra, s2, PRICES_BY_MODEL, r4)).toBe(priceUsage(s2.usage!.extra, SONNET));
  });

  it('reads rows by their model field when the file has no models block, and ignores a top-level string', () => {
    const rows = { asOf: '2026-11-01', opus: { ...OPUS, model: OPUS_MODEL }, sonnet: { ...SONNET, model: SONNET_MODEL } };
    expect(priceRow(rows, first(records, 'S1'), r4)).toBe(rows.sonnet);
    expect(() => checkPrices(rows, 'rows.json', DESIGNS.r4)).not.toThrow();
  });

  it('stops under r4 on a codex record and on a model with no row, naming the record, the model and the file', () => {
    expect(() => costOf({ ...first(records, 'S2'), tool: 'codex' }, PRICES_BY_MODEL, r4)).toThrow(/tool codex but arm S2 runs claude-code/);
    const noSonnet = { models: { [OPUS_MODEL]: OPUS } };
    expect(() => costOf(first(records, 'S1'), noSonnet, { ...r4, file: 'prices.json' })).toThrow(/no price row for model claude-sonnet-5-5 \(arm S1\) in prices\.json; add its row from the price page and record it in an amendment \(prereg item 7\)/);
    expect(() => costOf({ ...first(records, 'S1'), arm: 'Q1' }, PRICES_BY_MODEL, r4)).toThrow(/arm Q1 is not an arm of the arm table/);
  });

  it('is the tool\'s row under r3: an X teach at the claude-code row, an X apply at the codex row, and n/a with no codex row', () => {
    const x = generate({ repos: 1 }).records;
    const [teach, apply] = [first(x, 'X2', 'teach'), first(x, 'X2', 'apply')];
    expect([teach.tool, apply.tool]).toEqual(['claude-code', 'codex']);
    const codex = { inputPerMTok: 1, cacheWritePerMTok: 2, cacheReadPerMTok: 0.1, outputPerMTok: 8 };
    const both = { ...PRICES, codex };
    expect([costOf(teach, both), costOf(apply, both)]).toEqual([byHand(teach, PRICES['claude-code']), byHand(apply, codex)]);
    expect([costOf(teach, PRICES), costOf(apply, PRICES)]).toEqual([byHand(teach, PRICES['claude-code']), Number.NaN]);
    expect(costOf(first(x, 'A1'), PRICES)).toBe(byHand(first(x, 'A1'), PRICES['claude-code']));
  });

  it('is the claude-code row, by its model field, for round 3\'s file under r4-on-r3', () => {
    const a1 = first(generate({ repos: 1 }).records, 'A1');
    expect(priceRow(R3_FILE, a1, { design: DESIGNS['r4-on-r3'] })).toBe(R3_FILE['claude-code']);
    expect(costOf(a1, R3_FILE, { design: DESIGNS['r4-on-r3'] })).toBe(costOf(a1, R3_FILE));
    expect(() => costOf(a1, { 'claude-code': PRICES['claude-code'] }, { design: DESIGNS['r4-on-r3'] })).toThrow(/no price row for model claude-opus-5-5/);
  });
});

describe('taskUnits under a by-model design', () => {
  it('prices S2 and S1 at the Sonnet row, each side at its own record', () => {
    const { records, plan } = generate({ design: DESIGNS.r4, repos: 2 });
    const filtered = filterRecords(records, plan);
    const units = taskUnits(filtered.scored, 'S2', 'S1', PRICES_BY_MODEL, inSets('R', 'N'), r4);
    expect(units.length).toBeGreaterThan(0);
    for (const u of units) expect(Number.isFinite(u.t.cost) && Number.isFinite(u.c.cost) && u.t.cost > 0 && u.c.cost > 0).toBe(true);
    const atOpus = taskUnits(filtered.scored, 'S2', 'S1', PRICES_BY_MODEL, inSets('R', 'N'), { ...r4, rowModel: OPUS_MODEL });
    expect(atOpus[0]!.t.cost).toBeCloseTo(units[0]!.t.cost * 2, 9);
    expect(units[0]!.t.cost).toBeCloseTo(units[0]!.t.first + units[0]!.t.extra, 9);
  });
});

describe('checkPrices', () => {
  it('passes round 3\'s file under r3 and r4-on-r3 and PRICES_BY_MODEL under r4', () => {
    expect(() => checkPrices(PRICES, 'p.json')).not.toThrow();
    expect(() => checkPrices(R3_FILE, 'p.json', DESIGNS.r3)).not.toThrow();
    expect(() => checkPrices(R3_FILE, 'p.json', DESIGNS['r4-on-r3'])).not.toThrow();
    expect(() => checkPrices(PRICES_BY_MODEL, 'p.json', DESIGNS.r4)).not.toThrow();
    expect(() => checkPrices(PRICES_BY_MODEL, 'p.json', DESIGNS['r4-on-r3'])).not.toThrow();
  });

  it('keeps today\'s message under r3 for a file with no claude-code row or a bad codex row', () => {
    const message = `p.json: needs "claude-code" (and optionally "codex") with ${PRICE_FIELDS.join(', ')}`;
    expect(() => checkPrices({ codex: PRICES['claude-code'] }, 'p.json')).toThrow(message);
    expect(() => checkPrices({ ...PRICES, codex: { inputPerMTok: 'x' } }, 'p.json')).toThrow(message);
    expect(() => checkPrices(PRICES_BY_MODEL, 'p.json')).toThrow(message);
  });

  it('stops under r4 on round 3\'s file (no Sonnet row) and on a file with no row for an arm\'s model, naming the model', () => {
    expect(() => checkPrices(R3_FILE, 'p.json', DESIGNS.r4)).toThrow(/p\.json: no price row for model claude-sonnet-5-5/);
    expect(() => checkPrices({ models: { [SONNET_MODEL]: SONNET } }, 'p.json', DESIGNS.r4)).toThrow(/no price row for model claude-opus-5-5/);
    expect(() => checkPrices({ models: { [OPUS_MODEL]: OPUS, [SONNET_MODEL]: { inputPerMTok: 1 } } }, 'p.json', DESIGNS.r4)).toThrow(/models\.claude-sonnet-5-5 needs/);
    expect(() => checkPrices({ models: [] }, 'p.json', DESIGNS.r4)).toThrow(/"models" must be an object/);
  });

  it('stops when a Sonnet column is not half the Opus column, naming the column and both rates', () => {
    expect([...RATE_FIELDS]).toEqual(PRICE_FIELDS);
    for (const column of RATE_FIELDS) {
      const off = { models: { [OPUS_MODEL]: OPUS, [SONNET_MODEL]: { ...SONNET, [column]: SONNET[column] + 0.01 } } };
      expect(() => checkPrices(off, 'p.json', DESIGNS.r4), column).toThrow(new RegExp(`p\\.json: ${column} is .* for claude-sonnet-5-5 and .* for claude-opus-5-5, not half; the freeze stops; an amendment sets k`));
    }
    const close = { models: { [OPUS_MODEL]: OPUS, [SONNET_MODEL]: { ...SONNET, inputPerMTok: SONNET.inputPerMTok + 1e-10 } } };
    expect(() => checkPrices(close, 'p.json', DESIGNS.r4)).not.toThrow();
  });
});

describe('a price file with two top-level rows for one model', () => {
  const nine = { inputPerMTok: 9, cacheWritePerMTok: 9, cacheReadPerMTok: 9, outputPerMTok: 9 };
  // The first Sonnet row is priced at 9, the last is exactly half of Opus: each used to be the row of one side only.
  const twice = { opus: { ...OPUS, model: OPUS_MODEL }, sonnetA: { ...nine, model: SONNET_MODEL }, sonnetB: { ...SONNET, model: SONNET_MODEL } };
  const s1 = first(generate({ design: DESIGNS.r4, repos: 1 }).records, 'S1');

  it('stops checkPrices under r4 and the price row of an S1 record, naming both row keys, the model and the file', () => {
    expect(() => checkPrices(twice, 'p.json', DESIGNS.r4)).toThrow('p.json: rows "sonnetA" and "sonnetB" both name model claude-sonnet-5-5; a model has one price row');
    expect(() => priceRow(twice, s1, { ...r4, file: 'p.json' })).toThrow('p.json: rows "sonnetA" and "sonnetB" both name model claude-sonnet-5-5; a model has one price row');
    expect(() => costOf(s1, twice, r4)).toThrow(/^the price file: rows "sonnetA" and "sonnetB" both name model claude-sonnet-5-5/);
  });

  it('still prices and passes round 3\'s file, a claude-code row that names Opus plus a codex row, under r3 and r4-on-r3', () => {
    const withCodex = { ...R3_FILE, codex: { model: 'gpt-5.6-sol', inputPerMTok: 4, cacheWritePerMTok: 5, cacheReadPerMTok: 0.4, outputPerMTok: 20 } };
    const { records } = generate({ repos: 1 });
    const [teach, a1] = [first(records, 'X2', 'teach'), first(records, 'A1')];
    for (const [name, design] of [['r3', DESIGNS.r3], ['r4-on-r3', DESIGNS['r4-on-r3']]] as const) expect(() => checkPrices(withCodex, 'p.json', design), name).not.toThrow();
    expect(priceRow(withCodex, a1, { design: DESIGNS['r4-on-r3'] })).toBe(withCodex['claude-code']);
    expect(costOf(a1, withCodex, { design: DESIGNS['r4-on-r3'] })).toBe(costOf(a1, withCodex));
    expect(costOf(teach, withCodex)).toBe(byHand(teach, withCodex['claude-code']));
  });
});
