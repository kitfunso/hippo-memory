#!/usr/bin/env node
// Z0 Claude Code runner: arms A0, A1, A2, A4 and A5 in lockstep, one record per (task, arm, seed) for z0-analyze.mjs.
// Protocol: docs/evals/2026-09-29-z0-built-in-memory-prereg.md. Usage, tasks file and fairness: benchmarks/token-eval/README.md.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARMS, ARM_SEEDS, TOKEN_KEY, armSet } from './arms.mjs';
import { assertNoAncestorInstructions, checkHomes } from './homes.mjs';
import { validateFamilies, drawOrder, taskRoles } from './lessons.mjs';
import { openContext, cacheTaskRepos } from './runs.mjs';
import { assertNoPhraseLeaks } from './leaks.mjs';
import { runSteps } from './task.mjs';
import { planScreen, screenLines, runScreen } from './screen.mjs';
import { parseHookTrust } from './codex.mjs';
import { finishCodex } from './codex-task.mjs';
import { checkInstaller } from './codex-install.mjs';

export { cacheTaskRepos } from './runs.mjs';
export { usageFromResult, isUsageLimit, transcriptWork } from './records.mjs';

/** Validate a tasks file; `baseDir` (the file's folder) resolves checker scripts. Throws on the first problem.
 * @param {any} spec
 * @param {string | null} [baseDir] */
export function validateTasks(spec, baseDir = null) {
  if (!spec || !Array.isArray(spec.sequences) || spec.sequences.length === 0) throw new Error('tasks file needs a non-empty "sequences" array');
  const ids = new Set();
  for (const s of spec.sequences) {
    for (const f of ['id', 'cluster', 'repo']) if (!s[f]) throw new Error(`sequence missing "${f}"`);
    if (ids.has(s.id)) throw new Error(`duplicate sequence id ${s.id}`);
    ids.add(s.id);
    if (!Array.isArray(s.tasks) || s.tasks.length < 2) throw new Error(`sequence ${s.id} needs at least 2 tasks (the first is not scored)`);
    const taskIds = new Set();
    for (const t of s.tasks) {
      for (const f of ['id', 'baseRef', 'fixRef', 'prompt', 'test']) if (!t[f]) throw new Error(`task in ${s.id} missing "${f}"`);
      if (taskIds.has(t.id)) throw new Error(`sequence ${s.id} has task id ${t.id} twice`);
      taskIds.add(t.id);
      if (!Array.isArray(t.testFiles)) throw new Error(`task ${t.id} needs a "testFiles" array`);
      if (t.needsReview) throw new Error(`task ${t.id} still has needsReview: rewrite its prompt as the problem (not the fix), then delete needsReview`);
    }
  }
  return validateFamilies(spec, baseDir);
}

const rotate = (list, k) => list.map((_, i) => list[(i + k) % list.length]);

/** A sequence's tasks in this seed's drawn order with their roles; every arm on the seed shares it (prereg 117). */
function seededOrder(sequence, families, seed) {
  const tasks = drawOrder(sequence, families, seed).map((id) => sequence.tasks.find((t) => t.id === id));
  return { tasks, roles: taskRoles(tasks, families, sequence.set) };
}

const pairs = (arm, sequence) => armSet(arm) === (sequence.set === 'X' ? 'X' : 'RN');

/** Throws when an arm has no sequence of its set, so a plan never silently drops an arm. */
function assertArmsPair(spec, arms) {
  for (const arm of arms) {
    if (!spec.sequences.some((s) => pairs(arm, s))) throw new Error(`arm ${arm} has no sequence of set ${armSet(arm) === 'X' ? 'X' : 'R or N'} in the tasks file`);
  }
}

// --seeds only lowers a count: E7 refuses an A0 or A4 seed past the prereg's two (prereg 122-124).
const seedCap = (seeds) => (arm) => Math.min(seeds ?? ARM_SEEDS[arm], ARM_SEEDS[arm]);

/** Every session in execution order, `{ seed, position, arm, sequence, taskId, t, role }`: position-major, arm order rotated by position + seed. */
export function planRuns(spec, arms, seedsFor = (arm) => ARM_SEEDS[arm]) {
  assertArmsPair(spec, arms);
  const steps = [];
  const maxSeed = Math.max(...arms.map(seedsFor));
  const maxTasks = Math.max(...spec.sequences.map((s) => s.tasks.length));
  for (let seed = 1; seed <= maxSeed; seed++) {
    const active = arms.filter((a) => seed <= seedsFor(a));
    const orders = new Map(spec.sequences.map((s) => [s.id, seededOrder(s, spec.families ?? [], seed)]));
    for (let position = 0; position < maxTasks; position++) {
      for (const arm of rotate(active, position + seed)) {
        for (const sequence of spec.sequences) {
          if (position >= sequence.tasks.length || !pairs(arm, sequence)) continue;
          const { tasks, roles } = orders.get(sequence.id);
          steps.push({ seed, position, arm, sequence, taskId: tasks[position].id, t: tasks[position], role: roles[position] });
        }
      }
    }
  }
  return steps;
}

/** The expected cells, written before any session so the analysis can tell a run cut off in lockstep; kind, familyId and set match the records. */
function writePlan(outDir, steps) {
  fs.mkdirSync(outDir, { recursive: true });
  const cells = steps.map((st) => ({
    seed: st.seed, position: st.position, arm: st.arm, sequence: st.sequence.id, taskId: st.taskId, repo: st.sequence.repo,
    kind: st.role.kind, familyId: st.role.familyId, set: st.role.set,
  }));
  fs.writeFileSync(path.join(outDir, 'plan.json'), `${JSON.stringify(cells, null, 2)}\n`);
}

/** The checks main runs before a run can be abandoned: the out dir's ancestors, the lesson key phrases, then (real runs) the task repos. */
export function preflight(spec, out, mode, stopAt, { screen = false } = {}) {
  // The free check first, so a refused --out never gets a clone.
  assertNoAncestorInstructions(out, { stopAt });
  assertNoPhraseLeaks(spec);
  if (mode === 'real') cacheTaskRepos(spec, path.join(out, 'repo-cache'), { screen });
}

/** What a real run with an X arm needs before any session: a model to record, and hook trust when X2 runs (prereg 91, E6 test 23).
 * @param {string[]} arms
 * @param {string} mode
 * @param {{codexModel?: string | null, codexHookTrust?: string}} [options] */
export function codexPreflight(arms, mode, { codexModel = null, codexHookTrust = 'none' } = {}) {
  if (mode !== 'real' || !arms.some((a) => armSet(a) === 'X')) return;
  if (!codexModel) throw new Error('an X arm runs Codex: pass --codex-model, so every record names the model it ran');
  // An untrusted X2 runs hippo's hooks never, so its cells would test only the wrapper and must not reach the data.
  if (arms.includes('X2') && parseHookTrust(codexHookTrust).kind === 'none') throw new Error('X2 with --codex-hook-trust none: Codex would never run hippo\'s hooks. Pass the trust from the smoke report (flag, or file:<path>)');
}

/** Run the whole plan in lockstep. Returns the records written; `progress.last` names the last completed step. */
export async function runAll(opts) {
  const { spec, arms, seeds = null, outDir } = opts;
  const ctx = await openContext(opts);
  let records;
  try {
    const steps = planRuns(spec, arms, seedCap(seeds));
    writePlan(outDir, steps);
    records = await runSteps(ctx, steps);
  } catch (err) {
    // The run's own error stands; the sweep's hits or failure are added to it, never put in its place (E6 plan R24).
    try {
      const hits = finishCodex(ctx);
      if (hits.length) err.message += `; the final sweep also found login tokens in ${hits.join(', ')} (files listed without a note are deleted)`;
    } catch (sweepErr) {
      err.message += `; the final sweep also failed: ${sweepErr.message}`;
    }
    throw err;
  }
  const hits = finishCodex(ctx);
  if (hits.length) throw new Error(`a Codex login token was left in ${hits.join(', ')}; files listed without a note are deleted, and the run is void`);
  return records;
}

/** Per sequence and seed, the drawn order; per sequence, the tasksSinceTeach spread, so a bunched draw shows before any session. */
function orderReport(steps) {
  const lines = [];
  const spread = new Map();
  const seen = new Set();
  for (const st of steps) {
    const key = `${st.sequence.id}|${st.seed}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cells = steps.filter((x) => x.arm === st.arm && x.seed === st.seed && x.sequence === st.sequence).sort((a, b) => a.position - b.position);
    lines.push(`order ${st.sequence.id} seed${st.seed}: ${cells.map((x) => x.taskId).join(' ')}`);
    const gaps = cells.filter((x) => x.role.kind === 'apply').map((x) => x.role.tasksSinceTeach);
    spread.set(st.sequence.id, [...(spread.get(st.sequence.id) ?? []), ...gaps]);
  }
  for (const [id, gaps] of spread) {
    if (!gaps.length) continue;
    const g = gaps.sort((a, b) => a - b);
    const mid = g.length % 2 ? g[(g.length - 1) / 2] : (g[g.length / 2 - 1] + g[g.length / 2]) / 2;
    lines.push(`${id} tasksSinceTeach over ${g.length} applies: min ${g[0]}, median ${mid}, max ${g[g.length - 1]}`);
  }
  return lines;
}

const USAGE = 'Usage: node scripts/token-eval/ab-run.mjs --tasks tasks.json --out DIR --model MODEL [--arms A0,A1,A2,A4,A5,X1,X2,X3,X4] [--seeds N] [--pass-env NAME]... [--max-budget-usd N] [--session-timeout-min N] [--canaries FILE] [--screen] [--dry-run | --check-homes]\n  set X: --codex-model M [--codex-bin PATH] [--codex-auth auth.json] [--codex-hook-trust none|flag|file:PATH] [--codex-memory-wait none|poll:STABLE_MS:TIMEOUT_MS] [--codex-memories on|off] [--codex-wrapper-wait-ms N]';
const CODEX_FLAGS = { codexBin: '--codex-bin', codexModel: '--codex-model', codexAuth: '--codex-auth', codexHookTrust: '--codex-hook-trust', codexMemoryWait: '--codex-memory-wait', codexMemories: '--codex-memories', codexWrapperWaitMs: '--codex-wrapper-wait-ms' };

/** The command line, checked: the tasks file, out dir, arms, seeds, pass-env names and mode. */
function parseArgs(argv) {
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
  };
  const tasksFile = flag('--tasks', null);
  const outDir = flag('--out', null);
  if (!tasksFile || !outDir) {
    console.error(USAGE);
    process.exit(1);
  }
  const spec = validateTasks(JSON.parse(fs.readFileSync(tasksFile, 'utf8')), path.dirname(path.resolve(tasksFile)));
  const fitting = ARMS.filter((a) => spec.sequences.some((s) => pairs(a, s)));
  const arms = flag('--arms', fitting.join(',')).split(',').map((a) => a.trim());
  for (const a of arms) if (!ARMS.includes(a)) throw new Error(`unknown arm ${a}; known: ${ARMS.join(', ')}`);
  if (new Set(arms).size !== arms.length) throw new Error(`--arms names an arm twice (${arms.join(',')}); each arm runs once`);
  const timeoutArg = flag('--session-timeout-min', '60');
  if (!/^[1-9]\d*$/.test(timeoutArg)) throw new Error(`--session-timeout-min must be a positive integer, got ${timeoutArg}`);
  const seedsArg = flag('--seeds', null);
  if (seedsArg !== null && !/^[1-9]\d*$/.test(seedsArg)) throw new Error(`--seeds must be a positive integer, got ${seedsArg}`);
  const canariesFile = flag('--canaries', null);
  const canaries = canariesFile ? fs.readFileSync(canariesFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  if (canariesFile && canaries.length === 0) throw new Error(`--canaries ${canariesFile} holds no canary; one per line`);
  return {
    canaries,
    flag, spec, arms, seeds: seedsArg === null ? null : Number(seedsArg), sessionTimeoutMs: Number(timeoutArg) * 60_000, out: path.resolve(outDir), screen: argv.includes('--screen'),
    passEnv: argv.flatMap((a, i) => (a === '--pass-env' && i + 1 < argv.length ? [argv[i + 1]] : [])),
    mode: argv.includes('--dry-run') ? 'dry' : (argv.includes('--check-homes') ? 'check' : 'real'),
  };
}

/** Print the plan; a run's dry run also writes plan.json and the order report. */
function dryRun(args, steps) {
  if (args.screen) {
    for (const line of screenLines(args.spec, steps)) console.log(line);
    return;
  }
  writePlan(args.out, steps);
  for (const [i, r] of steps.entries()) console.log(`  ${i} seed${r.seed} pos${r.position} ${r.arm} ${r.sequence.id}/${r.taskId}`);
  for (const line of orderReport(steps)) console.log(line);
}

async function main() {
  const args = parseArgs(process.argv);
  const { flag, spec, arms, seeds, out, mode, passEnv } = args;
  const steps = args.screen ? planScreen(spec) : planRuns(spec, arms, seedCap(seeds));
  const records = path.join(out, args.screen ? 'screen.jsonl' : 'runs.jsonl');
  // A run appends to its records file and both modes rewrite plan.json, so an earlier run's records would end up unplanned.
  const rewrite = args.screen ? '' : ' and rewrite plan.json';
  if (mode !== 'check' && fs.existsSync(records)) throw new Error(`${out} already holds ${path.basename(records)} from an earlier run; this run would append to it${rewrite}. Pick a new --out.`);
  const stopAt = process.env.Z0_ANCESTOR_STOP || null;
  // The stop is for tests under a temp dir; a stray export must never disable a real run's check.
  // A dev file may skip screen tasks, so it can never feed a real run.
  if (mode === 'real' && spec.dev === true) throw new Error('the tasks file sets "dev": true; it is for --dry-run and --check-homes only, never a real run');
  if (mode === 'real' && stopAt) throw new Error('Z0_ANCESTOR_STOP is set; it is only honoured for --dry-run and --check-homes. Unset it for a real run.');
  if (mode === 'real' && !process.env[TOKEN_KEY]) throw new Error('run `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN');
  const codexOpts = Object.fromEntries(Object.entries(CODEX_FLAGS).map(([k, name]) => [k, flag(name, undefined)]).filter(([, v]) => v !== undefined));
  codexPreflight(arms, mode, codexOpts);
  // Outside the try below: a task the runner refuses is not a run abandoned partway, so it must not leave ABANDONED.
  preflight(spec, out, mode, stopAt, { screen: args.screen });
  if (args.screen) console.log(`${steps.length} screen sessions: A0 and A4 only, seeds 1 and 2.`);
  else console.log(`${steps.length} steps (Claude Code sessions) in lockstep; seeds ${arms.map((a) => `${a}:${seedCap(seeds)(a)}`).join(' ')}.`);
  if (mode === 'dry') return dryRun(args, steps);
  const dirName = (st) => st.runName ?? st.sequence.id;
  const runs = [...new Map(steps.map((st) => [`${dirName(st)}|${st.arm}|${st.seed}`, { seq: dirName(st), arm: st.arm, seed: st.seed }])).values()];
  checkHomes({ outDir: out, runs, passEnv, install: arms.includes('X2') ? checkInstaller(codexOpts.codexBin) : null });
  console.log(`Homes check passed for ${runs.length} runs.`);
  if (mode === 'check') return;
  const progress = { last: 'none' };
  const opts = {
    spec, arms, seeds, outDir: out, passEnv, progress, model: flag('--model', null), claudeBin: flag('--claude-bin', 'claude'),
    maxBudgetUsd: flag('--max-budget-usd', null), settleMs: Number(flag('--settle-ms', '5000')), warmup: !process.argv.includes('--no-warmup'),
    permissionMode: flag('--permission-mode', 'bypassPermissions'), sessionTimeoutMs: args.sessionTimeoutMs, canaries: args.canaries, ...codexOpts,
  };
  try {
    if (args.screen) {
      const v = await runScreen(opts);
      console.log(`\nScreen: kept ${v.kept.join(', ') || 'none'}; dropped ${v.dropped.length}; undecided ${v.undecided.length}. Lists: ${path.join(out, 'screen.json')}`);
      return;
    }
    await runAll(opts);
  } catch (err) {
    // Under lockstep a mid-run throw leaves every run partial, so the out dir says so.
    fs.writeFileSync(path.join(out, 'ABANDONED'), `${err.message}\nlast completed: ${progress.last}\n`);
    throw err;
  }
  // ab-analyze averages unequal seed counts unpaired, so Z0 records go to the Z0 analyzer, which pairs shared seeds.
  console.log(`\nRecords: ${path.join(out, 'runs.jsonl')}\nAnalyze with scripts/token-eval/z0-analyze.mjs (pairs shared seeds; it lands with PR #357), never ab-analyze.mjs.`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
