/** Z0 analyzer, part 3 of 6: units, fixed-repository t tests (family is the unit) with stratified bootstrap twins, H1-H4,
 * one Holm procedure per coding over H1 and H2, attribution, reported estimates. The repeat-mistake rate reads each lesson's
 * `first` verdict only (prereg 151); H3 and H4 read Claude Code records only. */

import { combineCodings, harmGate, holmAdjust, twoLevelBootstrap, verdict } from '../../dist/eval/eval-stats.js';
import { fixedRepositoryRatioT, fixedRepositoryT, repositoryT } from '../../dist/eval/repository-t.js';
import { ARM_TABLE, DESIGNS, TWO_SEED_ARMS, pairOf } from './arms.mjs';
import { blocks, cellsOf, familyOf, resolveDiff } from './z0-cost-solved.mjs';
import { pairTasks, withoutRuns } from './z0-filters.mjs';
import { costOf, partCost } from './z0-prices.mjs';
import { positionKey } from './z0-records.mjs';

export const CODINGS = ['violation', 'excluded'];
/** The primary family (Amendment 1): H3 is reported beside it with no verdict. */
export const HYPOTHESES = ['H1', 'H2'];
export const NOT_RUN = 'not run';
export const NA = 'n/a';
/** @typedef {import('../../src/eval/eval-stats.js').VerdictSpec} VerdictSpec */
/** @type {VerdictSpec} */
const REPEAT_SPEC = { helpful: 'lower', tieBand: [-0.15, 0.15], minimumEffectAt: -0.15 };
/** @type {Record<'H1' | 'H2', VerdictSpec>} */
export const SPECS = { H1: REPEAT_SPEC, H2: REPEAT_SPEC };
export const LESSONS_SENTENCE = "hippo's lessons cut repeat mistakes";
export const BEHAVIOUR_SENTENCE = 'installing hippo changed behaviour, and this run cannot say its lessons did';
export const NO_N_DATA = 'no set N data';
export const A5_NOT_RUN = 'A5 not run';

export const sum = (xs) => xs.reduce((s, x) => s + x, 0);
export const mean = (xs) => sum(xs) / xs.length;
export const inSets = (...sets) => (r) => sets.includes(r.set);
// The H1 unit (round 3): a family's first apply in set R, before any re-teaching can differ between arms.
export const firstApplyR = (r) => r.set === 'R' && r.applyIndex === 1;
export const codexApply = (r) => r.set === 'X' && r.tool === 'codex';
export const maintainer = (r) => r.lessonSource !== 'template';
export const byCoding = (fn) => Object.fromEntries(CODINGS.map((c) => [c, fn(c)]));

/** Share of a task's lessons failed on the first attempt; `na` is a fail under `violation` and dropped under `excluded`. */
export function shareFail(r, coding) {
  const lessons = coding === 'excluded' ? r.lessons.filter((l) => l.first !== 'na') : r.lessons;
  if (lessons.length === 0) return null;
  return lessons.filter((l) => l.first !== 'pass').length / lessons.length;
}

/** Units are finite by construction, so a dropped resample is a bug, never data. */
function meanBootstrap(units, opts) {
  const e = twoLevelBootstrap(blocks(units), (us) => mean(us.map((u) => u.value)), { iterations: opts.iterations, seed: opts.seed, nullValue: 0, fixedRepositories: true });
  if (e.dropped > 0) throw new Error(`repeat-mistake bootstrap dropped ${e.dropped} resamples; every unit must be finite`);
  return e;
}

// The sizer passes no resample count, since only the t result decides; the analyzer always passes one.
const twin = (opts, run) => (opts.iterations === undefined ? {} : { bootstrap: run() });

/** Amendment 1's t test over repository means (each repository counts once), kept as a view: it decides nothing. */
export function acrossRepositories(units) {
  const means = blocks(units).map((fams) => mean(fams.flat().map((u) => u.value)));
  return { perRepository: means, t: repositoryT(means, 0) };
}

/** The fixed-repository t test against 0 (family is the unit), plus `bootstrap` and `across` when `opts.iterations` is set. */
export function repeatT(units, opts) {
  const across = opts.iterations === undefined ? {} : { across: acrossRepositories(units) };
  return { ...fixedRepositoryT(units, 0), ...across, ...twin(opts, () => meanBootstrap(units, opts)) };
}

/** One unit per (repo, family, seed) holding a scored apply record in either arm; its value is the mean over
 * paired tasks with an applicable lesson in both arms, and a unit left with no such task is dropped and listed. */
export function repeatMistakeUnits(scored, armT, armC, coding, keep) {
  const twoSeed = TWO_SEED_ARMS.has(armT) || TWO_SEED_ARMS.has(armC);
  const groups = new Map();
  const groupOf = (r) => {
    const key = JSON.stringify([r.repo, r.familyId, r.seed]);
    if (!groups.has(key)) groups.set(key, { repo: r.repo, family: r.familyId, seed: r.seed, diffs: [] });
    return groups.get(key);
  };
  for (const r of scored) {
    if ((r.arm === armT || r.arm === armC) && r.kind === 'apply' && keep(r) && !(twoSeed && r.seed > 2)) groupOf(r);
  }
  for (const { t, c } of pairTasks(scored, armT, armC)) {
    if (t.kind !== 'apply' || !keep(t) || !keep(c)) continue;
    const [ft, fc] = [shareFail(t, coding), shareFail(c, coding)];
    if (ft !== null && fc !== null) groupOf(t).diffs.push(ft - fc);
  }
  const units = [];
  const dropped = [];
  for (const g of groups.values()) {
    if (g.diffs.length > 0) units.push({ repo: g.repo, family: g.family, seed: g.seed, value: mean(g.diffs) });
    else dropped.push(`${g.family} seed ${g.seed}`);
  }
  return { units, dropped };
}

export function repeatMistake(scored, armT, armC, coding, opts, keep) {
  const { units, dropped } = repeatMistakeUnits(scored, armT, armC, coding, keep);
  return { ...repeatT(units, opts), units: units.length, droppedUnits: dropped };
}

export const bothCodings = (scored, armT, armC, opts, keep) => byCoding((c) => repeatMistake(scored, armT, armC, c, opts, keep));

/** One unit per paired Claude Code task; a no-lesson task is a family of one keyed by its task id. Each side is priced at its own record's row of the whole price file. */
export function taskUnits(scored, armT, armC, prices, keep, opts = {}) {
  const side = (r) => ({
    cost: costOf(r, prices, opts), first: partCost(r.usage.firstSession, r, prices, opts), extra: partCost(r.usage.extra, r, prices, opts), resolved: r.resolved ? 1 : 0,
  });
  return pairTasks(scored, armT, armC)
    .filter(({ t, c }) => t.tool === 'claude-code' && c.tool === 'claude-code' && keep(t))
    .map(({ t, c }) => ({ repo: t.repo, family: familyOf(t), seed: t.seed, set: t.set, t: side(t), c: side(c) }));
}

export const ratioOf = (field) => (us) => sum(us.map((u) => u.t[field])) / sum(us.map((u) => u.c[field]));

function ratioBootstrap(units, field, opts) {
  return twoLevelBootstrap(blocks(units), ratioOf(field), { iterations: opts.iterations, seed: opts.seed, nullValue: 1, fixedRepositories: true });
}

const ratioCells = (units, field) => cellsOf(units, (us) => ({ t: sum(us.map((u) => u.t[field])), c: sum(us.map((u) => u.c[field])) }));

/** The pooled ratio of `field` with the fixed-repository log-scale interval, plus `bootstrap` when `opts.iterations` is set. */
export function ratioT(units, field, opts) {
  return { ...fixedRepositoryRatioT(ratioCells(units, field)), ...twin(opts, () => ratioBootstrap(units, field, opts)) };
}

/** H4 on set N units: the cost ratio and the resolve difference, each a fixed-repository test (family is the unit), and the gate.
 * The cost ratio's interval is built on the log scale: skewed costs let a symmetric one pass a true 1.10 too often
 * (Amendment 1 skew check, analyzer doc). */
export function harmT(nUnits, opts) {
  const costRatio = { ...fixedRepositoryRatioT(ratioCells(nUnits, 'cost')), ...twin(opts, () => ratioBootstrap(nUnits, 'cost', opts)) };
  const boot = () => twoLevelBootstrap(blocks(nUnits), resolveDiff, { iterations: opts.iterations, seed: opts.seed, nullValue: 0, fixedRepositories: true });
  const cells = cellsOf(nUnits, (us) => ({ value: resolveDiff(us) }));
  const resolve = { ...fixedRepositoryT(cells, 0), ...twin(opts, boot) };
  return { costRatio, resolveDiff: resolve, gate: harmGate(costRatio, resolve) };
}

/** Holm once per coding over (H1, H2), then combine the codings (reading 4); a hypothesis not run enters as NaN. */
export function holmVerdicts(estimatesByCoding, specs = SPECS) {
  const per = byCoding((coding) => {
    const ests = HYPOTHESES.map((h) => estimatesByCoding[coding][h]);
    const adjusted = holmAdjust(ests.map((e) => (e ? e.p : Number.NaN)));
    return ests.map((e, i) => (e ? { ...verdict(e, adjusted[i], specs[HYPOTHESES[i]]), adjustedP: adjusted[i] } : null));
  });
  return Object.fromEntries(HYPOTHESES.map((h, i) => {
    const [v, x] = [per.violation[i], per.excluded[i]];
    return [h, v && x ? { violation: v, excluded: x, final: combineCodings(v, x) } : { final: { verdict: NOT_RUN } }];
  }));
}

function reportOrder(verdicts, h4) {
  const losses = HYPOTHESES.filter((h) => verdicts[h].final.verdict === 'loss');
  const h4Failed = h4 !== null && !h4.gate.pass;
  const rest = HYPOTHESES.filter((h) => !losses.includes(h));
  const order = h4Failed ? [...losses, 'H4', ...rest] : [...losses, ...rest, 'H4'];
  return [...order, 'attribution'];
}

/** Prereg 148 words a winning H1 two ways, so a tie, loss or inconclusive H1 gets neither sentence (reading 2).
 * With A5 not planned (`est` null), A2 cannot have beaten it, so a win takes 148's "Otherwise" sentence. */
function attributionOf(h1Verdict, est) {
  if (h1Verdict !== 'win') return { ...est, sentence: null, reason: `not applicable, H1 is ${h1Verdict}` };
  if (est === null) return { sentence: BEHAVIOUR_SENTENCE, reason: A5_NOT_RUN };
  return { ...est, sentence: CODINGS.every((c) => est[c].high < 0) ? LESSONS_SENTENCE : BEHAVIOUR_SENTENCE };
}

/** H4 is "not run" when set N was never planned, and fails when it was planned but filters left no pair: a harm gate needs data to pass. */
function harmGateOf(units, setNPlanned, opts) {
  if (units === null || !setNPlanned) return null;
  const nUnits = units.filter((u) => u.set === 'N');
  if (nUnits.length === 0) return { reason: NO_N_DATA, gate: { pass: false, costOk: false, resolveOk: false } };
  return harmT(nUnits, opts);
}

const plannedArms = (filtered) => {
  const planned = new Set(filtered.arms);
  return (...arms) => arms.every((a) => planned.has(a));
};

/** The primary family, the harm gate and attribution; the caller runs this only when every gate passes. */
export function computeHypotheses(filtered, prices, opts) {
  const s = filtered.scored;
  const runs = plannedArms(filtered);
  const design = opts.design ?? DESIGNS.r3;
  const [h1Pair, h2Pair, h3Pair, attributionPair] = ['H1', 'H2', 'H3', 'attribution'].map((name) => pairOf(design, name));
  const h1 = runs(...h1Pair) ? bothCodings(s, ...h1Pair, opts, firstApplyR) : null;
  const h2 = runs(...h2Pair) ? bothCodings(s, ...h2Pair, opts, codexApply) : null;
  const units = runs(...h3Pair) ? taskUnits(s, ...h3Pair, prices, inSets('R', 'N'), opts) : null;
  const h3 = units && ratioT(units, 'cost', opts);
  const h4 = harmGateOf(units, filtered.sets.includes('N'), opts);
  const verdicts = holmVerdicts(byCoding((c) => ({ H1: h1?.[c] ?? null, H2: h2?.[c] ?? null })));
  const attribution = h1 ? attributionOf(verdicts.H1.final.verdict, runs(...attributionPair) ? bothCodings(s, ...attributionPair, opts, firstApplyR) : null) : NOT_RUN;
  const h3Block = h3 && {
    ...h3,
    firstSession: ratioT(units, 'first', opts),
    extra: ratioT(units, 'extra', opts),
    retryVoidedShare: filtered.retryVoided.share,
  };
  return { order: reportOrder(verdicts, h4), verdicts, H1: h1 ?? NOT_RUN, H2: h2 ?? NOT_RUN, H3: h3Block ?? NOT_RUN, H4: h4 ?? NOT_RUN, attribution };
}

function ranks(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) out[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

/** Pearson on average ranks; NaN when either input is constant. */
export function spearman(xs, ys) {
  const [rx, ry] = [ranks(xs), ranks(ys)];
  const [mx, my] = [mean(rx), mean(ry)];
  let [sxy, sxx, syy] = [0, 0, 0];
  for (let i = 0; i < rx.length; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my);
    sxx += (rx[i] - mx) ** 2;
    syy += (ry[i] - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? Number.NaN : sxy / Math.sqrt(sxx * syy);
}

/** Per family, the H1 pair's difference (mean over seeds) against mean wordOverlap; families are the resampled blocks. */
function overlapCorrelation(s, opts, coding) {
  const h1Pair = pairOf(opts.design ?? DESIGNS.r3, 'H1');
  const overlap = new Map();
  for (const r of s) {
    if (h1Pair.includes(r.arm) && r.set === 'R' && r.wordOverlap !== undefined) overlap.set(r.familyId, [...(overlap.get(r.familyId) ?? []), r.wordOverlap]);
  }
  const fams = new Map();
  for (const u of repeatMistakeUnits(s, ...h1Pair, coding, firstApplyR).units) {
    if (overlap.has(u.family)) fams.set(u.family, { repo: u.repo, family: u.family, diffs: [...(fams.get(u.family)?.diffs ?? []), u.value] });
  }
  const units = [...fams.values()].map((f) => ({ repo: f.repo, family: f.family, diff: mean(f.diffs), overlap: mean(overlap.get(f.family)) }));
  const e = twoLevelBootstrap(blocks(units), (us) => spearman(us.map((u) => u.diff), us.map((u) => u.overlap)), { ...opts, nullValue: 0 });
  return Number.isNaN(e.estimate) ? NA : e;
}

function perArm(s, arms, prices, opts) {
  return Object.fromEntries(arms.map((arm) => {
    const mine = s.filter((r) => r.arm === arm);
    const units = mine.map((r) => ({ repo: r.repo, family: familyOf(r), resolved: r.resolved ? 1 : 0, cost: costOf(r, prices, opts) }));
    const stale = mine.filter((r) => r.afterReversal === true)
      .flatMap((r) => r.lessons.filter((l) => l.staleFollow !== null).map((l) => ({ repo: r.repo, family: familyOf(r), stale: l.staleFollow ? 1 : 0 })));
    const boot = (us, stat) => (us.length === 0 ? NA : twoLevelBootstrap(blocks(us), stat, { ...opts, nullValue: 0 }));
    return [arm, {
      tasks: mine.length,
      resolveRate: boot(units, (us) => mean(us.map((u) => u.resolved))),
      costPerResolved: units.some((u) => Number.isNaN(u.cost)) ? NA : boot(units, (us) => sum(us.map((u) => u.cost)) / sum(us.map((u) => u.resolved))),
      staleFollow: boot(stale, (us) => mean(us.map((u) => u.stale))),
    }];
  }));
}

/** Rank of each record's `order` among the arms at its (sequence, seed, position): E1's rotation slot, 1..k. */
export function rotationSlots(records) {
  const orders = new Map();
  for (const r of records) orders.set(positionKey(r), [...(orders.get(positionKey(r)) ?? []), r.order]);
  for (const v of orders.values()) v.sort((a, b) => a - b);
  return (r) => orders.get(positionKey(r)).indexOf(r.order) + 1;
}

function slotTable(records, s, prices, opts) {
  const slotOf = rotationSlots(records);
  const cells = new Map();
  for (const r of s) {
    const key = `${r.arm}/${slotOf(r)}`;
    const cell = cells.get(key) ?? { arm: r.arm, slot: slotOf(r), n: 0, fails: [], costs: [] };
    cell.n++;
    const f = shareFail(r, 'violation');
    if (f !== null) cell.fails.push(f);
    const cost = costOf(r, prices, opts);
    if (!Number.isNaN(cost)) cell.costs.push(cost);
    cells.set(key, cell);
  }
  const avg = (xs) => (xs.length === 0 ? null : mean(xs));
  return [...cells.values()].sort((a, b) => a.arm.localeCompare(b.arm) || a.slot - b.slot)
    .map((c) => ({ arm: c.arm, slot: c.slot, n: c.n, firstFailRate: avg(c.fails), meanCost: avg(c.costs) }));
}

/** Memory-failure chain per family and arm (178-184); `followed` is read only where `shown` is true. */
function chainRates(s) {
  const cells = new Map();
  for (const r of s) {
    if (!r.chain) continue;
    const key = `${r.familyId}/${r.arm}`;
    const cell = cells.get(key) ?? { familyId: r.familyId, arm: r.arm, stored: [], shown: [], followed: [], captured: [] };
    for (const k of ['stored', 'shown', 'captured']) if (r.chain[k] !== null) cell[k].push(r.chain[k] ? 1 : 0);
    if (r.chain.shown === true && r.chain.followed !== null) cell.followed.push(r.chain.followed ? 1 : 0);
    cells.set(key, cell);
  }
  const rate = (xs) => ({ n: xs.length, rate: xs.length === 0 ? null : mean(xs) });
  return [...cells.values()].map((c) => ({ familyId: c.familyId, arm: c.arm, stored: rate(c.stored), shown: rate(c.shown), followed: rate(c.followed), captured: rate(c.captured) }));
}

export const SINCE_TEACH = [
  ['0-1', (r) => r.afterReversal === true && r.tasksSinceTeach <= 1],
  ['2-4', (r) => r.tasksSinceTeach >= 2 && r.tasksSinceTeach <= 4],
  ['5-9', (r) => r.tasksSinceTeach >= 5 && r.tasksSinceTeach <= 9],
  ['10+', (r) => r.tasksSinceTeach >= 10],
];

/** One arm's own repeat-mistake rate, unpaired and over all its seeds; a unit is a (repo, family, seed) mean, as in H1. */
export function armRate(s, arm, coding, keep, opts) {
  const groups = new Map();
  for (const r of s) {
    const f = r.arm === arm && r.kind === 'apply' && keep(r) ? shareFail(r, coding) : null;
    if (f === null) continue;
    const key = JSON.stringify([r.repo, r.familyId, r.seed]);
    const g = groups.get(key) ?? { repo: r.repo, family: r.familyId, seed: r.seed, fails: [] };
    g.fails.push(f);
    groups.set(key, g);
  }
  const units = [...groups.values()].map((g) => ({ repo: g.repo, family: g.family, seed: g.seed, value: mean(g.fails) }));
  return units.length === 0 ? NA : { ...repeatT(units, opts), units: units.length };
}

/** Prereg 198 asks for the rate itself by tasks since teach; the A2-minus-A1 difference sits beside it in `bySinceTeach`.
 * Two-seed arms rate fewer seeds (124), so each rate carries the seeds it read. */
function ratesBySinceTeach(s, arms, opts) {
  const rn = arms.filter((a) => ARM_TABLE[a].tool === 'claude-code');
  return Object.fromEntries(SINCE_TEACH.map(([name, inBucket]) => {
    const keep = (r) => r.set === 'R' && inBucket(r);
    return [name, Object.fromEntries(rn.map((arm) => {
      const seeds = [...new Set(s.filter((r) => r.arm === arm && r.kind === 'apply' && keep(r)).map((r) => r.seed))].sort((a, b) => a - b);
      return [arm, { ...byCoding((c) => armRate(s, arm, c, keep, opts)), seeds }];
    }))];
  }));
}

/** Estimates outside the family (190-199), each with a CI and no verdict; `records` are the raw ones, for rotation slots. */
export function computeReported(records, filtered, prices, opts) {
  const s = filtered.scored;
  const runs = plannedArms(filtered);
  const design = opts.design ?? DESIGNS.r3;
  const [h1, h2, h3Pair, a1vA0, a4vA1, x2vX1] = ['H1', 'H2', 'H3', 'A1vA0', 'A4vA1', 'X2vX1'].map((name) => pairOf(design, name));
  const pair = (rs, arms, keep) => (runs(...arms) ? bothCodings(rs, ...arms, opts, keep) : NOT_RUN);
  const h3 = (rs, keep) => (runs(...h3Pair) ? ratioT(taskUnits(rs, ...h3Pair, prices, keep, opts), 'cost', opts) : NOT_RUN);
  const noUnion = withoutRuns(s, filtered.carryUnion);
  return {
    A1vA0: pair(s, a1vA0, firstApplyR),
    A4vA1: pair(s, a4vA1, firstApplyR),
    X2vX1: pair(s, x2vX1, codexApply),
    perArm: perArm(s, filtered.arms, prices, opts),
    maintainerOnly: {
      H1: pair(s, h1, (r) => firstApplyR(r) && maintainer(r)),
      H2: pair(s, h2, (r) => codexApply(r) && maintainer(r)),
      H3: h3(s, (r) => inSets('R', 'N')(r) && maintainer(r)),
    },
    allApplies: { H1: pair(s, h1, inSets('R')) },
    bySinceTeach: Object.fromEntries(SINCE_TEACH.map(([name, inBucket]) => [name, pair(s, h1, (r) => r.set === 'R' && inBucket(r))])),
    ratesBySinceTeach: ratesBySinceTeach(s, filtered.arms, opts),
    wordOverlap: runs(...h1) ? byCoding((c) => overlapCorrelation(s, opts, c)) : NOT_RUN,
    sensitivity: {
      carryUnionRuns: filtered.carryUnion.size,
      H1: pair(noUnion, h1, firstApplyR),
      H3: h3(noUnion, inSets('R', 'N')),
      retryVoidedPositions: filtered.retryVoided.positions,
    },
    rotation: slotTable(records, s, prices, opts),
    chain: chainRates(s),
  };
}
