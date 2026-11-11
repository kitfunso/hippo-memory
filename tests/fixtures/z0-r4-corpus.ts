/** The round 4 corpus row: a layout every since-teach bucket fills, and the folders and argv that feed it to each round 4 CLI; slice R reuses it. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARM_TABLE, DESIGNS } from '../../scripts/token-eval/arms.mjs';
import { runDirs } from '../../scripts/token-eval/homes.mjs';
import { costOf } from '../../scripts/token-eval/z0-prices.mjs';
import { MERGE_SCHEMA } from '../../scripts/token-eval/z0-records.mjs';
import { PRICES_BY_MODEL, jsonl, planOf, wholePlanFiles, type GenOpts, type Generated, type Z0Record } from './z0-gen.js';
import { PRICES4, R4, corpus, loose, raise, workspace } from './z0-r4-read.js';

// Every tasksSinceTeach bucket holds two or more families in each repository, so no rate or pair prints n/a.
export const CORPUS_LAYOUT: NonNullable<GenOpts['layout']> = [
  ['T', 0], ['T', 1], ['N', 0], ['T', 2], ['T', 3], ['A', 0], ['A', 1], ['N', 1], ['A', 2], ['A', 3], ['N', 2],
  ['A', 0], ['A', 1], ['R', 2], ['A', 2], ['R', 3], ['A', 3], ['N', 3], ['A', 1], ['A', 2], ['N', 4], ['A', 3],
];
export const r4Corpus = (): Generated => corpus({ layout: CORPUS_LAYOUT });

export const WHOLE_PLANS = 8;
// Frozen at every level, so one test cannot change it for the next.
export const SPEND_BASIS = Object.freeze({
  schema: 'z0-spend-basis/1', basisByArm: Object.freeze({ A0: 60, A1: 100, A2: 100, A4: 40, A5: 90 }), meanPerRecord: 0.3,
  bySequence: Object.freeze({
    q12: Object.freeze({ A0: 20, A1: 30, A2: 30, A4: 10, A5: 25 }), q145: Object.freeze({ A0: 2, A1: 2, A2: 2, A4: 2, A5: 2 }), q140: Object.freeze({ A0: 10, A1: 12, A2: 12, A4: 6, A5: 12 }),
  }),
});
export const R3_FIGURE = 'A2 vs A5 violation 0.009 [-0.052, 0.070]';
// The power read quotes line 27 of round 3's report.
const R3_UNBLIND = `${Array.from({ length: 26 }, (_, i) => `round 3 line ${i + 1}`).join('\n')}\nattribution: ${R3_FIGURE}\n`;

const sha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const posix = (p: string): string => p.replace(/\\/g, '/');
type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json | undefined };
const writeJson = (file: string, body: Json): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
};

/** `<dir>/<name>` with a runs file, its plan and an off-pin file; returns the read-set line that names them. */
export function runsFolder(dir: string, name: string, records: readonly Z0Record[]): string {
  const folder = path.join(dir, name);
  const [runs, plan, offPin] = [path.join(folder, 'runs.jsonl'), path.join(folder, 'plan.json'), path.join(folder, 'off-pin.json')];
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(runs, jsonl(records));
  fs.writeFileSync(plan, JSON.stringify(planOf(records)));
  fs.writeFileSync(offPin, JSON.stringify({ schema: 'z0-offpin/1', runs: [{ dir: name, file: 'runs.jsonl', sha256: sha(runs) }], voids: [] }));
  return `--runs ${posix(runs)} --plan ${posix(plan)} --off-pin ${posix(offPin)}`;
}

/** A registered folder with the round 4 read files, the whole-plan files, a spend basis, round 3's report, the `b1` runs folder, its merge manifest and `rs1.txt`; `cleanUp` of z0-r4-read.ts removes it. */
export function corpusWorkspace(g: Generated): string {
  const dir = workspace(g, { ...wholePlanFiles(R4, WHOLE_PLANS, CORPUS_LAYOUT), 'spend-basis.json': JSON.stringify(SPEND_BASIS), 'r3-unblind.stdout': R3_UNBLIND });
  const b1 = runsFolder(dir, 'b1', g.records);
  const merge = writeJson(path.join(dir, 'merge.json'), {
    schema: MERGE_SCHEMA, first: { dir: 'b1', file: 'runs.jsonl', sha256: sha(path.join(dir, 'b1', 'runs.jsonl')) }, hashes: [], droppedSeeds: {}, firstRun: { plannedSequenceSeeds: 12, leakedSequenceSeeds: 0 },
  });
  fs.writeFileSync(path.join(dir, 'rs1.txt'), `${b1}\n--merge-manifest ${posix(merge)}\n`);
  return dir;
}

/** `rs2.txt` for the analyzer: the seed ceiling, the corpus raised to it, and the same merge manifest. */
export function raisedReadSet(dir: string, g: Generated, top: number): void {
  const all = runsFolder(dir, 'all', raise(g, top).records);
  fs.writeFileSync(path.join(dir, 'rs2.txt'), `--max-seed ${top}\n${all}\n--merge-manifest ${posix(path.join(dir, 'merge.json'))}\n`);
}

/** A transcript with one assistant message, so the ledger prices a cell at the arm's model; the ledger prices each message id once per folder, so each cell needs its own. */
const transcript = (model: string, id: string): string => `${JSON.stringify({ type: 'assistant', message: { id, model, usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1000 } } })}\n`;

/** `<dir>/out1`: the runs file and one transcript per round 4 arm for rn-repo1 seed 1, each under its own message id, the layout `--ledger-runs` reads. */
export function ledgerFolder(dir: string, records: readonly Z0Record[]): string {
  const out = path.join(dir, 'out1');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'runs.jsonl'), jsonl(records));
  for (const arm of R4.arms) {
    const files = path.join(runDirs(out, 'rn-repo1', arm, 1).claudeConfig, 'projects', 'p');
    fs.mkdirSync(files, { recursive: true });
    fs.writeFileSync(path.join(files, 'one.jsonl'), transcript(loose(ARM_TABLE)[arm].model, `m-rn-repo1-${arm}-seed1`));
  }
  return out;
}

// The pilot pieces follow tests/token-eval-z0-r4-pilot.test.ts:15-124, which keeps its own copy private.
interface Dressed extends Z0Record { model: string; costUsd: number | null; envKeys: string[]; hookCancels: Record<string, number> }
const PILOT_ARMS = ['O1', 'S1', 'S2'];
const FIRST = 'rn-repo1-t3';
const SECOND = 'rn-repo1-t5';
const PINS = { batch1Keys: 'q12,q145,q140', batch2Keys: 'qa,qb', wholeRunSeeds: '5', claudeVersion: '2.1.288', effort: 'medium' };

const priced = (r: Dressed): Dressed => ({ ...r, costUsd: r.usage === null ? null : costOf(r, PRICES_BY_MODEL, { design: DESIGNS.r4, rowModel: r.model }) });
const dress = (r: Z0Record): Dressed => priced({ ...r, model: loose(ARM_TABLE)[r.arm].model, envKeys: ['PATH', 'HOME', 'PIP_CONSTRAINT', 'VIRTUAL_ENV'], surfaceRestored: true, hookCancels: {}, costUsd: null });
const withOutput = (r: Dressed, tokens: number): Dressed => priced({
  ...r, usage: r.usage === null ? null : { firstSession: { ...r.usage.firstSession, outputTokens: tokens }, extra: { ...r.usage.extra, outputTokens: 0 } },
});

/** A pilot or effort folder: its runs, plan and an off-pin file bound to the pins file it ran under. */
function pilotFolder(root: string, name: string, records: readonly Dressed[], pins: string): string {
  const folder = path.join(root, name);
  const [runs, plan, offPin] = [path.join(folder, 'runs.jsonl'), path.join(folder, 'plan.json'), path.join(folder, 'off-pin.json')];
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(runs, `${jsonl(records)}\n`);
  fs.writeFileSync(plan, JSON.stringify(planOf(records)));
  writeJson(offPin, { schema: 'z0-offpin/1', runs: [{ dir: folder, file: 'runs.jsonl', sha256: sha(runs) }], pins: { file: pins, sha256: sha(pins) }, planOf: { file: plan, sha256: sha(plan) }, voids: [], envOutside: [] });
  return folder;
}

const tasksFile = (id: string, ids: readonly string[], venvCheck?: Json) => ({ sequences: [{ id, cluster: 'c', repo: 'r', tasks: ids.map((t) => ({ id: t })) }], venvCheck });

/** One venv file per arm and task: the first task installs the package and imports it, the second does neither, each in its own prefix. */
function venvFiles(first: string, arm: string): void {
  const put = (task: string, position: number, lines: readonly string[]): void => {
    const file = path.join(first, 'raw', 'rn-repo1', arm, 'seed1', `${task}.venv.txt`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${[`prefix=${path.join(first, 'runs', 'rn-repo1', arm, 'seed1', 'venv', String(position))}`, ...lines].join('\n')}\n`);
  };
  put(FIRST, 3, ['packages=pip,six', 'import_six=ok', 'packages_end=pip,six']);
  put(SECOND, 5, ['packages=pip', 'import_six=fail', 'packages_end=pip']);
}

/** Builds `<dir>/pilot` from the corpus's seed 1 records of O1, S1 and S2 and returns the `z0-pilot` argv; the pilot has no `--design`. */
export function pilotArgv(dir: string, g: Generated): string[] {
  const root = path.join(dir, 'pilot');
  const seed1 = g.records.filter((r) => r.seed === 1 && PILOT_ARMS.includes(r.arm)).map(dress);
  const sequenceOf = (n: number): Dressed[] => seed1.filter((r) => r.sequence === `rn-repo${n}`);
  const effort = (tokens: number): Dressed[] => seed1.filter((r) => r.sequence === 'rn-repo1' && r.position === 0 && r.arm !== 'S2').map((r) => withOutput(r, tokens));
  const pinsAt = (file: string, level: string): string => writeJson(path.join(root, file), { ...PINS, effort: level });
  const [pins, pinsLow, pinsHigh] = [pinsAt('pins-r4.json', 'medium'), pinsAt('pins-r4-effort-low.json', 'low'), pinsAt('pins-r4-effort-high.json', 'high')];
  const [first, second] = [pilotFolder(root, 'pilot/rn-repo1-p1', sequenceOf(1), pins), pilotFolder(root, 'pilot/rn-repo2-p1', sequenceOf(2), pins)];
  const [low, high] = [pilotFolder(root, 'effort/low-p1', effort(1000), pinsLow), pilotFolder(root, 'effort/high-p1', effort(4000), pinsHigh)];
  const folders = [first, second];
  const ids = (n: number): string[] => sequenceOf(n).filter((r) => r.arm === 'O1').map((r) => r.taskId);
  const tasks = path.join(root, 'pilot-tasks');
  writeJson(path.join(tasks, 'rn-repo1', 'tasks-run.json'), tasksFile('rn-repo1', ids(1), { sequence: 'rn-repo1', first: FIRST, second: SECOND, package: 'six', version: '1.17.0' }));
  writeJson(path.join(tasks, 'rn-repo2', 'tasks-run.json'), tasksFile('rn-repo2', ids(2)));
  writeJson(path.join(tasks, 'effort', 'tasks-run.json'), tasksFile('effort', ['effort-t0']));
  for (const arm of PILOT_ARMS) venvFiles(first, arm);
  return [...folders.flatMap((f) => ['--runs', path.join(f, 'runs.jsonl'), '--plan', path.join(f, 'plan.json')]), '--effort-run', `low:${low}`, '--effort-run', `high:${high}`,
    ...[...folders, low, high].flatMap((f) => ['--off-pin', path.join(f, 'off-pin.json')]),
    '--prices', writeJson(path.join(root, 'prices.json'), PRICES4), '--spend-basis', writeJson(path.join(root, 'spend-basis.json'), SPEND_BASIS), '--pilot-tasks', tasks, '--pins', pins,
    '--ledger-total', '40', '--pilot-spend', '36.5', '--attempt', '1', '--tag', 'z0-r4-freeze-1', '--out', path.join(root, 'pilot.json')];
}
