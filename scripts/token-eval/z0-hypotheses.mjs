/** Z0 analyzer, part 3 of 6: units, bootstraps, H1-H4, one Holm procedure per coding, attribution, reported estimates.
 * The repeat-mistake rate reads each lesson's `first` verdict only (prereg 151); H3 and H4 read Claude Code records only. */

import { addUsage, combineCodings, harmGate, holmAdjust, priceUsage, twoLevelBootstrap, verdict } from '../../dist/eval-stats.js';
import { pairTasks } from './z0-filters.mjs';
import { TWO_SEED_ARMS, positionKey, runKey } from './z0-records.mjs';

export const CODINGS = ['violation', 'excluded'];
export const HYPOTHESES = ['H1', 'H2', 'H3'];
export const NOT_RUN = 'not run';
export const NA = 'n/a';
const REPEAT_SPEC = { helpful: 'lower', tieBand: [-0.15, 0.15], minimumEffectAt: -0.15 };
export const SPECS = { H1: REPEAT_SPEC, H2: REPEAT_SPEC, H3: { helpful: 'lower', tieBand: [0.95, 1 / 0.95], minimumEffectAt: 0.95 } };
export const LESSONS_SENTENCE = "hippo's lessons cut repeat mistakes";
export const BEHAVIOUR_SENTENCE = 'installing hippo changed behaviour, and this run cannot say its lessons did';
export const NO_N_DATA = 'no set N data';

export const sum = (xs) => xs.reduce((s, x) => s + x, 0);
export const mean = (xs) => sum(xs) / xs.length;
export const inSets = (...sets) => (r) => sets.includes(r.set);
export const codexApply = (r) => r.set === 'X' && r.tool === 'codex';
export const maintainer = (r) => r.lessonSource !== 'template';
export const byCoding = (fn) => Object.fromEntries(CODINGS.map((c) => [c, fn(c)]));
const costOf = (r, prices) => priceUsage(addUsage(r.usage.firstSession, r.usage.extra), prices);

/** Share of a task's lessons failed on the first attempt; `na` is a fail under `violation` and dropped under `excluded`. */
export function shareFail(r, coding) {
  const lessons = coding === 'excluded' ? r.lessons.filter((l) => l.first !== 'na') : r.lessons;
  if (lessons.length === 0) return null;
  return lessons.filter((l) => l.first !== 'pass').length / lessons.length;
}

const byKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

/** Repository, then family, blocks sorted by key, so the resamples depend on neither a seed rerun nor argv order. */
export function blocks(units) {
  const repos = new Map();
  for (const u of units) {
    const families = repos.get(u.repo) ?? new Map();
    families.set(u.family, [...(families.get(u.family) ?? []), u]);
    repos.set(u.repo, families);
  }
  return [...repos].sort(byKey).map(([, f]) => [...f].sort(byKey).map(([, us]) => us));
}

/** Units are finite by construction, so a dropped resample is a bug, never data. */
export function meanBootstrap(units, opts) {
  const e = twoLevelBootstrap(blocks(units), (us) => mean(us.map((u) => u.value)), { iterations: opts.iterations, seed: opts.seed, nullValue: 0 });
  if (e.dropped > 0) throw new Error(`repeat-mistake bootstrap dropped ${e.dropped} resamples; every unit must be finite`);
  return e;
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
  return { ...meanBootstrap(units, opts), units: units.length, droppedUnits: dropped };
}

export const bothCodings = (scored, armT, armC, opts, keep) => byCoding((c) => repeatMistake(scored, armT, armC, c, opts, keep));

/** One unit per paired Claude Code task; a no-lesson task is a family of one keyed by its task id. */
export function taskUnits(scored, armT, armC, prices, keep) {
  const side = (r) => ({ cost: costOf(r, prices), first: priceUsage(r.usage.firstSession, prices), extra: priceUsage(r.usage.extra, prices), resolved: r.resolved ? 1 : 0 });
  return pairTasks(scored, armT, armC)
    .filter(({ t, c }) => t.tool === 'claude-code' && c.tool === 'claude-code' && keep(t))
    .map(({ t, c }) => ({ repo: t.repo, family: t.familyId ?? `task ${t.taskId}`, set: t.set, t: side(t), c: side(c) }));
}

export const ratioOf = (field) => (us) => sum(us.map((u) => u.t[field])) / sum(us.map((u) => u.c[field]));

export function ratioBootstrap(units, field, opts) {
  return twoLevelBootstrap(blocks(units), ratioOf(field), { iterations: opts.iterations, seed: opts.seed, nullValue: 1 });
}

const resolveDiff = (us) => mean(us.map((u) => u.t.resolved)) - mean(us.map((u) => u.c.resolved));

/** Holm once per coding over (H1, H2, H3), then combine the codings (reading 4); a hypothesis not run enters as NaN. */
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

/** Prereg 148 words a winning H1 two ways, so a tie, loss or inconclusive H1 gets neither sentence (reading 2). */
function attributionOf(h1Verdict, est) {
  if (h1Verdict !== 'win') return { ...est, sentence: null, reason: `not applicable, H1 is ${h1Verdict}` };
  return { ...est, sentence: CODINGS.every((c) => est[c].high < 0) ? LESSONS_SENTENCE : BEHAVIOUR_SENTENCE };
}

/** H4 is "not run" when set N was never planned, and fails when it was planned but filters left no pair: a harm gate needs data to pass. */
function harmGateOf(units, setNPlanned, opts) {
  if (units === null || !setNPlanned) return null;
  const nUnits = units.filter((u) => u.set === 'N');
  if (nUnits.length === 0) return { reason: NO_N_DATA, gate: { pass: false, costOk: false, resolveOk: false } };
  const costRatio = ratioBootstrap(nUnits, 'cost', opts);
  const resolve = twoLevelBootstrap(blocks(nUnits), resolveDiff, { iterations: opts.iterations, seed: opts.seed, nullValue: 0 });
  return { costRatio, resolveDiff: resolve, gate: harmGate(costRatio, resolve) };
}

const plannedArms = (filtered) => {
  const planned = new Set(filtered.arms);
  return (...arms) => arms.every((a) => planned.has(a));
};

/** The primary family, the harm gate and attribution; the caller runs this only when every gate passes. */
export function computeHypotheses(filtered, prices, opts) {
  const s = filtered.scored;
  const runs = plannedArms(filtered);
  const h1 = runs('A1', 'A2') ? bothCodings(s, 'A2', 'A1', opts, inSets('R')) : null;
  const h2 = runs('X2', 'X3') ? bothCodings(s, 'X2', 'X3', opts, codexApply) : null;
  const units = runs('A1', 'A2') ? taskUnits(s, 'A2', 'A1', prices['claude-code'], inSets('R', 'N')) : null;
  const h3 = units && ratioBootstrap(units, 'cost', opts);
  const h4 = harmGateOf(units, filtered.sets.includes('N'), opts);
  const verdicts = holmVerdicts(byCoding((c) => ({ H1: h1?.[c] ?? null, H2: h2?.[c] ?? null, H3: h3 })));
  const attribution = h1 && runs('A5') ? attributionOf(verdicts.H1.final.verdict, bothCodings(s, 'A2', 'A5', opts, inSets('R'))) : NOT_RUN;
  const h3Block = h3 && {
    ...h3,
    firstSession: ratioBootstrap(units, 'first', opts),
    extra: ratioBootstrap(units, 'extra', opts),
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

/** Per family, the A2-minus-A1 difference (mean over seeds) against mean wordOverlap; families are the resampled blocks. */
function overlapCorrelation(s, opts, coding) {
  const overlap = new Map();
  for (const r of s) {
    if ((r.arm === 'A2' || r.arm === 'A1') && r.set === 'R' && r.wordOverlap !== undefined) overlap.set(r.familyId, [...(overlap.get(r.familyId) ?? []), r.wordOverlap]);
  }
  const fams = new Map();
  for (const u of repeatMistakeUnits(s, 'A2', 'A1', coding, inSets('R')).units) {
    if (overlap.has(u.family)) fams.set(u.family, { repo: u.repo, family: u.family, diffs: [...(fams.get(u.family)?.diffs ?? []), u.value] });
  }
  const units = [...fams.values()].map((f) => ({ repo: f.repo, family: f.family, diff: mean(f.diffs), overlap: mean(overlap.get(f.family)) }));
  const e = twoLevelBootstrap(blocks(units), (us) => spearman(us.map((u) => u.diff), us.map((u) => u.overlap)), { ...opts, nullValue: 0 });
  return Number.isNaN(e.estimate) ? NA : e;
}

function perArm(s, arms, prices, opts) {
  return Object.fromEntries(arms.map((arm) => {
    const mine = s.filter((r) => r.arm === arm);
    const family = (r) => r.familyId ?? `task ${r.taskId}`;
    const units = mine.map((r) => ({ repo: r.repo, family: family(r), resolved: r.resolved ? 1 : 0, cost: prices[r.tool] ? costOf(r, prices[r.tool]) : Number.NaN }));
    const stale = mine.filter((r) => r.afterReversal === true)
      .flatMap((r) => r.lessons.filter((l) => l.staleFollow !== null).map((l) => ({ repo: r.repo, family: family(r), stale: l.staleFollow ? 1 : 0 })));
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

function slotTable(records, s, prices) {
  const slotOf = rotationSlots(records);
  const cells = new Map();
  for (const r of s) {
    const key = `${r.arm}/${slotOf(r)}`;
    const cell = cells.get(key) ?? { arm: r.arm, slot: slotOf(r), n: 0, fails: [], costs: [] };
    cell.n++;
    const f = shareFail(r, 'violation');
    if (f !== null) cell.fails.push(f);
    if (prices[r.tool]) cell.costs.push(costOf(r, prices[r.tool]));
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

export const withoutRuns = (records, runs) => records.filter((r) => !runs.has(runKey(r.sequence, r.seed)));

/** One arm's own repeat-mistake rate, unpaired and over all its seeds; a unit is a (repo, family, seed) mean, as in H1. */
export function armRate(s, arm, coding, keep, opts) {
  const groups = new Map();
  for (const r of s) {
    const f = r.arm === arm && r.kind === 'apply' && keep(r) ? shareFail(r, coding) : null;
    if (f === null) continue;
    const key = JSON.stringify([r.repo, r.familyId, r.seed]);
    const g = groups.get(key) ?? { repo: r.repo, family: r.familyId, fails: [] };
    g.fails.push(f);
    groups.set(key, g);
  }
  const units = [...groups.values()].map((g) => ({ repo: g.repo, family: g.family, value: mean(g.fails) }));
  return units.length === 0 ? NA : { ...meanBootstrap(units, opts), units: units.length };
}

/** Prereg 198 asks for the rate itself by tasks since teach; the A2-minus-A1 difference sits beside it in `bySinceTeach`. */
function ratesBySinceTeach(s, arms, opts) {
  const rn = arms.filter((a) => a.startsWith('A'));
  return Object.fromEntries(SINCE_TEACH.map(([name, inBucket]) => [name, Object.fromEntries(rn.map((arm) => [
    arm, byCoding((c) => armRate(s, arm, c, (r) => r.set === 'R' && inBucket(r), opts)),
  ]))]));
}

/** Estimates outside the family (190-199), each with a CI and no verdict; `records` are the raw ones, for rotation slots. */
export function computeReported(records, filtered, prices, opts) {
  const s = filtered.scored;
  const runs = plannedArms(filtered);
  const pair = (rs, t, c, keep) => (runs(t, c) ? bothCodings(rs, t, c, opts, keep) : NOT_RUN);
  const h3 = (rs, keep) => (runs('A1', 'A2') ? ratioBootstrap(taskUnits(rs, 'A2', 'A1', prices['claude-code'], keep), 'cost', opts) : NOT_RUN);
  const setR = inSets('R');
  const noUnion = withoutRuns(s, filtered.carryUnion);
  return {
    A1vA0: pair(s, 'A1', 'A0', setR),
    A4vA1: pair(s, 'A4', 'A1', setR),
    X2vX1: pair(s, 'X2', 'X1', codexApply),
    perArm: perArm(s, filtered.arms, prices, opts),
    maintainerOnly: {
      H1: pair(s, 'A2', 'A1', (r) => setR(r) && maintainer(r)),
      H2: pair(s, 'X2', 'X3', (r) => codexApply(r) && maintainer(r)),
      H3: h3(s, (r) => inSets('R', 'N')(r) && maintainer(r)),
    },
    firstApply: { H1: pair(s, 'A2', 'A1', (r) => setR(r) && r.applyIndex === 1) },
    bySinceTeach: Object.fromEntries(SINCE_TEACH.map(([name, inBucket]) => [name, pair(s, 'A2', 'A1', (r) => setR(r) && inBucket(r))])),
    ratesBySinceTeach: ratesBySinceTeach(s, filtered.arms, opts),
    wordOverlap: runs('A1', 'A2') ? byCoding((c) => overlapCorrelation(s, opts, c)) : NOT_RUN,
    sensitivity: {
      carryUnionRuns: filtered.carryUnion.size,
      H1: pair(noUnion, 'A2', 'A1', setR),
      H3: h3(noUnion, inSets('R', 'N')),
      retryVoidedPositions: filtered.retryVoided.positions,
    },
    rotation: slotTable(records, s, prices),
    chain: chainRates(s),
  };
}
