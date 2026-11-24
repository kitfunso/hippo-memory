#!/usr/bin/env node
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARMS, ARM_SEEDS, TOKEN_KEY, armSet } from './arms.mjs';
import { assertNoAncestorInstructions, checkHomes, formatHomesReport } from './homes.mjs';
import { validateFamilies, drawOrder, taskRoles } from './lessons.mjs';
import { openContext, cacheTaskRepos } from './runs.mjs';
import { assertNoPhraseLeaks } from './leaks.mjs';
import { runSteps } from './task.mjs';
import { planScreen, screenLines, runScreen, SCREEN_ARMS } from './screen.mjs';
import { parseHookTrust } from './codex.mjs';
import { finishCodex } from './codex-task.mjs';
import { checkInstaller } from './codex-install.mjs';
import { objectLockRetries } from './exec.mjs';

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

function seededOrder(sequence, families, seed) {
  const tasks = drawOrder(sequence, families, seed).map((id) => sequence.tasks.find((t) => t.id === id));
  return { tasks, roles: taskRoles(tasks, families, sequence.set) };
}

const pairs = (arm, sequence) => armSet(arm) === (sequence.set === 'X' ? 'X' : 'RN');

function assertArmsPair(spec, arms) {
  for (const arm of arms) {
    if (!spec.sequences.some((s) => pairs(arm, s))) throw new Error(`arm ${arm} has no sequence of set ${armSet(arm) === 'X' ? 'X' : 'R or N'} in the tasks file`);
  }
}

const seedCap = (seeds) => (arm) => Math.min(seeds ?? ARM_SEEDS[arm], ARM_SEEDS[arm]);
const WAVE_1_SEEDS = 3;
const WAVE_2_FIRST_SEED = WAVE_1_SEEDS + 1;
const WAVE_2_MAX_SEEDS = 9;

/** Every session in execution order, `{ seed, position, arm, sequence, taskId, t, role }`: position-major, each arm set's order rotated by position + seed.
 * `firstSeed` 4 plans wave 2; rotation and drawn order key on the real seed number, so a seed's cells match a plan that started at 1. */
export function planRuns(spec, arms, seedsFor = (arm) => ARM_SEEDS[arm], firstSeed = 1) {
  assertArmsPair(spec, arms);
  const steps = [];
  const maxSeed = Math.max(...arms.map(seedsFor));
  const maxTasks = Math.max(...spec.sequences.map((s) => s.tasks.length));
  for (let seed = firstSeed; seed <= maxSeed; seed++) {
    const active = arms.filter((a) => seed <= seedsFor(a));
    const sets = [active.filter((a) => armSet(a) !== 'X'), active.filter((a) => armSet(a) === 'X')];
    const orders = new Map(spec.sequences.map((s) => [s.id, seededOrder(s, spec.families ?? [], seed)]));
    for (let position = 0; position < maxTasks; position++) {
      for (const arm of sets.flatMap((set) => rotate(set, position + seed))) {
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

const planFor = (spec, arms, seeds, waveTwo) => (waveTwo ? planRuns(spec, arms, (arm) => waveTwo[arm], WAVE_2_FIRST_SEED) : planRuns(spec, arms, seedCap(seeds)));

/** The `--seed-rule` file's seed counts for `arms`, refused unless the rule ran to a result (Amendment 2 item 5); `sha256` ties the wave to that file.
 * @param {string} file
 * @param {string[]} arms */
function readSeedRule(file, arms) {
  const bytes = fs.readFileSync(file);
  let rule;
  try {
    rule = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new Error(`--seed-rule ${file} is not JSON: ${err.message}`);
  }
  if (rule?.schema !== 'z0-seed-rule/1') throw new Error(`--seed-rule ${file}: schema must be "z0-seed-rule/1"`);
  if (rule.stop !== false) throw new Error(`--seed-rule ${file}: the rule did not say go (stop is not false), so there is no wave 2`);
  const seeds = rule.seeds;
  if (seeds === null || seeds === undefined || seeds.constructor !== Object) throw new Error(`--seed-rule ${file}: seeds must be an object of seed counts by arm`);
  const counts = {};
  for (const arm of arms) {
    if (!Object.hasOwn(seeds, arm)) throw new Error(`arm ${arm} is not listed in the seed rule's seeds (${Object.keys(seeds).join(', ')}); pass --arms with arms the rule lists`);
    const n = seeds[arm];
    if (!Number.isInteger(n) || n < WAVE_1_SEEDS || n > WAVE_2_MAX_SEEDS) throw new Error(`--seed-rule ${file}: ${arm} needs a seed count from ${WAVE_1_SEEDS} to ${WAVE_2_MAX_SEEDS}, got ${JSON.stringify(n)}`);
    counts[arm] = n;
  }
  return { counts, sha256: createHash('sha256').update(bytes).digest('hex') };
}

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
  if (arms.includes('X2') && parseHookTrust(codexHookTrust).kind === 'none') throw new Error('X2 with --codex-hook-trust none: Codex would never run hippo\'s hooks. Pass the trust from the smoke report (flag, or file:<path>)');
}

/** Run the whole plan in lockstep. Returns the records written; `progress.last` names the last completed step. */
export async function runAll(opts) {
  const { spec, arms, seeds = null, waveTwo = null, outDir } = opts;
  const ctx = await openContext(opts);
  let records;
  try {
    const steps = planFor(spec, arms, seeds, waveTwo);
    writePlan(outDir, steps);
    records = await runSteps(ctx, steps);
  } catch (err) {
    try {
      const hits = finishCodex(ctx);
      if (hits.length) err.message += `; the final sweep also found login tokens in, or could not check, ${hits.join(', ')} (files listed without a note are deleted)`;
    } catch (sweepErr) {
      err.message += `; the final sweep also failed: ${sweepErr.message}`;
    }
    throw err;
  }
  const hits = finishCodex(ctx);
  if (hits.length) throw new Error(`the final sweep found a Codex login token in, or could not check, ${hits.join(', ')}; files listed without a note are deleted, and the run is void`);
  return records;
}

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

const USAGE = 'Usage: node scripts/token-eval/ab-run.mjs --tasks tasks.json --out DIR --model MODEL [--arms A0,A1,A2,A4,A5,X1,X2,X3,X4] [--seeds N | --seed-rule FILE] [--pass-env NAME]... [--max-budget-usd N] [--session-timeout-min N] [--canaries FILE] [--pins FILE] [--screen] [--dry-run | --check-homes]\n  set X: --codex-model M [--codex-bin PATH] [--codex-auth auth.json] [--codex-hook-trust none|flag|file:PATH] [--codex-memory-wait none|poll:STABLE_MS:TIMEOUT_MS] [--codex-memories on|off] [--codex-wrapper-wait-ms N]';
const CODEX_FLAGS = { codexBin: '--codex-bin', codexModel: '--codex-model', codexAuth: '--codex-auth', codexHookTrust: '--codex-hook-trust', codexMemoryWait: '--codex-memory-wait', codexMemories: '--codex-memories', codexWrapperWaitMs: '--codex-wrapper-wait-ms' };

/** The arms a run uses: the named ones, else every arm the tasks file has a sequence for; a screen's are always A0 and A4 (prereg 68), so an X arm named with it is refused. */
export function chooseArms(spec, named, screen) {
  for (const a of named ?? []) if (!ARMS.includes(a)) throw new Error(`unknown arm ${a}; known: ${ARMS.join(', ')}`);
  if (named && new Set(named).size !== named.length) throw new Error(`--arms names an arm twice (${named.join(',')}); each arm runs once`);
  if (screen) {
    const x = (named ?? []).filter((a) => armSet(a) === 'X');
    if (x.length) throw new Error(`--screen runs A0 and A4 only, so --arms cannot name ${x.join(', ')}`);
    return [...SCREEN_ARMS];
  }
  return named ?? ARMS.filter((a) => spec.sequences.some((s) => pairs(a, s)));
}

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
  const named = flag('--arms', null);
  const screen = argv.includes('--screen');
  const ruleFile = flag('--seed-rule', null);
  if (argv.includes('--seed-rule') && ruleFile === null) throw new Error('--seed-rule needs the seed rule\'s output file');
  if (ruleFile !== null && (argv.includes('--seeds') || screen)) throw new Error('--seed-rule sets the seeds itself, so it cannot be combined with --seeds or --screen');
  const chosen = chooseArms(spec, named === null ? null : named.split(',').map((a) => a.trim()), screen);
  const rule = ruleFile === null ? null : readSeedRule(ruleFile, chosen);
  const arms = rule === null ? chosen : chosen.filter((a) => rule.counts[a] > WAVE_1_SEEDS);
  const timeoutArg = flag('--session-timeout-min', '60');
  if (!/^[1-9]\d*$/.test(timeoutArg)) throw new Error(`--session-timeout-min must be a positive integer, got ${timeoutArg}`);
  const seedsArg = flag('--seeds', null);
  if (seedsArg !== null && !/^[1-9]\d*$/.test(seedsArg)) throw new Error(`--seeds must be a positive integer, got ${seedsArg}`);
  const canariesFile = flag('--canaries', null);
  const canaries = canariesFile ? fs.readFileSync(canariesFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  if (canariesFile && canaries.length === 0) throw new Error(`--canaries ${canariesFile} holds no canary; one per line`);
  const pinsFile = flag('--pins', null);
  return {
    canaries, pins: pinsFile ? JSON.parse(fs.readFileSync(pinsFile, 'utf8')) : null,
    flag, spec, arms, rule, seeds: seedsArg === null ? null : Number(seedsArg), sessionTimeoutMs: Number(timeoutArg) * 60_000, out: path.resolve(outDir), screen,
    passEnv: argv.flatMap((a, i) => (a === '--pass-env' && i + 1 < argv.length ? [argv[i + 1]] : [])),
    mode: argv.includes('--dry-run') ? 'dry' : (argv.includes('--check-homes') ? 'check' : 'real'),
  };
}

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
  const { flag, spec, arms, rule, seeds, out, mode, passEnv } = args;
  const waveTwo = rule?.counts ?? null;
  if (rule && arms.length === 0) {
    console.log('wave 2 has no sessions');
    return;
  }
  const steps = args.screen ? planScreen(spec) : planFor(spec, arms, seeds, waveTwo);
  const records = path.join(out, args.screen ? 'screen.jsonl' : 'runs.jsonl');
  const rewrite = args.screen ? '' : ' and rewrite plan.json';
  if (mode !== 'check' && fs.existsSync(records)) throw new Error(`${out} already holds ${path.basename(records)} from an earlier run; this run would append to it${rewrite}. Pick a new --out.`);
  const stopAt = process.env.Z0_ANCESTOR_STOP || null;
  if (mode === 'real' && spec.dev === true) throw new Error('the tasks file sets "dev": true; it is for --dry-run and --check-homes only, never a real run');
  if (mode === 'real' && stopAt) throw new Error('Z0_ANCESTOR_STOP is set; it is only honoured for --dry-run and --check-homes. Unset it for a real run.');
  if (mode === 'real' && !process.env[TOKEN_KEY]) throw new Error('run `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN');
  const codexOpts = Object.fromEntries(Object.entries(CODEX_FLAGS).map(([k, name]) => [k, flag(name, undefined)]).filter(([, v]) => v !== undefined));
  codexPreflight(arms, mode, codexOpts);
  preflight(spec, out, mode, stopAt, { screen: args.screen });
  if (args.screen) console.log(`${steps.length} screen sessions: A0 and A4 only, seeds 1 and 2.`);
  else console.log(`${steps.length} steps (Claude Code sessions) in lockstep; seeds ${arms.map((a) => (waveTwo ? `${a}:${WAVE_2_FIRST_SEED}-${waveTwo[a]}` : `${a}:${seedCap(seeds)(a)}`)).join(' ')}.`);
  if (rule) console.log(`seed rule sha256 ${rule.sha256}`);
  if (mode === 'dry') return dryRun(args, steps);
  const dirName = (st) => st.runName ?? st.sequence.id;
  const runs = [...new Map(steps.map((st) => [`${dirName(st)}|${st.arm}|${st.seed}`, { seq: dirName(st), arm: st.arm, seed: st.seed }])).values()];
  const reports = checkHomes({ outDir: out, runs, passEnv, install: arms.includes('X2') ? checkInstaller(codexOpts.codexBin) : null });
  console.log(`Homes check passed for ${runs.length} runs.`);
  console.log(formatHomesReport(reports).join('\n'));
  if (mode === 'check') return;
  const progress = { last: 'none' };
  const opts = {
    spec, arms, seeds, waveTwo, outDir: out, passEnv, progress, model: flag('--model', null), claudeBin: flag('--claude-bin', 'claude'),
    maxBudgetUsd: flag('--max-budget-usd', null), settleMs: Number(flag('--settle-ms', '5000')), warmup: !process.argv.includes('--no-warmup'),
    permissionMode: flag('--permission-mode', 'bypassPermissions'), sessionTimeoutMs: args.sessionTimeoutMs, canaries: args.canaries, pins: args.pins, ...codexOpts,
  };
  try {
    if (args.screen) {
      const v = await runScreen(opts);
      console.log(`\nScreen: kept ${v.kept.join(', ') || 'none'}; dropped ${v.dropped.length}; undecided ${v.undecided.length}. Lists: ${path.join(out, 'screen.json')}`);
      return;
    }
    await runAll(opts);
  } catch (err) {
    fs.writeFileSync(path.join(out, 'ABANDONED'), `${err.message}\nlast completed: ${progress.last}\n`);
    throw err;
  } finally {
    if (objectLockRetries.count) console.log(`Git object-lock retries (antivirus holding a fresh object): ${objectLockRetries.count}.`);
  }
  console.log(`\nRecords: ${path.join(out, 'runs.jsonl')}\nAnalyze with scripts/token-eval/z0-analyze.mjs, which pairs shared seeds; never ab-analyze.mjs.`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
