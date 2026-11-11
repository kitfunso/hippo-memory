// Round 4 prereg item 1: the arm table, the designs, the sets read from them, and the env keys of the Sonnet arms.
import { delimiter } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  ALL_ARMS, ARMS, ARM_SEEDS, ARM_TABLE, CAPTURE_ARMS, CARRY_ARMS, CODEX_HIPPO_ARMS, DESIGNS, EFFORTS, ENV_ALLOWLIST, FLOOR_ARMS, HIPPO_ARMS, NO_AUTO_MEMORY, OPUS_MODEL, RESTORED_ARMS,
  RN_ARMS, RULE_ARMS, SONNET_MODEL, TWO_SEED_ARMS, X_ARMS, allowlistOf, armEnv, armSet, armSettings, checkDesigns, checkTable, designByName, joinCodes, pairOf, roundArms, warmupEnv,
} from '../scripts/token-eval/arms.mjs';
import { runDirs } from '../scripts/token-eval/homes.mjs';
import { pooledVoids } from '../scripts/token-eval/z0-blind.mjs';
import { blindLeaks } from '../scripts/token-eval/g5-draw.mjs';
import { analyzeZ0, buildReport, renderText, unplannedDesign } from '../scripts/token-eval/z0-analyze.mjs';
import { filterRecords } from '../scripts/token-eval/z0-filters.mjs';
import { parseZ0Records } from '../scripts/token-eval/z0-records.mjs';
import { GRADING, PRICES, generate, jsonl } from './fixtures/z0-gen.js';

const R3 = ['A0', 'A1', 'A2', 'A4', 'A5', 'X1', 'X2', 'X3', 'X4'];
const R4 = ['O1', 'S1', 'S2', 'S5', 'S0', 'S4'];
const TWINS = { O1: 'A1', S1: 'A1', S2: 'A2', S5: 'A5', S0: 'A0', S4: 'A4' };
const OWN = ['round', 'twin', 'model', 'pinKey', 'effort', 'group'];
const sorted = (xs: Iterable<string>) => [...xs].sort();
type Cell = string | number | boolean | null | undefined;
type TableCopy = Record<string, Record<string, Cell>>;
interface HalfCopy { taught: string; control: string; needs: string[] }
interface DesignCopy {
  arms: string[]; noMemory: string; sets: string[]; hookHold: string[]; tests: Record<string, string[]>; pairs: Record<string, string[]>;
  reported: string[]; seedRule: { arms: string[]; tests: string[] }[]; g2: { claudeCode: HalfCopy | null; codex: HalfCopy | null };
  screen?: { control: string; taught: string } | null; drift: { arm: string; against: string; design: string } | null;
  prices: string; dropFamilies: string[]; maxSeed: number | string | null; colour?: number;
}
type DesignsCopy = Record<'r3' | 'r4' | 'r4-on-r3', DesignCopy>;
const rows: Readonly<TableCopy> = ARM_TABLE;
// Round 3's table rows and design, written out: an edit that moves round 3's read fails here.
const R3_ROWS = {
  A0: { round: 'r3', twin: null, tool: 'claude-code', model: 'claude-opus-5-5', pinKey: 'model', effort: null, set: 'RN', seeds: 2, group: 'A', autoMemory: false, carry: false, capture: false, seedRule: false, shim: null, taught: null, stub: null },
  A1: { round: 'r3', twin: null, tool: 'claude-code', model: 'claude-opus-5-5', pinKey: 'model', effort: null, set: 'RN', seeds: 3, group: 'A', autoMemory: true, carry: true, capture: false, seedRule: true, shim: null, taught: null, stub: null },
  A2: { round: 'r3', twin: null, tool: 'claude-code', model: 'claude-opus-5-5', pinKey: 'model', effort: null, set: 'RN', seeds: 3, group: 'A', autoMemory: true, carry: true, capture: true, seedRule: true, shim: 'real', taught: null, stub: null },
  A4: { round: 'r3', twin: null, tool: 'claude-code', model: 'claude-opus-5-5', pinKey: 'model', effort: null, set: 'RN', seeds: 2, group: 'A', autoMemory: false, carry: false, capture: false, seedRule: false, shim: null, taught: 'claude-md', stub: null },
  A5: { round: 'r3', twin: null, tool: 'claude-code', model: 'claude-opus-5-5', pinKey: 'model', effort: null, set: 'RN', seeds: 3, group: 'A', autoMemory: true, carry: true, capture: false, seedRule: true, shim: 'sham', taught: null, stub: null },
  X1: { round: 'r3', twin: null, tool: 'codex', model: 'gpt-5.6-sol', pinKey: 'codexModel', effort: null, set: 'X', seeds: 3, group: 'X', autoMemory: true, carry: true, capture: false, seedRule: false, shim: null, taught: null, stub: null },
  X2: { round: 'r3', twin: null, tool: 'codex', model: 'gpt-5.6-sol', pinKey: 'codexModel', effort: null, set: 'X', seeds: 3, group: 'X', autoMemory: true, carry: true, capture: true, seedRule: true, shim: 'real', taught: null, stub: null },
  X3: { round: 'r3', twin: null, tool: 'codex', model: 'gpt-5.6-sol', pinKey: 'codexModel', effort: null, set: 'X', seeds: 3, group: 'X', autoMemory: true, carry: true, capture: false, seedRule: true, shim: null, taught: null, stub: 'x3' },
  X4: { round: 'r3', twin: null, tool: 'codex', model: 'gpt-5.6-sol', pinKey: 'codexModel', effort: null, set: 'X', seeds: 2, group: 'X', autoMemory: true, carry: true, capture: false, seedRule: false, shim: null, taught: 'x4-block', stub: null },
};
const R3_DESIGN = {
  arms: ['A0', 'A1', 'A2', 'A4', 'A5', 'X1', 'X2', 'X3', 'X4'], noMemory: 'A0', sets: ['R', 'N', 'X'], hookHold: ['A2', 'A5'],
  tests: { H1: ['A2', 'A1'], H2: ['X2', 'X3'], H3: ['A2', 'A1'], H4: ['A2', 'A1'] },
  pairs: { attribution: ['A2', 'A5'], A1vA0: ['A1', 'A0'], A4vA1: ['A4', 'A1'], X2vX1: ['X2', 'X1'] },
  reported: ['A1vA0', 'A4vA1', 'X2vX1', 'H1', 'H2', 'H3'],
  seedRule: [{ arms: ['A1', 'A2', 'A5'], tests: ['H1', 'H4'] }, { arms: ['X2', 'X3'], tests: ['H2'] }],
  g2: { claudeCode: { taught: 'A4', control: 'A0', needs: ['A1', 'A2'] }, codex: { taught: 'X4', control: 'X1', needs: ['X2', 'X3'] } },
  screen: { control: 'A0', taught: 'A4' }, drift: null, prices: 'tool', dropFamilies: [], maxSeed: null,
};
const dirs = { ...runDirs('unused-out-dir', 'seqA', 'A1', 1), seed: 1 };
const base = { PATH: `/usr/bin${delimiter}/bin`, TEMP: '/tmp', JAVA_HOME: '/jdk' };
const KEYS = ['CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE'];

describe('the arm table', () => {
  it('holds the nine round 3 arms and the six round 4 arms, frozen', () => {
    expect([...ALL_ARMS]).toEqual([...R3, ...R4]);
    expect(Object.isFrozen(ARM_TABLE) && Object.isFrozen(rows.S1) && Object.isFrozen(DESIGNS.r4.tests)).toBe(true);
  });

  it('holds each of the nine round 3 rows exactly as the literal above', () => {
    expect(Object.keys(R3_ROWS)).toEqual(R3);
    for (const [code, row] of Object.entries(R3_ROWS)) expect(rows[code], code).toEqual(row);
  });

  it('gives each round 4 row its twin outside the six own fields', () => {
    for (const [code, twin] of Object.entries(TWINS)) {
      const [r, t] = [rows[code]!, rows[twin]!];
      expect(r.round, code).toBe('r4');
      expect(r.twin, code).toBe(twin);
      for (const f of Object.keys(r).filter((k) => !OWN.includes(k))) expect(r[f], `${code}.${f}`).toEqual(t[f]);
      expect([r.effort, r.group], code).toEqual(['medium', code[0]]);
    }
    expect([rows.O1!.model, rows.S1!.model, rows.S4!.pinKey]).toEqual([OPUS_MODEL, SONNET_MODEL, 'modelSonnet']);
  });

  it('stops at load on a field outside its domain, a missing or extra field, a bad code and a twin that drifted', () => {
    const copy = (): TableCopy => JSON.parse(JSON.stringify(ARM_TABLE));
    const breaks: [string, (t: TableCopy) => void, RegExp][] = [
      ['seeds outside its domain', (t) => { t.A1!.seeds = 4; }, /ARM_TABLE A1\.seeds/],
      ['a model that is no string', (t) => { t.A1!.model = 7; }, /ARM_TABLE A1\.model/],
      ['a missing field', (t) => { delete t.A1!.stub; }, /ARM_TABLE A1: field stub is missing/],
      ['an extra field', (t) => { t.A1!.colour = 'red'; }, /ARM_TABLE A1: field colour is not a table field/],
      ['a code of another shape', (t) => { t.Z1 = t.A1!; }, /ARM_TABLE Z1/],
      ['a round 3 row with a twin', (t) => { t.A1!.twin = 'A0'; }, /ARM_TABLE A1\.twin/],
      ['a twin that is a round 4 row', (t) => { t.S1!.twin = 'S2'; }, /ARM_TABLE S1\.twin/],
      ['a copied field that drifted', (t) => { t.S1!.capture = true; }, /ARM_TABLE S1\.capture.*twin A1/],
    ];
    for (const [what, change, message] of breaks) {
      const t = copy();
      change(t);
      expect(() => checkTable(t), what).toThrow(message);
    }
    expect(() => checkTable(copy())).not.toThrow();
  });
});

describe('the designs', () => {
  it('pass checkDesigns, are frozen and read by name', () => {
    expect(() => checkDesigns()).not.toThrow();
    expect(Object.keys(DESIGNS)).toEqual(['r3', 'r4', 'r4-on-r3']);
    expect(Object.isFrozen(DESIGNS.r3.arms)).toBe(true);
    expect(designByName('r4')).toBe(DESIGNS.r4);
    expect(() => designByName('r5')).toThrow(/unknown design r5; known: r3, r4, r4-on-r3/);
  });

  it('holds DESIGNS.r3 exactly as the literal above', () => {
    expect(DESIGNS.r3).toEqual(R3_DESIGN);
  });

  it('holds the prereg pairs: r3 as today, r4 with T1 to T3 and H4 in one seed-rule group', () => {
    expect([DESIGNS.r3.tests.H1, DESIGNS.r3.tests.H2, DESIGNS.r3.pairs.attribution]).toEqual([['A2', 'A1'], ['X2', 'X3'], ['A2', 'A5']]);
    expect(DESIGNS.r3.seedRule).toEqual([{ arms: ['A1', 'A2', 'A5'], tests: ['H1', 'H4'] }, { arms: ['X2', 'X3'], tests: ['H2'] }]);
    expect(DESIGNS.r4.seedRule).toEqual([{ arms: ['O1', 'S1', 'S2', 'S5'], tests: ['T1', 'T2a', 'T2b', 'T2c', 'T3', 'H4'] }]);
    expect(DESIGNS['r4-on-r3']).toMatchObject({ arms: ['A0', 'A1', 'A2', 'A4', 'A5'], maxSeed: 3, dropFamilies: ['hu3-f2', 'q133-f2', 'q14-f3', 'q256-f1'], prices: 'model' });
    expect([DESIGNS.r3.prices, DESIGNS.r4.prices, DESIGNS.r4.drift]).toEqual(['tool', 'model', { arm: 'O1', against: 'A1', design: 'r3' }]);
  });

  it('gives r4-on-r3 one seed-rule group of A1, A2 and A5 with the pairs its tests name, and T2aMiss stays out', () => {
    const group = [{ arms: ['A1', 'A2', 'A5'], tests: ['T1', 'T2a', 'T2b', 'T2c', 'T3', 'H4'] }];
    expect(DESIGNS['r4-on-r3'].seedRule).toEqual(group);
    expect(group[0]!.tests.every((t) => t in DESIGNS['r4-on-r3'].tests)).toBe(true);
    expect(DESIGNS['r4-on-r3'].seedRule.flatMap((g: { tests: string[] }) => g.tests)).not.toContain('T2aMiss');
    expect(() => checkDesigns()).not.toThrow();
    const copy: DesignsCopy = JSON.parse(JSON.stringify(DESIGNS));
    copy['r4-on-r3'].seedRule[0]!.arms.pop();
    expect(() => checkDesigns(copy)).toThrow(/DESIGNS\.r4-on-r3\.seedRule: its groups cover A1, A2 but the arms whose row has seedRule are A1, A2, A5/);
  });

  it('stops, naming the design and the field, on each break made on a deep copy', () => {
    const breaks: [string, (d: DesignsCopy) => void, RegExp][] = [
      ['a missing field', (d) => { delete d.r4.screen; }, /DESIGNS\.r4\.screen: the field is missing/],
      ['an extra field', (d) => { d.r4.colour = 1; }, /DESIGNS\.r4\.colour: the field is not a design field/],
      ['a wrong type', (d) => { d.r4.maxSeed = 'three'; }, /DESIGNS\.r4\.maxSeed: the value has the wrong type/],
      ['a code outside the table', (d) => { d.r4.arms.push('Z9'); }, /DESIGNS\.r4\.arms: Z9 is not an ARM_TABLE code/],
      ['a test arm outside the design', (d) => { d['r4-on-r3'].tests.T1 = ['S2', 'A1']; }, /DESIGNS\.r4-on-r3\.tests: S2 is not in the design's arms/],
      ['a pair of one arm', (d) => { d.r3.pairs.attribution = ['A2', 'A2']; }, /DESIGNS\.r3\.pairs: attribution holds A2 twice/],
      ['a name in both tests and pairs', (d) => { d.r3.pairs.H1 = ['A2', 'A1']; }, /DESIGNS\.r3\.pairs: H1 is in both tests and pairs/],
      ['a reported name that is neither', (d) => { d.r3.reported.push('H9'); }, /DESIGNS\.r3\.reported: H9 is in neither/],
      ['a seed-rule test that is neither', (d) => { d.r4.seedRule[0]!.tests.push('T9'); }, /DESIGNS\.r4\.seedRule: test T9 is in neither/],
      ['a seed-rule group that misses an arm', (d) => { d.r4.seedRule[0]!.arms.pop(); }, /DESIGNS\.r4\.seedRule: its groups cover/],
      ['a g2 half arm outside the design', (d) => { d.r4.g2.claudeCode!.taught = 'A4'; }, /DESIGNS\.r4\.g2: A4 is not in the design's arms/],
      ['a drift against an arm its design lacks', (d) => { d.r4.drift!.against = 'S1'; }, /DESIGNS\.r4\.drift: S1 is not in the arms of design r3/],
      ['a drift to no design', (d) => { d.r4.drift!.design = 'r9'; }, /DESIGNS\.r4\.drift: design r9 is not a design/],
      ['an arm in two seed-rule groups', (d) => { d.r3.seedRule[1]!.arms.push('A1'); }, /DESIGNS\.r3\.seedRule: A1 is in two seed-rule groups/],
      ['a drift arm outside the design\'s arms', (d) => { d.r4.drift!.arm = 'A1'; }, /DESIGNS\.r4\.drift: A1 is not in the design's arms/],
      ['a no-memory arm outside the design', (d) => { d.r4.noMemory = 'A0'; }, /DESIGNS\.r4\.noMemory: A0 is not in the design's arms/],
      ['a hook-hold arm outside the design', (d) => { d.r4.hookHold.push('A0'); }, /DESIGNS\.r4\.hookHold: A0 is not in the design's arms/],
      ['a pair arm outside the design', (d) => { d.r4.pairs.S1vS0 = ['S1', 'A0']; }, /DESIGNS\.r4\.pairs: A0 is not in the design's arms/],
      ['a seed-rule arm outside the design', (d) => { d.r4.seedRule[0]!.arms.push('A0'); }, /DESIGNS\.r4\.seedRule: A0 is not in the design's arms/],
      ['a screen arm outside the design', (d) => { d.r4.screen = { control: 'A0', taught: 'S4' }; }, /DESIGNS\.r4\.screen: A0 is not in the design's arms/],
    ];
    for (const [what, change, message] of breaks) {
      const copy: DesignsCopy = JSON.parse(JSON.stringify(DESIGNS));
      change(copy);
      expect(() => checkDesigns(copy), what).toThrow(message);
    }
  });

  const r3Report = () => {
    const g = generate();
    const analysis = analyzeZ0(parseZ0Records(jsonl(g.records), 'runs.jsonl').records, { planCells: g.plan, prices: PRICES, grading: GRADING, unblind: true, refuse: () => null, iterations: 200, seed: 1 });
    return buildReport(analysis, { warnings: [] }, {}, null, []);
  };

  it('prints the reported pair lines from the design\'s reported list', () => {
    const report = r3Report();
    const names = ['A1vA0', 'A4vA1', 'X2vX1'];
    const printed = (text: string) => text.split('\n').filter((l) => names.some((n) => l.startsWith(`  ${n}: `))).map((l) => l.slice(2, l.indexOf(':')));
    expect(printed(renderText(report))).toEqual(names);
    expect(printed(renderText(report, { ...DESIGNS.r3, reported: ['X2vX1', 'H1', 'A1vA0'] }))).toEqual(['X2vX1', 'A1vA0']);
  });

  it('stops, naming the design and the pair, on a reported name that is no test and that the report lacks', () => {
    // Round 4's first reported name, S1vS0, is a pair that no round 3 report holds.
    expect(() => renderText(r3Report(), DESIGNS.r4)).toThrow(/^design r4 reports S1vS0, but the report holds no block for it$/);
  });

  it('reads a pair by name from tests or pairs and stops on an unknown name', () => {
    expect(pairOf(DESIGNS.r3, 'H3')).toEqual(['A2', 'A1']);
    expect(pairOf(DESIGNS.r3, 'X2vX1')).toEqual(['X2', 'X1']);
    expect(pairOf(DESIGNS.r4, 'T3')).toEqual(['S2', 'S5']);
    expect(() => pairOf(DESIGNS.r3, 'T1')).toThrow(/design r3 has no test or pair named T1/);
    expect(() => pairOf(DESIGNS['r4-on-r3'], 'H1')).toThrow(/design r4-on-r3 has no test or pair named H1/);
  });
});

describe('the sets and views read from the table', () => {
  it('equal their round 3 literals on round 3 arms and hold the round 4 arms the rows name', () => {
    const onR3 = (set: ReadonlySet<string>) => sorted([...set].filter((a) => R3.includes(a)));
    expect(onR3(HIPPO_ARMS)).toEqual(['A2', 'A5', 'X2']);
    expect(onR3(CARRY_ARMS)).toEqual(['A1', 'A2', 'A5', 'X1', 'X2', 'X3', 'X4']);
    expect([onR3(RESTORED_ARMS), onR3(FLOOR_ARMS), onR3(NO_AUTO_MEMORY)]).toEqual([['A0', 'A4'], ['A0', 'A4'], ['A0', 'A4']]);
    expect(onR3(TWO_SEED_ARMS)).toEqual(['A0', 'A4', 'X4']);
    expect(onR3(CAPTURE_ARMS)).toEqual(['A2', 'X2']);
    expect(onR3(RULE_ARMS)).toEqual(['A1', 'A2', 'A5', 'X2', 'X3']);
    expect(sorted(HIPPO_ARMS)).toEqual(['A2', 'A5', 'S2', 'S5', 'X2']);
    expect(sorted(CODEX_HIPPO_ARMS)).toEqual(['X2']);
    expect(sorted(CAPTURE_ARMS)).toEqual(['A2', 'S2', 'X2']);
    expect(sorted(TWO_SEED_ARMS)).toEqual(['A0', 'A4', 'S0', 'S4', 'X4']);
    expect(sorted(RESTORED_ARMS)).toEqual(['A0', 'A4', 'S0', 'S4']);
    expect(sorted(RULE_ARMS)).toEqual(['A1', 'A2', 'A5', 'O1', 'S1', 'S2', 'S5', 'X2', 'X3']);
  });

  it('keep each DESIGNS.r3 view equal to today\'s iterated list', () => {
    expect([...ARMS]).toEqual(R3);
    expect([[...RN_ARMS], [...X_ARMS]]).toEqual([['A0', 'A1', 'A2', 'A4', 'A5'], ['X1', 'X2', 'X3', 'X4']]);
    // Slice 2a: ARM_SEEDS holds every row, so the round 4 arms find their seed cap.
    expect(ARM_SEEDS).toEqual({ A0: 2, A1: 3, A2: 3, A4: 2, A5: 3, X1: 3, X2: 3, X3: 3, X4: 2, O1: 3, S1: 3, S2: 3, S5: 3, S0: 2, S4: 2 });
    expect([armSet('A1'), armSet('X3'), armSet('S1'), armSet('A9')]).toEqual(['RN', 'X', 'RN', 'RN']);
    expect([roundArms('r4', 'seedRule'), roundArms('r3', 'capture')]).toEqual([['O1', 'S1', 'S2', 'S5'], ['A2', 'X2']]);
    expect([joinCodes(['A2', 'X2']), joinCodes(['A1', 'A2', 'A5', 'X2', 'X3']), joinCodes(['S2'])]).toEqual(['A2 and X2', 'A1, A2, A5, X2 and X3', 'S2']);
  });

  it('list no round 4 code in a round 3 read of unplanned arms', () => {
    const full = generate();
    expect(unplannedDesign(filterRecords(full.records, full.plan))).toEqual([]);
    const noX = generate({ arms: ['A0', 'A1', 'A2', 'A4', 'A5'] });
    expect(unplannedDesign(filterRecords(noX.records, noX.plan))).toEqual(['X1', 'X2', 'X3', 'X4', 'set X']);
  });
});

describe('arm settings and env for the round 4 arms', () => {
  const hippo = { hooks: { SessionEnd: [], UserPromptSubmit: [] } };

  it('give each round 4 row its twin\'s settings and env but for the three model and effort keys', () => {
    for (const [code, twin] of Object.entries(TWINS)) {
      expect(armSettings(code, hippo), code).toEqual(armSettings(twin, hippo));
      const [env, twinEnv] = [armEnv(code, dirs, base), armEnv(twin, dirs, base)];
      expect(Object.fromEntries(Object.entries(env).filter(([k]) => !KEYS.includes(k))), code).toEqual(twinEnv);
      expect(KEYS.every((k) => k in env) && KEYS.every((k) => !(k in twinEnv)), code).toBe(true);
    }
  });

  it('sets the effort, the subagent model and its force flag from the row, and lets effort replace the row\'s', () => {
    const s1 = armEnv('S1', dirs, base);
    expect([s1.CLAUDE_CODE_EFFORT_LEVEL, s1.CLAUDE_CODE_SUBAGENT_MODEL, s1.CLAUDE_CODE_SUBAGENT_MODEL_FORCE]).toEqual(['medium', SONNET_MODEL, '1']);
    expect(armEnv('O1', dirs, base).CLAUDE_CODE_SUBAGENT_MODEL).toBe(OPUS_MODEL);
    expect(armEnv('S1', dirs, base, { effort: 'low' }).CLAUDE_CODE_EFFORT_LEVEL).toBe('low');
    expect(EFFORTS).toEqual(['low', 'medium', 'high']);
    expect(() => armEnv('A1', dirs, base, { effort: 'low' })).toThrow(/arm A1 runs with no effort setting/);
    expect(() => armEnv('S1', dirs, base, { effort: 'max' })).toThrow(/effort max is not one of low, medium, high/);
    expect(() => armEnv('A9', dirs, base)).toThrow(/unknown arm A9; known: A0, A1/);
  });

  it('refuses a --pass-env copy of the three keys and lists them in the allowlist', () => {
    for (const k of KEYS) {
      expect(ENV_ALLOWLIST).toContain(k);
      expect(() => armEnv('S1', dirs, { ...base, [k]: 'x' }, { passEnv: [k] }), k).toThrow(/the runner sets/);
    }
  });

  it('allowlists by design: ENV_ALLOWLIST itself for r3 and r4-on-r3, and a frozen copy with PIP_CONSTRAINT for r4', () => {
    expect(allowlistOf(DESIGNS.r3)).toBe(ENV_ALLOWLIST);
    expect(allowlistOf(DESIGNS['r4-on-r3'])).toBe(ENV_ALLOWLIST);
    const r4 = allowlistOf(DESIGNS.r4);
    expect(r4).not.toBe(ENV_ALLOWLIST);
    expect([...r4]).toEqual([...ENV_ALLOWLIST, 'PIP_CONSTRAINT']);
    expect(Object.isFrozen(r4)).toBe(true);
    expect(ENV_ALLOWLIST).not.toContain('PIP_CONSTRAINT');
  });

  it('builds the warm-up call from the design\'s no-memory arm with --model as an argv flag', () => {
    const warm = warmupEnv(DESIGNS.r4, OPUS_MODEL, dirs, base);
    expect(warm.args).toEqual(['--model', OPUS_MODEL]);
    expect([warm.env.CLAUDE_CODE_SUBAGENT_MODEL, warm.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, warm.env.CLAUDE_CODE_EFFORT_LEVEL, warm.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE]).toEqual([OPUS_MODEL, '1', 'medium', '1']);
    // Round 3's warm-up set no subagent model, so its env is armEnv's, key for key.
    const r3 = warmupEnv(DESIGNS.r3, OPUS_MODEL, dirs, base);
    expect(r3.env).toEqual(armEnv(DESIGNS.r3.noMemory, dirs, base));
    expect(r3.args).toEqual(['--model', OPUS_MODEL]);
  });
});

describe('the blind read of round 4 codes', () => {
  it('redacts O1 and S0 to S5 from void reasons and flags each as a leak', () => {
    const reasons = R4.map((a) => `${a} read the transcript`);
    const pooled = pooledVoids(Object.fromEntries(R4.map((a, i) => [a, { voids: 1, voidReasons: { [reasons[i]!]: 1 } }])));
    expect(JSON.stringify(pooled)).not.toMatch(/\b[OS][0-9]\b/);
    expect(pooled).toMatchObject({ total: 6, reasons: { '* read the transcript': 6 } });
    for (const a of R4) expect(blindLeaks(`the ${a} arm`, []), a).toEqual([a]);
    expect(blindLeaks('the S10 arm and OS1', [])).toEqual([]);
  });
});
