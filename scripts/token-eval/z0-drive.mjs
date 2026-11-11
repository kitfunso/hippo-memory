#!/usr/bin/env node
/** Z0 round 4 run driver rules (plan: Run steps after the freeze): the order rule, the stop ids, the founder-go and cause rules and the drive-log entry.
 * s4-drive.sh keeps no JSON logic of its own. Exit 0, 1 bad input, 3 a refusal or a stop, with its DRIVE: or STOP: line on stderr. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendJsonLine, readSealed } from './atomic-write.mjs';
import { Stop, parseFlags, parseOrNull, readJson, runCommand, runMain } from './free-cli.mjs';
import { readPins } from './z0-budget.mjs';

export const FREEZE_1 = 'z0-r4-freeze-1';
export const FREEZE_2 = 'z0-r4-freeze-2';

/** One list (plan :406): after an entry with one of these ids the run is over; plans, founder-go, cause and step 8 still run. */
export const TERMINAL_STOPS = ['g1-run', 'g2', 'g4', 'off-pin', 'g3', 't1-power', 'broken-design', 'read-invalid', 'no-version', 'second-failure', 'founder-stop'];
/** Stops the driver logs for a refused call; they say nothing about the step's own outcome, so no outcome lookup reads them. */
export const REFUSALS = ['tag', 'pins', 'order'];

// `logged` is the step that logs the stop and `resumes` the step it holds back: whole-run-r and power-go wait on the step after theirs.
const RESUME_ROWS = {
  'smoke-fit': { question: 'figure', logged: 'smoke', resumes: 'smoke' },
  'pilot-fit': { question: 'figure', logged: '1', resumes: '1' },
  'pilot-40': { question: 'pilot', logged: '1', resumes: '1' },
  'whole-run-figure': { question: 'figure', logged: '2', resumes: '2' },
  'whole-run-r': { question: 'whole-run', logged: '2', resumes: '3' },
  'batch1-fit': { question: 'figure', logged: '3', resumes: '3' },
  'power-go': { question: 'power', logged: '4', resumes: '5' },
  'batch2-figure': { question: 'figure', logged: '5', resumes: '5' },
};
/** Each stop that resumes on a founder go, with the question that go answers. */
export const RESUMES = Object.fromEntries(Object.entries(RESUME_ROWS).map(([id, row]) => [id, row.question]));

const BLOCK_IDS = ['g1-run', 'g2', 'g4', 'off-pin', 'g3'];
const lastWholeRunReason = ({ budgetLog }) => (budgetLog ?? []).filter((e) => e.kind === 'admit' && e.step === 'whole-run').at(-1)?.reason;
const WHOLE_RUN_STOPS = { figure: 'whole-run-figure', r: 'whole-run-r' };

/** The stop id of each (step, command, exit): an `id`, or a `pick` function over the JSON that names the stop under one exit code. */
export const STOP_TABLE = [
  { step: 'smoke', cmd: 'admit', exit: 3, id: 'smoke-fit' },
  { step: 'smoke', cmd: 'g1-pins', exit: 3, id: 'smoke-fail' },
  { step: '1', cmd: 'admit', exit: 3, id: 'pilot-fit' },
  { step: '1', cmd: 'admit', exit: 4, id: 'pilot-40' },
  { step: '1', cmd: 'z0-pilot', exit: 3, id: 'pilot-fail' },
  { step: '2', cmd: 'admit', exit: 4, pick: (ctx) => WHOLE_RUN_STOPS[lastWholeRunReason(ctx)] },
  { step: '3', cmd: 'admit', exit: 3, id: 'batch1-fit' },
  { step: '3', cmd: 'block', exit: 3, pick: ({ block }) => (BLOCK_IDS.includes(block?.stops?.[0]?.id) ? block.stops[0].id : undefined) },
  { step: '3', cmd: 's4-batch', exit: 3, id: 'batch-failed' },
  { step: '3', cmd: 's4-batch', exit: 7, id: 'labels' },
  { step: '4', cmd: 'level-check', exit: 3, id: 'broken-design' },
  { step: '4', cmd: 'power', exit: 3, id: 't1-power' },
  { step: '4', cmd: 'power', exit: 4, id: 'power-go' },
  { step: '5', cmd: 'admit', exit: 5, id: 'batch2-figure' },
  { step: '5', cmd: 's4-batch', exit: 3, id: 'batch-failed' },
  { step: '5', cmd: 's4-batch', exit: 7, id: 'labels' },
  { step: '6', cmd: 'admit', exit: 6, id: 'cap' },
  { step: '6', cmd: 's4-batch', exit: 3, id: 'batch-failed' },
  { step: '6', cmd: 's4-batch', exit: 7, id: 'labels' },
  { step: '7', cmd: 's4-read', exit: 3, id: 'read-invalid' },
  { step: 'cause', cmd: 'cause', exit: 3, pick: ({ kind }) => ({ 'no-version': 'no-version', other: 'second-failure' })[kind] },
];

/** @typedef {{ step: string, attempt: number | null, exit: number, stopId: string | null, line: string | null, tag: string | null, commit: string | null, pinsSha256: string | null,
 *   claudeVersion: string | null, question: string | null, figure: number | null, stop: boolean | null, kind: string | null, failedStep: string | null, spent: string | null }} DriveEntry */

/** The drive-log entry of plan :404 and W4-19, every field present and null where unset.
 * @param {{ step: string | number, exit: number } & Partial<Omit<DriveEntry, 'step' | 'exit'>>} input @returns {DriveEntry} */
export function entryOf(input) {
  const o = input;
  return {
    step: String(o.step), attempt: o.attempt ?? null, exit: o.exit, stopId: o.stopId ?? null, line: o.line ?? null, tag: o.tag ?? null, commit: o.commit ?? null, pinsSha256: o.pinsSha256 ?? null,
    claudeVersion: o.claudeVersion ?? null, question: o.question ?? null, figure: o.figure ?? null, stop: o.stop ?? null, kind: o.kind ?? null, failedStep: o.failedStep ?? null, spent: o.spent ?? null,
  };
}

/** The entries of a JSON-lines log. A last line with no line feed is torn, as `appendJsonLine` treats it, and is skipped; an earlier line that does not parse is bad input.
 * @returns {any[]} */
export function readEntries(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((line, i) => {
    const entry = parseOrNull(line);
    if (entry === null) throw new Error(`${file} line ${i + 1} is not JSON`);
    return entry;
  });
}

/** `smoke` stays as it is and a number reads as `step <n>`, the form of every DRIVE: line. */
export const stepLabel = (step) => (/^\d+$/.test(step) ? `step ${step}` : step);

const isOutcome = (e) => !REFUSALS.includes(e.stopId);

/** The first terminal entry's id and the step it stopped: a cause entry names the step it explained. */
export function terminalOf(entries) {
  const entry = entries.find((e) => TERMINAL_STOPS.includes(e.stopId));
  return entry === undefined ? null : { id: entry.stopId, step: entry.step === 'cause' ? entry.failedStep : entry.step };
}

// A cause entry that failed to log (a fault) explains nothing.
const isCause = (e) => e.step === 'cause' && e.stopId !== 'fault';
const isFailure = (e) => (e.step === 'smoke' || e.step === '1') && (e.stopId === 'smoke-fail' || e.stopId === 'pilot-fail' || (e.spent ?? null) !== null);

/** The last smoke or step 1 failure (a smoke-fail, a pilot-fail or a spent retry) that no cause entry follows.
 * @returns {{ entry: any, index: number } | null} */
export function lastFailure(entries) {
  const index = entries.findLastIndex((e) => isOutcome(e) && isFailure(e));
  if (index < 0 || entries.slice(index + 1).some(isCause)) return null;
  return { entry: entries[index], index };
}

/** What a cause entry decides, as the line to print; an input error when nothing needs explaining, a Stop for the two ends. */
export function causeDecision(entries, kind) {
  const open = lastFailure(entries);
  if (open === null) throw new Error('DRIVE: cause needs a smoke or step 1 failure to explain');
  if (kind === 'no-version') throw new Stop('STOP: no Claude Code version passes the pin checks; no claim');
  if (kind === 'other' && open.entry.tag === FREEZE_2) throw new Stop('STOP: the second pilot failed for another cause; no claim');
  return `cause ${kind} logged for ${stepLabel(open.entry.step)} attempt ${open.entry.attempt ?? 1}`;
}

/** A yes answer to a founder question logged after `index`: exit 0, never a stop answer, and for the pilot question the stop's own attempt. */
function goAfter(entries, index, question, attempt) {
  return entries.slice(index + 1).some((e) => e.step === 'founder-go' && e.exit === 0 && e.question === question && !e.stop && (question !== 'pilot' || e.attempt === attempt));
}

const ORDER = { 2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6' };
// The founder question whose go lets a step follow an exit 4 of the step before it.
const FOLLOWS_EXIT_4 = { 3: 'whole-run', 5: 'power' };
const TERMINAL_REFUSED = new Set(['smoke', '1', '2', '3', '4', '5', '6', '7', 'stage-checks']);

/** @typedef {{ entries: DriveEntry[], step: string, tag: string | null, commit: string | null, pinsSha256: string | null, claudeVersion: string | null, attempt?: number }} GateInput */

/** The refusal rules in their order (plan :404-424): TERMINAL_STOPS, a stop that waits on a founder go, the cause rules, then the order rule.
 * @param {GateInput} input @returns {{ ok: true, line: null } | { ok: false, line: string }} */
export function gate({ entries: all, step, tag, commit, pinsSha256, claudeVersion, attempt = 1 }) {
  const no = (line) => ({ ok: false, line });
  const entries = all.filter(isOutcome);
  const lastOf = (s) => entries.findLast((e) => e.step === s);
  const stopped = terminalOf(entries);
  if (stopped !== null && TERMINAL_REFUSED.has(step)) return no(`DRIVE: the run stopped at ${stopped.id}; no claim`);

  for (const [id, row] of Object.entries(RESUME_ROWS)) {
    if (row.resumes !== step) continue;
    const index = entries.findLastIndex((e) => e.step === row.logged);
    if (index >= 0 && entries[index].stopId === id && !goAfter(entries, index, row.question, entries[index].attempt)) return no(`DRIVE: ${id} needs a ${row.question} go`);
  }

  if (step === 'smoke' || step === '1') {
    const open = lastFailure(entries);
    const shown = stepLabel(step);
    if (open !== null) return no(`DRIVE: ${shown} needs a cause entry after the failure at ${stepLabel(open.entry.step)} attempt ${open.entry.attempt ?? 1}`);
    const failure = entries.findLast(isFailure);
    const causeIndex = entries.findLastIndex((e) => e.step === 'cause' && e.exit === 0);
    const cause = causeIndex < 0 ? null : entries[causeIndex];
    if (cause !== null && failure !== undefined) {
      if (cause.kind === 'version' && failure.claudeVersion === claudeVersion) return no(`DRIVE: a version cause needs a new claudeVersion; pins-r4.json still names ${claudeVersion}`);
      if (cause.kind === 'other' && tag !== FREEZE_2) return no(`DRIVE: an other-cause failure needs ${FREEZE_2}`);
      if (cause.kind === 'other' && !entries.slice(causeIndex + 1).some((e) => e.step === 'stage-checks' && e.exit === 0 && commit !== null && e.commit === commit)) return no(`DRIVE: ${shown} needs stage-checks at 0 on ${commit ?? 'none'}`);
      // A cause is always followed by fresh folders (W4-48): a done unit made before it must never meet the smoke rule or feed pilot.json.
      const failed = failure.attempt ?? 1;
      if (attempt <= failed) return no(`DRIVE: ${shown} needs --attempt ${failed + 1} or above after the cause for attempt ${failed}`);
    }
    if (step === '1' && !entries.slice(causeIndex + 1).some((e) => e.step === 'smoke' && e.exit === 0 && e.tag === tag && e.pinsSha256 === pinsSha256)) {
      return no(`DRIVE: step 1 needs a smoke at 0 on ${tag} with the current pins`);
    }
    return { ok: true, line: null };
  }

  if (step === '8') {
    return lastOf('7')?.exit === 0 || stopped !== null ? { ok: true, line: null } : no('DRIVE: step 8 needs step 7 at 0 or a terminal stop');
  }
  const before = ORDER[step];
  if (before === undefined) return { ok: true, line: null };
  const last = lastOf(before);
  let follows = last?.exit === 0;
  if (last?.exit === 4 && step in FOLLOWS_EXIT_4) follows = goAfter(entries, entries.lastIndexOf(last), FOLLOWS_EXIT_4[step], null);
  if (last?.exit === 6 && step === '7') follows = true;
  return follows ? { ok: true, line: null } : no(`DRIVE: step ${step} needs step ${before} at 0`);
}

/** The stop id of a command that exited non-zero, or null for exit 0 (plan :406): never read from printed text; `fault` for an exit the table has no row for.
 * @param {{ step: string, cmd: string, exit: number, budgetLog?: Record<string, unknown>[], block?: { stops?: { id: string }[] } | null, kind?: string | null }} input */
export function stopIdOf({ step, cmd, exit, budgetLog = [], block = null, kind = null }) {
  if (exit === 0) return null;
  const row = STOP_TABLE.find((r) => r.step === step && r.cmd === cmd && r.exit === exit);
  if (row === undefined) return 'fault';
  return (row.pick ? row.pick({ budgetLog, block, kind }) : row.id) ?? 'fault';
}

/* ------------------------------------------------------------------------------------------------ the CLI */

const USAGE = 'usage: z0-drive.mjs gate --root <r> --step <s> --tag <t|none> --commit <sha> --pins-sha256 <h|none> --claude-version <v|none> --attempt <n>\n'
  + '       z0-drive.mjs stop-id --root <r> --step <s> --cmd <name> --exit <n> [--kind <k>]\n'
  + '       z0-drive.mjs append --root <r> --step <s> --exit <n> [--attempt <n>] [--stop-id <id>] [--line <text>] [--tag <t>] [--commit <sha>] [--pins-sha256 <h>] [--claude-version <v>]\n'
  + '                           [--question <q>] [--figure <usd>] [--stop true|false] [--kind <k>] [--failed-step <s>] [--spent <folder>]\n'
  + '       z0-drive.mjs cause --root <r> --kind version|other|no-version\n'
  + '       z0-drive.mjs failure|terminal|last-smoke|pilot-r|max-seed|pilot-keys|pins-info --root <r>\n';

const ROOT_ONLY = { values: ['--root'], required: ['--root'] };
const SPECS = {
  gate: { values: ['--root', '--step', '--tag', '--commit', '--pins-sha256', '--claude-version', '--attempt'], required: ['--root', '--step', '--tag', '--commit', '--pins-sha256', '--claude-version', '--attempt'] },
  'stop-id': { values: ['--root', '--step', '--cmd', '--exit', '--kind'], required: ['--root', '--step', '--cmd', '--exit'] },
  append: {
    values: ['--root', '--step', '--exit', '--attempt', '--stop-id', '--tag', '--commit', '--pins-sha256', '--claude-version', '--question', '--figure', '--stop', '--kind', '--failed-step', '--spent'],
    required: ['--root', '--step', '--exit'],
  },
  cause: { values: ['--root', '--kind'], required: ['--root', '--kind'] },
  failure: ROOT_ONLY, terminal: ROOT_ONLY, 'last-smoke': ROOT_ONLY, 'pilot-r': ROOT_ONLY, 'max-seed': ROOT_ONLY, 'pilot-keys': ROOT_ONLY, 'pins-info': ROOT_ONLY,
};

const camel = (flag) => flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());
const STEPS = new Set(['plans', 'smoke', '1', '2', '3', '4', '5', '6', '7', '8', 'founder-go', 'cause', 'stage-checks']);

/** A whole number from `min`, named by its flag. */
function whole(flag, raw, min) {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(n) || n < min) throw new Error(`${flag} ${raw} is not a whole number from ${min}`);
  return n;
}

function usdOf(flag, raw) {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n) || n < 0) throw new Error(`${flag} ${raw} is not a USD figure`);
  return n;
}

const noneIsNull = (v) => (v === 'none' ? null : v);
const rootFolder = (raw) => {
  if (!fs.statSync(raw, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${raw} is not a folder`);
  return raw;
};

const COMMANDS = {
  gate(f, root) {
    const verdict = gate({ entries: readEntries(path.join(root, 'drive-log.jsonl')), step: stepOf(f.step), tag: noneIsNull(f.tag), commit: noneIsNull(f.commit), pinsSha256: noneIsNull(f.pinsSha256), claudeVersion: noneIsNull(f.claudeVersion), attempt: whole('--attempt', f.attempt, 1) });
    if (!verdict.ok) throw new Stop(verdict.line);
    return 'ok\n';
  },
  'stop-id'(f, root) {
    const [step, exit] = [stepOf(f.step), whole('--exit', f.exit, 0)];
    const input = { step, cmd: f.cmd, exit, kind: f.kind };
    if (step === '2' && f.cmd === 'admit' && exit === 4) input.budgetLog = readEntries(path.join(root, 'budget-log.jsonl'));
    if (step === '3' && f.cmd === 'block' && exit === 3) {
      const file = path.join(root, 'batch1', 'block.json');
      input.block = fs.existsSync(file) ? parseOrNull(fs.readFileSync(file, 'utf8')) : null;
    }
    return `${stopIdOf(input) ?? 'none'}\n`;
  },
  append(f, root) {
    const entry = entryOf({
      step: stepOf(f.step), exit: whole('--exit', f.exit, 0), attempt: f.attempt === null ? null : whole('--attempt', f.attempt, 1), stopId: f.stopId, line: f.line, tag: f.tag, commit: f.commit,
      pinsSha256: f.pinsSha256, claudeVersion: f.claudeVersion, question: f.question, figure: f.figure === null ? null : usdOf('--figure', f.figure), stop: boolOf(f.stop), kind: f.kind,
      failedStep: f.failedStep, spent: f.spent,
    });
    appendJsonLine(path.join(root, 'drive-log.jsonl'), entry);
    return `logged ${entry.step} exit ${entry.exit}\n`;
  },
  cause(f, root) {
    if (!['version', 'other', 'no-version'].includes(f.kind)) throw new Error(`--kind ${f.kind} is not version, other or no-version`);
    return `${causeDecision(readEntries(path.join(root, 'drive-log.jsonl')), f.kind)}\n`;
  },
  failure(f, root) {
    const open = lastFailure(readEntries(path.join(root, 'drive-log.jsonl')).filter(isOutcome));
    if (open === null) throw new Error('DRIVE: cause needs a smoke or step 1 failure to explain');
    return `${open.entry.step} ${open.entry.attempt ?? 1} ${open.entry.tag ?? 'none'}\n`;
  },
  terminal(f, root) {
    const stopped = terminalOf(readEntries(path.join(root, 'drive-log.jsonl')));
    return stopped === null ? '' : `${stopped.id} ${stopped.step}\n`;
  },
  'last-smoke'(f, root) {
    const last = readEntries(path.join(root, 'drive-log.jsonl')).findLast((e) => e.step === 'smoke' && e.exit === 0);
    if (last === undefined) throw new Error('DRIVE: no smoke entry at 0 in the drive log');
    return `${last.attempt}\n`;
  },
  'pilot-r'(f, root) {
    const file = path.join(root, 'pilot.json');
    const { rMax } = readJson(file);
    if (!Number.isFinite(rMax) || rMax <= 0) throw new Error(`${file}: rMax is not a number above 0`);
    return `${rMax}\n`;
  },
  'max-seed'(f, root) {
    const file = path.join(root, 'raise', 'max-seed.json');
    const sealed = readSealed(file);
    if (sealed === null) throw new Error(`${file} is absent`);
    if (!Number.isInteger(sealed.maxSeed) || !Number.isInteger(sealed.count)) throw new Error(`${file}: maxSeed and count must be whole numbers`);
    return `${sealed.maxSeed} ${sealed.count}\n`;
  },
  'pilot-keys'(f, root) {
    const keys = Object.keys(readJson(path.join(root, 'pilot-tasks', 'repos.json'))).filter((k) => k !== 'effort').sort();
    return keys.map((k) => `${k}\n`).join('');
  },
  'pins-info'(f, root) {
    const file = path.join(root, 'pins-r4.json');
    if (!fs.existsSync(file)) return 'none none\n';
    const pins = readPins(file);
    return `${pins.sha256} ${pins.claudeVersion ?? 'none'}\n`;
  },
};

function stepOf(raw) {
  if (!STEPS.has(raw)) throw new Error(`--step ${raw} is not one of ${[...STEPS].join(', ')}`);
  return raw;
}

function boolOf(raw) {
  if (raw === null) return null;
  if (raw !== 'true' && raw !== 'false') throw new Error(`--stop ${raw} is not true or false`);
  return raw === 'true';
}

/** The whole CLI as a function of argv, so tests drive it with no child process.
 * @param {string[]} argv @returns {{ code: number, stdout: string, stderr: string }} */
export function runCli(argv) {
  return runCommand(() => {
    const [command, ...rest] = argv;
    if (!Object.hasOwn(SPECS, command ?? '')) throw new Error(`unknown command ${command ?? '(none)'}\n${USAGE}`);
    // A logged line may start with `--` (a refusal quoted whole), which parseFlags rejects as a value, so it is taken out first.
    const at = command === 'append' ? rest.indexOf('--line') : -1;
    let line = null;
    if (at >= 0) {
      line = rest[at + 1];
      if (line === undefined || line === '') throw new Error(`--line needs a value\n${USAGE}`);
      rest.splice(at, 2);
    }
    const spec = SPECS[command];
    const flags = parseFlags(rest, spec, USAGE);
    for (const flag of spec.values) if (flags[camel(flag)] === '') throw new Error(`${flag} is empty\n${USAGE}`);
    return COMMANDS[command]({ ...flags, line }, rootFolder(flags.root));
  });
}

runMain(import.meta.url, runCli);
