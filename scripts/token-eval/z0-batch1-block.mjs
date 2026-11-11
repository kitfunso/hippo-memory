/** Z0 round 4 batch 1 block (prereg items 6 and 8): the gates, spreads and missing shares of batch 1, read blind, and the stops that end the run before batch 2.
 * It prints no estimate, mean, sign or arm code, and counts the off-pin and G3 bars over the whole plan. `z0-size.mjs --batch1-block` runs it. */

import * as path from 'node:path';

import { ARM_TABLE, pairOf } from './arms.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { ITERATIONS, SEED, analyzeZ0, buildReport, renderText } from './z0-analyze.mjs';
import { loadOrCreateKey } from './z0-blind.mjs';
import { cellValues, costCells, partBValues } from './z0-cost-solved.mjs';
import { filterOpts, filteredInput } from './z0-filters.mjs';
import { computeGates } from './z0-gates.mjs';
import { CODINGS, codexApply, firstApplyR, inSets, repeatMistakeUnits, sum, taskUnits } from './z0-hypotheses.mjs';
import { positionKey, runKey } from './z0-records.mjs';
import { spreadComponents } from './z0-size-sim.mjs';
import { missingShare, naRate, plannedCells, repoCount } from './z0-size-r4.mjs';

export const BLOCK_SCHEMA = 'z0-batch1-block/1';
const f3 = (x) => x.toFixed(3);
const f4 = (x) => x.toFixed(4);
const key = (u) => JSON.stringify([u.repo, u.family, u.seed]);

/** `d` of the `n` family units a coding drops, or on which the two codings disagree; units present under either coding make `n`.
 * @param {{repo: string, family: string, seed: number, value: number}[][]} lists */
function codingGap(lists) {
  const maps = lists.map((us) => new Map(us.map((u) => [key(u), u.value])));
  const all = new Set(maps.flatMap((m) => [...m.keys()]));
  return { d: [...all].filter((k) => maps.some((m) => !m.has(k)) || maps[0].get(k) !== maps[1].get(k)).length, n: all.size };
}

/** One line per sized test, in the order T1, T3, H4, T2a, T2b, T2c: the family, seed and residual parts of its cell values with their one-sided upper bounds, and the
 * share of its planned cells missing; T1, T3 and part (c) add the not-applicable rate and the family units the two codings split on. Each line reads the pair as a set,
 * so swapping its two arms leaves it unchanged. @param {any} filtered @param {any[]} planCells @param {any} prices @param {any} design @param {number} bound
 * @param {Set<string>} [dropped] families the plan cells leave out, the design's by default @returns {string[]} */
export function testLines(filtered, planCells, prices, design, bound, dropped = new Set(design.dropFamilies)) {
  const [scored, cells] = [filtered.scored, planCells.filter((c) => !dropped.has(c.familyId))];
  const line = (name, units, planned, extra = '') => {
    const c = spreadComponents(units, bound);
    if (c === null) return `${name}: no repository can be fitted; it needs 2 families and 2 seeds in one`;
    const parts = [['family', c.family, c.upper.family], ['seed', c.sequence, c.upper.sequence], ['residual', c.noise, c.upper.noise]];
    const miss = `${(100 * missingShare(planned, units.length)).toFixed(1)}%`;
    return `${name}: ${parts.map(([label, at, upper]) => `${label} ${f4(at)} (upper ${f4(upper)})`).join(', ')}; missing ${miss} of planned cells${extra}`;
  };
  const repeat = (name) => {
    const pair = pairOf(design, name);
    const keep = ARM_TABLE[pair[0]].tool === 'codex' ? codexApply : firstApplyR;
    const lists = CODINGS.map((c) => repeatMistakeUnits(scored, ...pair, c, keep).units);
    const { d, n } = codingGap(lists);
    return line(name, lists[0], plannedCells(cells, pair, ['R'], 'apply'), `; not applicable ${f3(naRate(scored, ...pair, keep))}; ${d} of ${n} family units`);
  };
  const part = (name) => {
    const pair = pairOf(design, name);
    const keep = inSets('R', 'N');
    const costs = name === 'T2a' ? costCells(scored, pair, prices, keep, { design }) : [];
    const values = cellValues(costs);
    const units = name === 'T2a' ? costs.map((c, i) => ({ repo: c.repo, family: c.family, seed: c.seed, value: values[i] })) : partBValues(scored, pair, keep);
    return line(name, units, plannedCells(cells, pair, ['R', 'N']));
  };
  const pair = pairOf(design, 'H4');
  const harm = taskUnits(scored, ...pair, prices, inSets('N'), { design }).filter((u) => u.t.cost > 0 && u.c.cost > 0).map((u) => ({ repo: u.repo, family: u.family, seed: u.seed, value: Math.log(u.t.cost / u.c.cost) }));
  return [repeat('T1'), repeat('T3'), line('H4', harm, plannedCells(cells, pair, ['N'])), part('T2a'), part('T2b'), repeat('T2c')];
}

/** The stops of a batch, each `{ id, line }`, in the plan's order: a G1 run-level cause, G2, G4, then the off-pin and G3 bars over the whole plan. */
function stopsOf(gates, filtered, whole) {
  const stops = [];
  const g1 = gates.G1;
  const outside = Object.entries(g1.envKeysOutside).map(([name, n]) => `${name} in ${n}`).join(', ');
  const causes = [
    ...(g1.operatorCanaries > 0 ? [`${g1.operatorCanaries} operator canaries`] : []),
    ...(outside === '' ? [] : [`env names outside the allowlist: ${outside}`]),
    ...(g1.anthropicApiKeyRecords > 0 ? [`${g1.anthropicApiKeyRecords} records hold ANTHROPIC_API_KEY`] : []),
  ];
  if (causes.length > 0) stops.push({ id: 'g1-run', line: `STOP: G1 run-level: ${causes.join('; ')}` });
  if (!gates.G2.pass) stops.push({ id: 'g2', line: `STOP: G2 fails (Claude Code half ${gates.G2.claudeCode.status}, Codex half ${gates.G2.codex.status})` });
  if (!gates.G4.pass) stops.push({ id: 'g4', line: `STOP: G4 fails: worst invalid-or-missing share ${(100 * Math.max(...Object.values(gates.G4.perArm).map((a) => a.share))).toFixed(1)}%, gap ${(100 * gates.G4.gap).toFixed(1)} points` });
  const [reach, leaked] = [filtered.offPinVoided.positions, filtered.leaked.length];
  if (reach * 20 > whole.positions) stops.push({ id: 'off-pin', line: `STOP: off-pin voids reach ${reach} of ${whole.positions} planned positions of the whole plan (${(100 * reach / whole.positions).toFixed(1)}%), over 5%` });
  if (leaked * 20 > whole.runs) stops.push({ id: 'g3', line: `STOP: G3 ${leaked} of ${whole.runs} planned (sequence, seed)s of the whole plan leaked, over 5%` });
  return stops;
}

/** The block: blind count and gate lines, the spread lines, the whole plan's denominators and each stop. It writes `{ schema, stops }` to `out` every time.
 * @param {{key: string, out: string, mergeManifests: any[]}} args @param {any} inputs `loadInputs`' result @param {string} cwd @param {{file: string, cells: any[]}[]} wholePlans
 * @returns {{code: number, stdout: string}} */
export function runBlock(args, inputs, cwd, wholePlans) {
  const design = inputs.design;
  const analysis = analyzeZ0(inputs.records, { ...inputs, iterations: ITERATIONS, seed: SEED, unblind: false });
  if (analysis.filtered.abandoned.length > 0) throw new Error(`the batch holds abandoned runs (${analysis.filtered.abandoned.join(', ')}); the block cannot read it (prereg 114)`);
  const read = filteredInput(inputs.records, inputs.planCells, filterOpts(inputs), { dropAbandoned: false });
  const gates = computeGates(read.records, analysis.filtered, inputs.grading, { iterations: ITERATIONS, seed: SEED, design, mergeManifests: args.mergeManifests });
  const codes = loadOrCreateKey(path.resolve(cwd, args.key), analysis.filtered.arms);
  const text = renderText(buildReport({ ...analysis, gates, status: gates.pass ? 'valid' : 'invalid' }, inputs, { iterations: null, seed: null }, codes, []), design).split('\n');
  const dropped = new Set(filterOpts(inputs).dropList?.droppedFamilies ?? []);
  const whole = { positions: sum(wholePlans.map(({ cells }) => new Set(cells.map(positionKey)).size)), runs: sum(wholePlans.map(({ cells }) => new Set(cells.map((c) => runKey(c.sequence, c.seed))).size)) };
  const stops = stopsOf(gates, analysis.filtered, whole);
  const lines = [
    ...text.slice(0, text.findIndex((l) => l.startsWith('G5 ')) + 1),
    ...testLines(analysis.filtered, read.planCells, inputs.prices, design, 0.8, dropped),
    `whole plan: ${wholePlans.length} repositories, ${repoCount(read.planCells)} in batch 1; ${whole.positions} planned positions, ${analysis.filtered.offPinVoided.positions} reached by off-pin voids; ${whole.runs} planned (sequence, seed)s, ${analysis.filtered.leaked.length} leaked`,
    ...stops.map((s) => s.line),
  ];
  writeFileAtomic(path.resolve(cwd, args.out), `${JSON.stringify({ schema: BLOCK_SCHEMA, stops: stops.map((s) => s.id) }, null, 2)}\n`);
  return { code: stops.length > 0 ? 3 : 0, stdout: `${lines.join('\n')}\n` };
}
