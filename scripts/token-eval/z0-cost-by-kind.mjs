#!/usr/bin/env node
/** Z0 round 3 cost split by task kind: reruns the frozen analyzer's cost ratio on teach, first apply, later apply and set N tasks, for seven arm pairs.
 * Free and local, no model call. The analyzer files and every input are sha256-checked against the report round 3 wrote.
 * Exit 0 on a clean read, 1 on bad input, a changed file or a self-check miss. */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isString } from './z0-records.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_REPORT = 'C:/z0-runs/scored/r3-final/unblind.json';
export const DEFAULT_GRADING = path.resolve(REPO, 'docs/evals/z0-r3/grading.json');
export const DEFAULT_DROP_LIST = path.resolve(REPO, 'docs/evals/z0-r3/drop-list.json');
const USAGE = 'usage: z0-cost-by-kind.mjs --analyzer DIR [--report FILE] [--grading FILE] [--drop-list FILE] [--json]';
const VALUE_FLAGS = { '--analyzer': ['analyzer', 'folder'], '--report': ['report', 'file'], '--grading': ['grading', 'file'], '--drop-list': ['dropList', 'file'] };
const REBUILD = 'check out 04835462b at --analyzer, then run npm ci and npm run build there';
const RESTORE = 'restore the file round 3 read, or pass the report that matches your files';
const FIELDS = ['estimate', 'low', 'high', 'se', 'df', 'p'];
const ALL_KIND = 'sets R+N';
const NA = 'n/a';

// taskUnits' keep reads the hippo-arm task only, so checkAgreement vouches for the control side.
export const KINDS = {
  teach: (r) => r.set === 'R' && r.kind === 'teach',
  'first apply': (r) => r.set === 'R' && r.kind === 'apply' && r.applyIndex === 1,
  'later apply': (r) => r.set === 'R' && r.kind === 'apply' && r.applyIndex > 1,
  'set N': (r) => r.set === 'N',
};

// A0 and A4 are two-seed arms, so pairTasks keeps seeds 1-2 for them; A2 and A5 get the same cells through a keep that adds seed <= 2.
export const PAIRS = [
  ['A2', 'A1', 'all'],
  ['A5', 'A1', 'all'],
  ['A2', 'A5', 'all'],
  ['A4', 'A1', 's1-2'],
  ['A0', 'A1', 's1-2'],
  ['A2', 'A1', 's1-2'],
  ['A5', 'A1', 's1-2'],
];

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
// A missing or NaN field stays visible as null; a 0 would read as a result.
const num = (x) => (Number.isFinite(x) ? x : null);
const isRecord = (v) => v !== undefined && v !== null && v.constructor === Object;
const pick = (e) => Object.fromEntries(FIELDS.map((k) => [k, e[k]]));

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function checkSources(analyzer, hashes) {
  const sources = hashes.filter((h) => h.role === 'source');
  if (sources.length === 0) throw new Error('the report lists no source hashes; pass the unblind.json round 3 wrote with --report');
  for (const { file, sha256 } of sources) {
    const full = path.join(analyzer, file);
    if (!fs.existsSync(full)) throw new Error(`${file} is missing under --analyzer ${analyzer} (the report recorded ${sha256}); ${REBUILD}`);
    const got = sha256File(full);
    if (got !== sha256) throw new Error(`${file} under --analyzer ${analyzer} has sha256 ${got}, the report recorded ${sha256}; ${REBUILD}`);
  }
  return sources.length;
}

function checkedFile(label, file, recorded, fix) {
  if (!fs.existsSync(file)) throw new Error(`${label} ${file} is missing (the report recorded ${recorded}); ${fix}`);
  const got = sha256File(file);
  if (got !== recorded) throw new Error(`${label} ${file} has sha256 ${got}, the report recorded ${recorded}; ${fix}`);
  return file;
}

function listed(hashes, role, exactlyOne) {
  const found = hashes.filter((h) => h.role === role);
  if (exactlyOne ? found.length !== 1 : found.length === 0) throw new Error(`the report lists ${found.length} ${role} hashes; pass the unblind.json round 3 wrote with --report`);
  return found;
}

// The report's grading and drop-list paths point at a deleted worktree, so those two come from the flags.
export function inputArgs(hashes, files) {
  const own = (role, label) => listed(hashes, role, false).map((h) => checkedFile(label, h.file, h.sha256, RESTORE));
  const [prices] = listed(hashes, 'prices', true);
  const [grading] = listed(hashes, 'grading', true);
  const [dropList] = listed(hashes, 'drop-list', true);
  return {
    runs: own('runs', 'runs file'),
    plan: own('plan', 'plan file'),
    prices: checkedFile('prices file', prices.file, prices.sha256, RESTORE),
    grading: checkedFile('--grading', files.grading, grading.sha256, 'pass the grading file round 3 read (docs/evals/z0-r3/grading.json)'),
    dropList: checkedFile('--drop-list', files.dropList, dropList.sha256, 'pass the drop list round 3 read (docs/evals/z0-r3/drop-list.json)'),
    key: null,
    out: null,
    seed: null,
    iterations: null,
    unblind: false,
    help: false,
  };
}

// Exact on purpose: the same code on the same inputs gives the same doubles.
export function fieldsOff(got, want) {
  return FIELDS.filter((k) => got[k] !== want[k]);
}

function miss(subject, got, want, off, advice) {
  const lines = off.map((k) => `  ${k}: got ${got[k]}, want ${want[k]}`);
  return new Error(`${subject} differs from the report in ${off.join(', ')} (node ${process.version}):\n${lines.join('\n')}\n${advice}`);
}

const SELF_CHECK_ADVICE = 'every file matched its hash, so the cause is another Node version (a last-digit difference) or a changed call in this script (the filterRecords options or the prices key)';
const CELL_ADVICE = 'the self-check matched, so the cell code in this script (rowOf) differs from the analyzer call it copies; report this rather than rerun';

function compare(name, got, want) {
  if (!isRecord(want)) throw new Error(`the report has no ${name} block; pass an unblinded report (unblind.json) with --report`);
  const off = fieldsOff(got, want);
  if (off.length > 0) throw miss(`self-check ${name}`, got, want, off, SELF_CHECK_ADVICE);
  return pick(got);
}

// H3 and H4 pin the call path (filters, prices, harmT) to round 3 before any new cell is read.
export function selfCheck(api, f, prices, report) {
  const units = (keep) => api.taskUnits(f.scored, 'A2', 'A1', prices, keep);
  const rn = api.inSets('R', 'N');
  const h4 = api.harmT(units(api.inSets('N')), {});
  const want4 = report.hypotheses?.H4;
  return {
    H3: compare('H3', api.ratioT(units(rn), 'cost', {}), report.hypotheses?.H3),
    maintainerOnlyH3: compare('maintainer-only H3', api.ratioT(units((r) => rn(r) && api.maintainer(r)), 'cost', {}), report.reported?.maintainerOnly?.H3),
    H4: {
      costRatio: compare('H4 cost ratio', h4.costRatio, want4?.costRatio),
      resolveDiff: compare('H4 resolve difference', h4.resolveDiff, want4?.resolveDiff),
    },
  };
}

const UNCUT = 'the scored records cannot be cut by kind, so report this rather than rerun';

function checkAgreement(api, scored, armT, armC) {
  for (const { t, c } of api.pairTasks(scored, armT, armC)) {
    const off = ['set', 'kind', 'applyIndex'].find((k) => t[k] !== c[k]);
    if (off !== undefined) throw new Error(`${armT}/${armC} at ${t.sequence} seed ${t.seed} position ${t.position}: ${armT} has ${off} ${t[off]} and ${armC} has ${c[off]}, so a kind filter would read one arm only; ${UNCUT}`);
  }
}

function rowOf(api, f, prices, [armT, armC, seeds], kind, keep) {
  const within = seeds === 's1-2' ? (r) => r.seed <= 2 && keep(r) : keep;
  const units = api.taskUnits(f.scored, armT, armC, prices, within);
  const h = api.harmT(units, {});
  const [dollarsT, dollarsC] = [sum(units.map((u) => u.t.cost)), sum(units.map((u) => u.c.cost))];
  const { costRatio: c, resolveDiff: d } = h;
  return {
    pair: `${armT}/${armC}`, seeds, kind, units: units.length,
    ratio: num(c.estimate), low: num(c.low), high: num(c.high), p: num(c.p), se: num(c.se), df: num(c.df),
    dollarsT: num(dollarsT), dollarsC: num(dollarsC), dollarsDiff: num(dollarsT - dollarsC),
    resolve: { estimate: num(d.estimate), low: num(d.low), high: num(d.high), p: num(d.p) },
  };
}

export function costByKind(api, f, prices) {
  const planned = new Set(f.arms);
  const rows = [];
  for (const pair of PAIRS.filter(([t, c]) => planned.has(t) && planned.has(c))) {
    checkAgreement(api, f.scored, pair[0], pair[1]);
    const whole = rowOf(api, f, prices, pair, ALL_KIND, api.inSets('R', 'N'));
    const parts = Object.entries(KINDS).map(([kind, keep]) => rowOf(api, f, prices, pair, kind, keep));
    const held = sum(parts.map((r) => r.units));
    if (held !== whole.units) throw new Error(`${whole.pair} ${pair[2]}: the four kinds hold ${held} units and ${ALL_KIND} holds ${whole.units}, so a task sits outside every kind; ${UNCUT}`);
    rows.push(whole, ...parts);
  }
  return rows;
}

const asEstimate = (r) => ({ estimate: r.ratio, low: r.low, high: r.high, se: r.se, df: r.df, p: r.p });

// Puts rowOf under round 3's numbers: the whole-set row is H3 and the set N row is H4's cost ratio.
export function checkCells(rows, checks) {
  const cases = [[ALL_KIND, 'H3', checks.H3], ['set N', 'H4 cost ratio', checks.H4.costRatio]];
  for (const [kind, name, want] of cases) {
    const row = rows.find((r) => r.pair === 'A2/A1' && r.seeds === 'all' && r.kind === kind);
    if (row === undefined) throw new Error(`no A2/A1 all-seed ${kind} cell to hold against round 3's ${name}; the plan must hold arms A1 and A2`);
    const got = asEstimate(row);
    const off = fieldsOff(got, want);
    if (off.length > 0) throw miss(`cell A2/A1 all ${kind} against ${name}`, got, want, off, CELL_ADVICE);
  }
}

function gitLabel(root) {
  const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // A label only: the source hashes are the gate, so a folder without git history still reads.
  let sha;
  try {
    sha = git(['rev-parse', '--short', 'HEAD']);
  } catch {
    return { sha: 'not a git checkout', clean: null };
  }
  try {
    return { sha, clean: git(['status', '--porcelain']) === '' };
  } catch {
    // The sha still names the code, so only the clean flag is lost.
    return { sha, clean: null };
  }
}

async function importApi(analyzer) {
  const load = (name) => import(pathToFileURL(path.join(analyzer, 'scripts/token-eval', `${name}.mjs`)).href);
  try {
    const [analyze, filters, hypotheses] = await Promise.all([load('z0-analyze'), load('z0-filters'), load('z0-hypotheses')]);
    const { loadInputs } = analyze;
    const { filterRecords, pairTasks } = filters;
    const { taskUnits, ratioT, harmT, inSets, maintainer } = hypotheses;
    return { loadInputs, filterRecords, pairTasks, taskUnits, ratioT, harmT, inSets, maintainer };
  } catch (e) {
    throw new Error(`cannot load the analyzer modules under --analyzer ${analyzer} (${e.message}); ${REBUILD}`);
  }
}

function readReport(file) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read --report ${file} (${e.message}); pass the unblind.json round 3 wrote`);
  }
  if (!Array.isArray(report?.hashes)) throw new Error(`--report ${file} has no hashes list; pass the unblind.json round 3 wrote`);
  return report;
}

// The one way into a frozen round 3 read: it returns only after every hash matches and H3 and H4 come out exact.
export async function openFrozenRead(args) {
  const analyzer = path.resolve(args.analyzer);
  if (!fs.existsSync(analyzer) || !fs.statSync(analyzer).isDirectory()) throw new Error(`no folder at --analyzer ${analyzer}; pass the root of a built checkout of 04835462b`);
  const report = readReport(args.report);
  const sources = checkSources(analyzer, report.hashes);
  const analyzerArgs = inputArgs(report.hashes, { grading: args.grading, dropList: args.dropList });
  const api = await importApi(analyzer);
  const inputs = api.loadInputs(analyzerArgs, process.cwd());
  const f = api.filterRecords(inputs.records, inputs.planCells, { grading: inputs.grading, dropList: inputs.dropList });
  const prices = inputs.prices['claude-code'];
  const checks = selfCheck(api, f, prices, report);
  return { analyzer, report, sources, analyzerArgs, api, inputs, f, prices, checks };
}

export async function readCostByKind(args) {
  const { analyzer, sources, analyzerArgs, api, f, prices, checks } = await openFrozenRead(args);
  const rows = costByKind(api, f, prices);
  checkCells(rows, checks);
  return {
    analyzer: { root: analyzer, ...gitLabel(analyzer), node: process.version, sources },
    report: path.resolve(args.report),
    inputs: { runs: analyzerArgs.runs.length, plan: analyzerArgs.plan.length, matched: true },
    selfCheck: { exact: true, ...checks },
    exploratory: { cells: rows.length, note: 'p not adjusted' },
    rows,
  };
}

const fixed = (x, digits) => (Number.isFinite(x) ? x.toFixed(digits) : NA);
// A value that rounds to zero prints unsigned, so noise never reads as a direction.
const signed = (x, digits) => {
  if (!Number.isFinite(x)) return NA;
  const text = x.toFixed(digits);
  return Number(text) === 0 ? (0).toFixed(digits) : `${x >= 0 ? '+' : ''}${text}`;
};
// A value that rounds to 1.000 but is not 1 gets a fourth digit; within 0.00005 of 1 that is still 1.0000.
const ratio = (x) => (Number.isFinite(x) && x !== 1 && x.toFixed(3) === '1.000' ? x.toFixed(4) : fixed(x, 3));
// 0.000 would read as exactly zero, so a p under 0.0005 prints as a bound.
const pValue = (x) => (Number.isFinite(x) && x < 0.0005 ? '<0.001' : fixed(x, 3));
const line = (e) => `${ratio(e.estimate)} [${ratio(e.low)}, ${ratio(e.high)}]`;
const COLUMNS = [['pair', 6], ['seeds', 5], ['kind', 11], ['units', 5], ['ratio', 6], ['low', 6], ['high', 6], ['p', 6], ['$t', 9], ['$c', 9], ['$diff', 9], ['resolve', 7]];
const tableRow = (cells) => cells.map((c, i) => (i < 3 ? String(c).padEnd(COLUMNS[i][1]) : String(c).padStart(COLUMNS[i][1]))).join('  ');

export function formatText(rep) {
  const a = rep.analyzer;
  const state = a.clean === null ? '' : a.clean ? ' clean' : ' dirty';
  const s = rep.selfCheck;
  const lines = [
    `analyzer ${a.sha}${state}, ${a.sources} sources match the report, node ${a.node}`,
    `inputs ${rep.inputs.runs} runs, ${rep.inputs.plan} plans, prices, grading and drop list match the report`,
    `self-check H3 ${line(s.H3)} and maintainer-only H3 ${line(s.maintainerOnlyH3)}: exact`,
    `self-check H4 cost ratio ${line(s.H4.costRatio)} and resolve difference ${signed(s.H4.resolveDiff.estimate, 3)}: exact`,
    `exploratory ${rep.exploratory.cells} cells, ${rep.exploratory.note}`,
    tableRow(COLUMNS.map(([name]) => name)),
  ];
  for (const r of rep.rows) {
    lines.push(tableRow([r.pair, r.seeds, r.kind, r.units, ratio(r.ratio), ratio(r.low), ratio(r.high), pValue(r.p), fixed(r.dollarsT, 2), fixed(r.dollarsC, 2), signed(r.dollarsDiff, 2), signed(r.resolve.estimate, 3)]));
  }
  return `${lines.join('\n')}\n`;
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const args = { analyzer: null, report: DEFAULT_REPORT, grading: DEFAULT_GRADING, dropList: DEFAULT_DROP_LIST, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { ...args, help: true };
    const value = argv[i + 1];
    if (flag === '--json') args.json = true;
    else if (Object.hasOwn(VALUE_FLAGS, flag)) {
      if (!isString(value) || value.startsWith('--')) throw new Error(`${flag} needs a ${VALUE_FLAGS[flag][1]}\n${USAGE}`);
      args[VALUE_FLAGS[flag][0]] = argv[++i];
    } else throw new Error(`unknown flag ${flag}\n${USAGE}`);
  }
  if (args.analyzer === null) throw new Error(`--analyzer is required: the root of a built checkout of 04835462b\n${USAGE}`);
  return args;
}

/** @param {string[]} argv */
export async function runCli(argv) {
  try {
    const args = parseArgs(argv);
    if (args.help) return { code: 0, stdout: `${USAGE}\n`, stderr: '' };
    const rep = await readCostByKind(args);
    return { code: 0, stdout: args.json ? `${JSON.stringify(rep, null, 2)}\n` : formatText(rep), stderr: '' };
  } catch (e) {
    return { code: 1, stdout: '', stderr: `z0-cost-by-kind: ${e.message}\n` };
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = await runCli(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
