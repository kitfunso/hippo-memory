/** Z0 round 4 cost per solved task (prereg item 3), part (b)'s cell values and the pooled solve difference, plus the cell helpers H3 and H4 share.
 * It imports nothing from z0-hypotheses.mjs, which imports it. */

import { twoLevelBootstrap } from '../../dist/eval/eval-stats.js';
import { pooledComponents } from '../../dist/eval/repository-t.js';
import { DESIGNS, OPUS_MODEL } from './arms.mjs';
import { pairTasks } from './z0-filters.mjs';
import { costOf } from './z0-prices.mjs';

const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const byKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

/** A lesson task's family, or a task with no lesson as a family of one keyed by its task id. */
export const familyOf = (r) => r.familyId ?? `task ${r.taskId}`;

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

/** One cell per (repo, family, seed), so each repository is a family-by-seed table; `make` reduces a cell's units. */
export function cellsOf(units, make) {
  const groups = new Map();
  for (const u of units) {
    const key = JSON.stringify([u.repo, u.family, u.seed]);
    groups.set(key, [...(groups.get(key) ?? []), u]);
  }
  return [...groups.values()].map((us) => ({ repo: us[0].repo, family: us[0].family, seed: us[0].seed, ...make(us) }));
}

// A unit may sum `n` pairs (the sizer folds seeds into one unit); the difference stays per pair.
export const resolveDiff = (us) => (sum(us.map((u) => u.t.resolved)) - sum(us.map((u) => u.c.resolved))) / sum(us.map((u) => u.n ?? 1));

const claudePairs = (records, [armT, armC], keep) => pairTasks(records, armT, armC).filter(({ t, c }) => t.tool === 'claude-code' && c.tool === 'claude-code' && keep(t));
const solved = (r) => (r.resolved ? 1 : 0);
const total = (cells, field) => sum(cells.map((c) => c[field]));

/** Cells `{ repo, family, seed, Ct, Cc, St, Sc }` over the tasks `keep` admits: cost and solves of each side, `rowModel` pricing both at that model's row. */
export function costCells(records, pair, prices, keep, { design, rowModel } = {}) {
  const units = claudePairs(records, pair, keep).map(({ t, c }) => ({
    repo: t.repo, family: familyOf(t), seed: t.seed, Ct: costOf(t, prices, { design, rowModel }), Cc: costOf(c, prices, { design, rowModel }), St: solved(t), Sc: solved(c),
  }));
  return cellsOf(units, (us) => Object.fromEntries(['Ct', 'Cc', 'St', 'Sc'].map((f) => [f, total(us, f)])));
}

/** R = (sum Ct x sum Sc) / (sum Cc x sum St); NaN when either side has no solve. */
export function costSolvedRatio(cells) {
  if (total(cells, 'St') === 0 || total(cells, 'Sc') === 0) return Number.NaN;
  return (total(cells, 'Ct') * total(cells, 'Sc')) / (total(cells, 'Cc') * total(cells, 'St'));
}

/** The linear form of log R, one value per cell; each mean is over all cells, so their pooled mean is 0. */
export function cellValues(cells) {
  const [mCt, mCc, mSt, mSc] = ['Ct', 'Cc', 'St', 'Sc'].map((f) => total(cells, f) / cells.length);
  return cells.map((c) => c.Ct / mCt - c.Cc / mCc - c.St / mSt + c.Sc / mSc);
}

const squaresBy = (cells, key) => {
  const counts = new Map();
  for (const c of cells) counts.set(key(c), (counts.get(key(c)) ?? 0) + 1);
  return sum([...counts.values()].map((n) => n * n));
};

/** Item 3's variance of the pooled cell mean with Satterthwaite df: `varianceOf`'s terms (repository-t.ts:360) with each repository's
 * plain-mean weights times (n_r / N) squared in place of 1 / G squared; null when no repository can be fitted. */
export function weightedVariance(cells, values) {
  const pooled = pooledComponents(cells.map((c, i) => ({ repo: c.repo, family: c.family, seed: c.seed, value: values[i] })));
  if (pooled === null) return null;
  const { F, Q, E, dfF, dfQ, dfE, sBar, kBar } = pooled;
  const n = cells.length;
  const useQ = Q > E;
  const cF = squaresBy(cells, (c) => `${c.repo}/${c.family}`) / (n * n * sBar);
  const cQ = useQ ? squaresBy(cells, (c) => `${c.repo}/${c.seed}`) / (n * n * kBar) : 0;
  const terms = [[cF * F, dfF], [cQ * Q, dfQ], [(1 / n - cF - cQ) * E, dfE]].filter(([x]) => x !== 0);
  const v = sum(terms.map(([x]) => x));
  if (v > 0) return { v, df: (v * v) / sum(terms.map(([x, d]) => (x * x) / d)) };
  return { v: cF * F, df: dfF };
}

/** log R with its standard error and Satterthwaite df, or no estimate when either side has no solve. */
export function costSolvedT(cells) {
  if (total(cells, 'St') === 0 || total(cells, 'Sc') === 0) return { estimate: null, reason: '0 solves' };
  const spread = weightedVariance(cells, cellValues(cells));
  if (spread === null) return { estimate: null, reason: 'no repository can be fitted' };
  const ratio = costSolvedRatio(cells);
  return { estimate: Math.log(ratio), se: Math.sqrt(spread.v), df: spread.df, ratio };
}

/** H3's two-level bootstrap on R, repositories held fixed; a resample with no solve on a side drops. */
export const bootstrapRatio = (cells, opts) => twoLevelBootstrap(blocks(cells), costSolvedRatio, { iterations: opts.iterations, seed: opts.seed, nullValue: 1, fixedRepositories: true });

/** Part (b)'s cell values: `resolveDiff` per cell, as `harmT` builds them, for `fixedRepositoryT`. */
export function partBValues(records, pair, keep) {
  const units = claudePairs(records, pair, keep).map(({ t, c }) => ({ repo: t.repo, family: familyOf(t), seed: t.seed, t: { resolved: solved(t) }, c: { resolved: solved(c) } }));
  return cellsOf(units, (us) => ({ value: resolveDiff(us) }));
}

/** The pooled task-level difference in solves, over paired tasks at the seeds kept. */
export function pooledSolveDiff(records, pair, keep, seeds) {
  const pairs = claudePairs(records, pair, keep).filter(({ t }) => seeds.includes(t.seed));
  return sum(pairs.map(({ t, c }) => solved(t) - solved(c))) / pairs.length;
}

/** r: the arm's usage over the base arm's, both priced at the Opus row, on the tasks both ran. */
export function usageRatio(records, arm, base, prices) {
  const opts = { design: DESIGNS.r4, rowModel: OPUS_MODEL };
  const pairs = pairTasks(records, arm, base);
  return sum(pairs.map(({ t }) => costOf(t, prices, opts))) / sum(pairs.map(({ c }) => costOf(c, prices, opts)));
}
