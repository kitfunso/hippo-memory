/** Z0 round 4 shared scorer and verdict rule (prereg items 2 and 12): one rule sets p and the bounds of every test, and the closed test reads both. */

import { combineCodings, verdict } from '../../dist/eval/eval-stats.js';
import { studentTCdf, studentTQuantile } from '../../dist/eval/repository-t.js';
import { SPECS } from './z0-hypotheses.mjs';

// repository-t.ts's FLAT: equal repository values leave float noise that reads as no spread at all.
const FLAT = 1e-12;
export const NO_VERDICT = 'no verdict';
/** The null and the helpful side of each test; T2a is log R, T2b the resolve difference, T2c the repeat difference. */
export const T_NULLS = Object.freeze({
  T1: Object.freeze({ nullValue: 0, side: 'below' }),
  T3: Object.freeze({ nullValue: 0, side: 'below' }),
  T2a: Object.freeze({ nullValue: 0, side: 'below' }),
  T2b: Object.freeze({ nullValue: -0.03, side: 'above' }),
  T2c: Object.freeze({ nullValue: 0.15, side: 'below' }),
});
// T1 is read at 0.05 alone; the closed test reads every other test at both thresholds.
export const THRESHOLDS = Object.freeze({ T1: ['0.05'], T3: ['0.025', '0.05'], T2a: ['0.025', '0.05'], T2b: ['0.025', '0.05'], T2c: ['0.025', '0.05'] });

const onSide = (estimate, nullValue, side) => {
  if (side !== 'below' && side !== 'above') throw new Error(`side ${side} is not below or above`);
  return side === 'below' ? estimate < nullValue : estimate > nullValue;
};

/** The two-sided p on the raw df and the interval at `level` on the df rounded to 3 decimals, so level 0.05 gives `tResult`'s numbers (repository-t.ts:96).
 * `win` is p under the level with the estimate on `side`; `edge` marks a win that the rounded-df interval contradicts. */
export function scoreTest({ estimate, se, df }, { nullValue, side, level }) {
  if (!Number.isFinite(estimate) || !Number.isFinite(se)) return { p: Number.NaN, low: Number.NaN, high: Number.NaN, win: false, edge: false };
  let [p, half] = [0, 0];
  if (se <= FLAT * Math.max(1, Math.abs(estimate))) {
    p = Math.abs(estimate - nullValue) <= FLAT * Math.max(1, Math.abs(nullValue)) ? 1 : 0;
  } else {
    p = 2 * studentTCdf(-Math.abs((estimate - nullValue) / se), df);
    half = studentTQuantile(1 - level / 2, Math.round(df * 1000) / 1000) * se;
  }
  const [low, high] = [estimate - half, estimate + half];
  const helpful = onSide(estimate, nullValue, side);
  const win = p < level && helpful;
  const excludes = side === 'below' ? high < nullValue : low > nullValue;
  return { p, low, high, win, edge: helpful && excludes !== win };
}

const views = (test) => (test.codings === undefined ? [test] : Object.values(test.codings));
const nullOf = (name, v) => v.nullValue ?? T_NULLS[name].nullValue;
const isHelpful = (v, name) => onSide(v.estimate, nullOf(name, v), v.side);

function levelOf(levels, name, threshold) {
  const raw = levels?.[name]?.[threshold];
  const level = raw?.level ?? raw;
  if (!Number.isFinite(level)) throw new Error(`closedTest: levels.${name}['${threshold}'] is missing`);
  return level;
}

/** A test wins at a threshold when every coding's p is under its level there with the estimate on the helpful side; a test with no verdict never wins. */
const winsAt = (test, name, levels, threshold) => test !== null && views(test).every((v) => v.p < levelOf(levels, name, threshold) && isHelpful(v, name));

/** Round 3's labels (`SPECS.H1`) at the p levels this reading allows: a loss under `lossLevel`, a win under `winLevel`, tie or inconclusive from the 0.05 bounds. */
function readView(v, name, { lossLevel, winLevel }) {
  const e = { estimate: v.estimate, low: v.bounds['0.05'].low, high: v.bounds['0.05'].high, nullValue: nullOf(name, v) };
  const loss = verdict(e, v.p, { ...SPECS.H1, alpha: lossLevel });
  return loss.verdict === 'loss' ? loss : verdict(e, v.p, { ...SPECS.H1, alpha: winLevel });
}

const readTest = (test, name, rule) => views(test).map((v) => readView(v, name, rule)).reduce(combineCodings);
const none = (reason) => ({ verdict: NO_VERDICT, reason });

const isHarmful = (v, name, threshold) => {
  const { low, high } = v.bounds[threshold];
  return v.side === 'below' ? low > nullOf(name, v) : high < nullOf(name, v);
};

function readPart(part, name, levels, readAt) {
  if (part === null) return { win: { '0.025': false, '0.05': false }, harmfulSide: false };
  return {
    win: { '0.025': winsAt(part, name, levels, '0.025'), '0.05': winsAt(part, name, levels, '0.05') },
    harmfulSide: views(part).some((v) => isHarmful(v, name, readAt)),
  };
}

/** One-sided p toward a pass: half the two-sided p on the helpful side, else one minus it; no estimate gives 1. */
const oneSided = (v, name) => (Number.isNaN(v.p) ? 1 : isHelpful(v, name) ? v.p / 2 : 1 - v.p / 2);

/** T2's printed p: the largest one-sided part p (both codings for part (c)), doubled and capped at 1. It decides nothing. */
export function t2P(parts) {
  const ps = ['a', 'b', 'c'].flatMap((k) => (parts[k] === null || parts[k] === undefined ? [1] : views(parts[k]).map((v) => oneSided(v, `T2${k}`))));
  return Math.min(1, 2 * Math.max(...ps));
}

/** Prereg item 2: T1 alone at 0.05 gates T2 and T3, which run as closed testing with Bonferroni local tests at 0.025, then each reads at 0.05.
 * A test is `{ p, estimate, side, bounds: { '0.025', '0.05' }, codings? }` or null for no verdict; `codings` holds one such object per coding.
 * `levels` holds each test's level per threshold, as `levels[test][threshold]`. */
export function closedTest({ T1, T2, T3 }, levels) {
  const l1 = T1 === null ? null : levelOf(levels, 'T1', '0.05');
  const t1 = T1 === null ? none('no estimate') : readTest(T1, 'T1', { lossLevel: l1, winLevel: l1 });
  if (t1.verdict !== 'win') {
    const why = T1 === null ? 'T1 has no verdict' : `T1 is ${t1.verdict}`;
    return { T1: t1, T2: none(why), T3: none(why), jointFalls: false };
  }
  const t2Wins = (threshold) => T2 !== null && ['a', 'b', 'c'].every((k) => winsAt(T2[k], `T2${k}`, levels, threshold));
  const jointFalls = (T3 !== null && winsAt(T3, 'T3', levels, '0.025')) || t2Wins('0.025');
  const [l025, l05] = T3 === null ? [0, 0] : [levelOf(levels, 'T3', '0.025'), levelOf(levels, 'T3', '0.05')];
  const t3 = T3 === null ? none('no estimate') : readTest(T3, 'T3', { lossLevel: l025, winLevel: jointFalls ? l05 : 0 });
  const readAt = jointFalls ? '0.05' : '0.025';
  const t2 = T2 === null ? none('no estimate') : {
    verdict: jointFalls && t2Wins('0.05') ? 'pass' : 'no pass',
    p: t2P(T2),
    readAt,
    parts: Object.fromEntries(['a', 'b', 'c'].map((k) => [k, readPart(T2[k], `T2${k}`, levels, readAt)])),
  };
  return { T1: t1, T2: t2, T3: t3, jointFalls };
}

/** The tests and their thresholds, each sorted, so the order a file lists them in never separates two files. */
const keysOf = (file) => Object.keys(file.levels).sort().map((test) => [test, Object.keys(file.levels[test]).sort()]);

function checkPair(preFreeze, batch1) {
  if (preFreeze.source !== 'pre-freeze' || batch1.source !== 'batch-1') {
    throw new Error(`minLevels needs one pre-freeze file and one batch-1 file; got a ${preFreeze.source} file and a ${batch1.source} file`);
  }
  const [a, b] = [new Map(preFreeze.sources.map((s) => [s.file, s.sha256])), new Map(batch1.sources.map((s) => [s.file, s.sha256]))];
  for (const file of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(file) !== b.get(file)) throw new Error(`minLevels: the files were made by different sources at ${file}: ${a.get(file) ?? 'absent'} against ${b.get(file) ?? 'absent'}`);
  }
  for (const [name, file] of [['pre-freeze', preFreeze], ['batch-1', batch1]]) {
    for (const [test, thresholds] of Object.entries(THRESHOLDS)) {
      for (const t of thresholds) if (file.levels[test]?.[t] === undefined) throw new Error(`minLevels: the ${name} file has no level for ${test} at ${t}`);
    }
  }
  if (JSON.stringify(keysOf(preFreeze)) !== JSON.stringify(keysOf(batch1))) throw new Error('minLevels: the two files hold different tests or thresholds');
}

/** The lower of the pre-freeze and batch 1 levels per test and threshold, with the cell that set it and its file; a tie keeps the pre-freeze one.
 * A different commit is printed through `log` and not refused. Each argument is a levels file, with an optional `file` path the caller adds. */
export function minLevels(preFreeze, batch1, log = console.log) {
  checkPair(preFreeze, batch1);
  if (preFreeze.commit !== batch1.commit) log(`minLevels: the levels files were made at different commits, ${preFreeze.commit} and ${batch1.commit}`);
  return Object.fromEntries(Object.entries(preFreeze.levels).map(([test, byThreshold]) => [test, Object.fromEntries(Object.keys(byThreshold).map((t) => {
    const [first, second] = [preFreeze.levels[test][t], batch1.levels[test][t]];
    const [entry, from] = second.level < first.level ? [second, batch1] : [first, preFreeze];
    return [t, { level: entry.level, setBy: entry.setBy, cell: entry.cells.find((c) => c.setting === entry.setBy) ?? null, file: from.file ?? from.source }];
  }))]));
}
