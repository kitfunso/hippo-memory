#!/usr/bin/env node
/** Z0 ledger (round 4 prereg item 12): the dollars a run has spent, from its records, attempts and warm-ups, so a killed session still counts.
 * Exit 0 on a ledger, 1 on bad input (with the usage), 3 on a message the price file cannot price (one `STOP:` line). */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { priceUsage } from '../../dist/eval/eval-stats.js';
import { DESIGNS, designByName, designName } from './arms.mjs';
import { runDirs } from './homes.mjs';
import { listTranscripts, segmentText, sessionFiles } from './records.mjs';
import { modelRow } from './z0-prices.mjs';
import { SPEND_BASIS_SCHEMA, isString } from './z0-records.mjs';

const USAGE = 'usage: z0-ledger.mjs --prices FILE --run DIR [DIR ...] [--pilot-run DIR [DIR ...]] [--design r3|r4] [--unblind] [--spend-basis-out FILE]\n'
  + 'exit 0 pass, 1 bad input, 3 a message the price file cannot price';
const SINGLE = new Map([['--prices', 'prices'], ['--design', 'design'], ['--spend-basis-out', 'spendBasisOut']]);
const LISTS = new Map([['--run', 'run'], ['--pilot-run', 'pilotRun']]);
const KINDS = new Set(['session', 'resume']);
const START = '.start.json';

/** A stop that exits 3, its message already a `STOP:` line. */
class LedgerStop extends Error {}

const subdirs = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []);
const sizeOf = (sizes, configDir, file) => {
  const key = path.relative(configDir, file).split(path.sep).join('/');
  return sizes !== null && Object.hasOwn(sizes, key) ? sizes[key] : undefined;
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}

/** The parse, or undefined for text that is not JSON. */
function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The rows of a JSON-lines file, none when it is missing; half a last line is a kill during its append, so it is no row, and any other bad line stops the read. */
function readJsonLines(file, check) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const last = lines.pop();
  const rows = [];
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    const row = tryParse(line);
    if (row === undefined) throw new Error(`${file}:${i + 1}: not JSON`);
    rows.push(check(row, `${file}:${i + 1}`));
  });
  const tail = last.trim() === '' ? undefined : tryParse(last);
  if (tail !== undefined) rows.push(check(tail, `${file}:${lines.length + 1}`));
  return rows;
}

function checkRecord(row, where) {
  if (!isString(row?.sequence) || !isString(row.arm)) throw new Error(`${where}: a record needs a sequence and an arm`);
  return row;
}

function checkAttempt(row, where) {
  if (!isString(row?.taskId) || !KINDS.has(row.kind) || !Number.isInteger(row.attempt) || !isString(row.sessionId)) {
    throw new Error(`${where}: an attempt needs taskId, kind (session or resume), attempt and sessionId`);
  }
  return row;
}

/** The assistant messages of one segment that carry usage: id (null when absent), model and the four counts. */
function* messagesOf(seg) {
  for (const line of segmentText(seg).split('\n')) {
    const o = line.trim() === '' ? undefined : tryParse(line);
    if (o?.type !== 'assistant' || !o.message?.usage) continue;
    const u = o.message.usage;
    yield { id: o.message.id ?? null, model: o.message.model, counts: [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens, u.output_tokens].map((n) => Number(n) || 0) };
  }
}

function addIds(seen, segments) {
  for (const seg of segments) for (const m of messagesOf(seg)) if (m.id !== null) seen.add(m.id);
}

/** Adds each unseen message of the segments to `pending` once per id, with the largest value of each count, since a streamed message repeats its id. */
function collect(pending, seen, segments) {
  for (const seg of segments) {
    for (const m of messagesOf(seg)) {
      if (m.id !== null && seen.has(m.id)) continue;
      const key = m.id ?? `anon-${pending.size}`;
      const prev = pending.get(key);
      pending.set(key, { id: m.id ?? '(no id)', file: seg.file, model: m.model, counts: prev === undefined ? m.counts : prev.counts.map((p, i) => Math.max(p, m.counts[i])) });
    }
  }
}

/** Dollars for the pending messages, each at its own model's row. */
function priceMessages(pending, rowOf, pricesFile) {
  let usd = 0;
  for (const m of pending.values()) {
    // Four zero counts cost nothing whatever the model says, and a synthetic message has no row.
    if (m.counts.every((n) => n === 0)) continue;
    if (!isString(m.model) || m.model === '') throw new LedgerStop(`STOP: ${m.file}: message ${m.id} has no model, so the ledger cannot price it`);
    const row = rowOf(m.model);
    if (row === null) throw new LedgerStop(`STOP: ${m.file}: message ${m.id} has model ${m.model}, which has no row in ${pricesFile}; add its row from the price page and record it in an amendment (prereg item 7)`);
    usd += priceUsage({ inputTokens: m.counts[0], cacheWriteTokens: m.counts[1], cacheReadTokens: m.counts[2], outputTokens: m.counts[3] }, row);
  }
  return usd;
}

/** One row lookup per model, since `modelRow` rebuilds the table on each call. */
function rowLookup(prices, file) {
  const rows = new Map();
  return (model) => {
    if (!rows.has(model)) rows.set(model, modelRow(prices, model, file));
    return rows.get(model);
  };
}

const rawDir = (cell) => path.join(cell.out, 'raw', cell.sequence, cell.arm, `seed${cell.seed}`);

/** The cells of an out folder: those its records name and those its raw folder holds an attempts file for. */
function cellsOf(out, records) {
  const cells = new Map();
  const cellAt = (sequence, arm, seed) => {
    const id = `${sequence}/${arm}/${seed}`;
    if (!cells.has(id)) cells.set(id, { out, sequence, arm, seed, records: [], configDir: runDirs(out, sequence, arm, seed).claudeConfig });
    return cells.get(id);
  };
  for (const r of records) cellAt(r.sequence, r.arm, r.seed).records.push(r);
  const raw = path.join(out, 'raw');
  for (const sequence of subdirs(raw)) {
    for (const arm of subdirs(path.join(raw, sequence))) {
      for (const dir of subdirs(path.join(raw, sequence, arm))) if (/^seed\d+$/.test(dir)) cellAt(sequence, arm, Number(dir.slice(4)));
    }
  }
  return [...cells.values()];
}

/** The cut-off copies of a cell, each with its attempt.json; a kill between the copy and that file leaves the live files whole, so they price the attempt. */
function copiesOf(cell) {
  const root = path.join(cell.out, 'cutoffs', cell.sequence, cell.arm, `seed${cell.seed}`);
  return subdirs(root).filter((name) => fs.existsSync(path.join(root, name, 'attempt.json')))
    .map((name) => ({ ...readJson(path.join(root, name, 'attempt.json')), configDir: path.join(root, name, 'claude-config') }));
}

/** A cell's attempts grouped by task, each with the attempts its record covers. */
function tasksOf(cell) {
  const attempts = readJsonLines(path.join(rawDir(cell), 'attempts.jsonl'), checkAttempt);
  const copies = copiesOf(cell);
  return [...new Set(attempts.map((a) => a.taskId))].map((taskId) => {
    const byKind = (kind) => attempts.filter((a) => a.taskId === taskId && a.kind === kind).sort((a, b) => a.attempt - b.attempt);
    const [sessions, resumes] = [byKind('session'), byKind('resume')];
    const records = cell.records.filter((r) => r.taskId === taskId);
    const resumed = (r) => (r.resumeSessionId ?? null) !== null;
    // A numeric costUsd is session 1's result plus the resume's, and a null resumeSessionId means no resume finished.
    const covered = [records.some((r) => Number.isFinite(r.costUsd)) ? sessions.at(-1) : undefined, records.some((r) => Number.isFinite(r.costUsd) && resumed(r)) ? resumes.at(-1) : undefined].filter((a) => a !== undefined);
    return { sessions, resumes, covered, copies: copies.filter((c) => c.taskId === taskId), forkId: records.find(resumed)?.resumeSessionId ?? null };
  });
}

/** A session's share of each file ends where a resume of it began. */
function sessionSegments(cell, task, a) {
  const cap = (file) => task.resumes.filter((r) => r.sessionId === a.sessionId).map((r) => sizeOf(r.sizesBefore, cell.configDir, file)).find((n) => n !== undefined);
  return sessionFiles(path.join(cell.configDir, 'projects'), a.sessionId).map((file) => ({ file, toBytes: cap(file) }));
}

/** A resume's share: past sizesBefore in its cut-off copy, else in the live files, plus the new file a forked last resume wrote. */
function resumeSegments(cell, task, a) {
  const projects = path.join(cell.configDir, 'projects');
  const copy = task.copies.find((c) => c.attempt === a.attempt);
  const [configDir, files] = copy === undefined ? [cell.configDir, sessionFiles(projects, a.sessionId)] : [copy.configDir, listTranscripts(path.join(copy.configDir, 'projects'))];
  const sizes = a.sizesBefore ?? copy?.sizesBefore ?? null;
  const own = files.map((file) => ({ file, fromBytes: sizeOf(sizes, configDir, file) ?? 0 }));
  // The attempts line names the resumed id only; a fork's new id is in the record.
  const forked = copy === undefined && a === task.resumes.at(-1) && task.forkId !== null && task.forkId !== a.sessionId;
  return forked ? [...own, ...sessionFiles(projects, task.forkId).map((file) => ({ file }))] : own;
}

const segmentsOf = (cell, task, a) => (a.kind === 'session' ? sessionSegments(cell, task, a) : resumeSegments(cell, task, a));

/** A warm-up's result file adds its total_cost_usd when that is a number; a start file with no such result has its configDir's transcripts priced instead. */
function warmupUsd(out, seen, rowOf, pricesFile) {
  const dir = path.join(out, 'warmups');
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  const results = new Map(names.filter((f) => !f.endsWith(START)).map((f) => [f.slice(0, -'.json'.length), readJson(path.join(dir, f))]));
  const paid = (model) => results.get(model)?.total_cost_usd;
  const pending = new Map();
  for (const f of names.filter((n) => n.endsWith(START))) {
    const model = f.slice(0, -START.length);
    if (Number.isFinite(paid(model))) continue;
    const { configDir } = readJson(path.join(dir, f));
    if (!isString(configDir)) throw new Error(`${path.join(dir, f)}: a start file needs a configDir`);
    collect(pending, seen, listTranscripts(path.join(path.resolve(out, configDir), 'projects')).map((file) => ({ file })));
  }
  return [...results.keys()].map(paid).filter(Number.isFinite).reduce((a, b) => a + b, 0) + priceMessages(pending, rowOf, pricesFile);
}

/** The entries of one out folder (records and priced attempts, each `{ sequence, arm, usd, tool }`) and its warm-up dollars. */
function readOut(out, design, rowOf, pricesFile) {
  if (!fs.existsSync(path.join(out, 'runs.jsonl')) && !fs.existsSync(path.join(out, 'plan.json'))) throw new Error(`${out}: holds no runs.jsonl or plan.json; pass a runner --out folder`);
  const records = readJsonLines(path.join(out, 'runs.jsonl'), checkRecord);
  const entries = records.filter((r) => Number.isFinite(r.costUsd)).map((r) => ({ sequence: r.sequence, arm: r.arm, usd: r.costUsd, tool: r.tool ?? null }));
  // A round 3 folder has no attempts and no warm-up files; its records' costUsd is the whole figure.
  if (design.prices === 'tool') return { entries, warmups: 0 };
  const cells = cellsOf(out, records).map((cell) => ({ cell, tasks: tasksOf(cell) }));
  const seen = new Set();
  for (const { cell, tasks } of cells) for (const t of tasks) for (const a of t.covered) addIds(seen, segmentsOf(cell, t, a));
  for (const { cell, tasks } of cells) {
    const pending = new Map();
    for (const t of tasks) for (const a of [...t.sessions, ...t.resumes]) if (!t.covered.includes(a)) collect(pending, seen, segmentsOf(cell, t, a));
    const usd = priceMessages(pending, rowOf, pricesFile);
    if (usd > 0) entries.push({ sequence: cell.sequence, arm: cell.arm, usd, tool: null });
    for (const key of pending.keys()) seen.add(key);
  }
  return { entries, warmups: warmupUsd(out, seen, rowOf, pricesFile) };
}

function tally(ledger, design, { sequence, arm, usd, tool }) {
  if (!design.arms.includes(arm)) throw new Error(`${sequence}: arm ${arm} is not an arm of design ${designName(design)}; pass the --design the runs used`);
  ledger.spend.set(arm, (ledger.spend.get(arm) ?? 0) + usd);
  const row = ledger.bySequence.get(sequence) ?? new Map();
  row.set(arm, (row.get(arm) ?? 0) + usd);
  ledger.bySequence.set(sequence, row);
  if (tool === 'claude-code') {
    ledger.perRecord.n += 1;
    ledger.perRecord.usd += usd;
  }
}

/** The one reader: `total` over `runs` and `pilotRuns`; `spend`, `bySequence` and `perRecord` over `runs` only, records and attempts, with no warm-up. */
export function readLedger({ runs, pilotRuns = [], prices, design = DESIGNS.r3, pricesFile = 'the price file' }) {
  const rowOf = rowLookup(prices, pricesFile);
  const ledger = { total: 0, spend: new Map(), bySequence: new Map(), perRecord: { n: 0, usd: 0 } };
  for (const [out, inBasis] of [...runs.map((o) => [o, true]), ...pilotRuns.map((o) => [o, false])]) {
    const { entries, warmups } = readOut(out, design, rowOf, pricesFile);
    ledger.total += warmups;
    for (const e of entries) {
      ledger.total += e.usd;
      if (inBasis) tally(ledger, design, e);
    }
  }
  return ledger;
}

const spendOf = (ledger, design) => Object.fromEntries(design.arms.map((a) => [a, ledger.spend.get(a) ?? 0]));

/** The unrounded total over every run and pilot folder, warm-ups included. */
export const ledgerTotal = (options) => readLedger(options).total;

/** Spend by arm over records and attempts of the run folders: no warm-up and no pilot folder (prereg item 4); every arm of the design, 0 where it has none. */
export const spendByArm = ({ runs, prices, design = DESIGNS.r3, pricesFile }) => spendOf(readLedger({ runs, prices, design, pricesFile }), design);

/** The `z0-spend-basis/1` body over the run folders; every sequence row lists every arm of basisByArm, since a reader takes its arms from the first row. */
function basisOf(ledger, design) {
  if (ledger.perRecord.n === 0) throw new Error('--spend-basis-out needs a claude-code record with a costUsd in the --run folders');
  const arms = design.arms.filter((a) => ledger.spend.has(a));
  const row = (byArm) => Object.fromEntries(arms.map((a) => [a, byArm.get(a) ?? 0]));
  return {
    schema: SPEND_BASIS_SCHEMA,
    basisByArm: row(ledger.spend),
    bySequence: Object.fromEntries([...ledger.bySequence].map(([sequence, byArm]) => [sequence, row(byArm)])),
    meanPerRecord: ledger.perRecord.usd / ledger.perRecord.n,
  };
}

function parseArgs(argv) {
  const args = { prices: null, design: 'r3', spendBasisOut: null, run: [], pilotRun: [], unblind: false };
  const given = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--unblind') {
      args.unblind = true;
    } else if (LISTS.has(flag)) {
      // One flag takes every folder up to the next flag, and may repeat.
      const start = i + 1;
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) i++;
      if (i < start) throw new Error(`${flag} needs a folder`);
      args[LISTS.get(flag)].push(...argv.slice(start, i + 1));
    } else if (SINGLE.has(flag)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      if (given.has(flag)) throw new Error(`${flag} given twice`);
      given.add(flag);
      args[SINGLE.get(flag)] = value;
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  if (args.prices === null) throw new Error('--prices is needed');
  if (args.run.length === 0) throw new Error('--run needs at least one out folder');
  if (args.spendBasisOut !== null && !args.unblind) throw new Error('--spend-basis-out needs --unblind: the basis file names arms');
  return args;
}

/** The whole CLI as a function of argv and cwd, so tests drive it without a child process. */
export function runCli(argv, cwd = process.cwd()) {
  try {
    const args = parseArgs(argv);
    const [design, pricesFile] = [designByName(args.design), path.resolve(cwd, args.prices)];
    const at = (f) => path.resolve(cwd, f);
    const ledger = readLedger({ runs: args.run.map(at), pilotRuns: args.pilotRun.map(at), prices: readJson(pricesFile), design, pricesFile });
    if (args.spendBasisOut !== null) fs.writeFileSync(at(args.spendBasisOut), `${JSON.stringify(basisOf(ledger, design), null, 2)}\n`);
    const spend = args.unblind ? Object.entries(spendOf(ledger, design)).map(([arm, usd]) => `spend ${arm} ${usd.toFixed(2)}\n`) : [];
    return { code: 0, stdout: `${spend.join('')}LEDGER ${ledger.total.toFixed(2)}\n`, stderr: '' };
  } catch (e) {
    if (e instanceof LedgerStop) return { code: 3, stdout: '', stderr: `${e.message}\n` };
    return { code: 1, stdout: '', stderr: `${e.message}\n${USAGE}\n` };
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
