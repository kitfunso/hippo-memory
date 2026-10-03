#!/usr/bin/env node
// Z0 Claude Code runner: arms A0, A1, A2, A4 and A5 in lockstep, one record per (task, arm, seed) for z0-analyze.mjs.
// Protocol: docs/evals/2026-09-29-z0-built-in-memory-prereg.md. Usage, tasks file and fairness: benchmarks/token-eval/README.md.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh, git } from './exec.mjs';
import { ARMS, ARM_SEEDS, TOKEN_KEY, armEnv, startupTools } from './arms.mjs';
import { runDirs, assertNoAncestorInstructions, checkHomes } from './homes.mjs';
import { stubBaseCommit, assertNoInstructionLinks } from './workspace.mjs';
import { validateFamilies, drawOrder, taskRoles, lessonIndex } from './lessons.mjs';
import { loadHippo, startRun } from './runs.mjs';
import { runTask } from './task.mjs';

export { usageFromResult, isUsageLimit, transcriptWork } from './records.mjs';

/** Validate a tasks file; `baseDir` (the file's folder) resolves checker scripts. Throws on the first problem. */
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
  return { tasks, roles: taskRoles(tasks, families) };
}

/** Every session in execution order, `{ seed, position, arm, sequence, taskId, t, role }`: position-major, arm order rotated by position + seed. */
export function planRuns(spec, arms, seedsFor = (arm) => ARM_SEEDS[arm]) {
  const steps = [];
  const maxSeed = Math.max(...arms.map(seedsFor));
  const maxTasks = Math.max(...spec.sequences.map((s) => s.tasks.length));
  for (let seed = 1; seed <= maxSeed; seed++) {
    const active = arms.filter((a) => seed <= seedsFor(a));
    const orders = new Map(spec.sequences.map((s) => [s.id, seededOrder(s, spec.families ?? [], seed)]));
    for (let position = 0; position < maxTasks; position++) {
      for (const arm of rotate(active, position + seed)) {
        for (const sequence of spec.sequences) {
          if (position >= sequence.tasks.length) continue;
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

/** Clone each sequence's repo into the cache, then refuse any task whose stub tree checkoutBase would refuse. */
export function cacheTaskRepos(spec, cacheDir) {
  // Finding a symlinked instruction file here saves abandoning a lockstep run midway.
  for (const s of spec.sequences) {
    const cached = path.join(cacheDir, s.id);
    if (!fs.existsSync(cached)) {
      fs.mkdirSync(cacheDir, { recursive: true });
      git(['clone', '--quiet', s.repo, cached]);
    }
    for (const t of s.tasks) assertNoInstructionLinks(cached, s.id, t, stubBaseCommit(cached, t.baseRef));
  }
}

/** The checks main runs before a run can be abandoned: the out dir's ancestors, then (real runs) the task repos. */
export function preflight(spec, out, mode, stopAt) {
  // The free check first, so a refused --out never gets a clone.
  assertNoAncestorInstructions(out, { stopAt });
  if (mode === 'real') cacheTaskRepos(spec, path.join(out, 'repo-cache'));
}

/** Run the whole plan in lockstep. Returns the records written; `progress.last` names the last completed step. */
export async function runAll(opts) {
  await loadHippo();
  const { spec, arms, seeds = null, outDir, claudeBin = 'claude', warmup = true, passEnv = [], progress = {} } = opts;
  const { claude } = startupTools(claudeBin, process.env);
  fs.mkdirSync(outDir, { recursive: true });
  // outDir as HOME: hippo's store walk stops at HOME, so it must be an ancestor of every workspace.
  const ctx = {
    outDir, passEnv, claude, records: [], fakeHome: outDir, hookHome: path.join(outDir, 'hook-home'), cacheDir: path.join(outDir, 'repo-cache'),
    model: opts.model ?? null, maxBudgetUsd: opts.maxBudgetUsd ?? null, settleMs: opts.settleMs ?? 5000, permissionMode: opts.permissionMode ?? 'bypassPermissions',
    limitWaitMs: opts.limitWaitMs ?? 15 * 60_000, limitMaxWaits: opts.limitMaxWaits ?? 96, log: opts.log ?? console.log,
    lessons: lessonIndex(spec.families ?? []),
  };
  cacheTaskRepos(spec, ctx.cacheDir);
  const warmDir = path.join(outDir, 'warmup');
  const warmEnv = armEnv('A0', { ...runDirs(warmDir, '', '', 0), claudeConfig: path.join(warmDir, 'claude-config') }, process.env, { passEnv });
  ctx.claudeVersion = sh(`${claude} --version`, outDir, warmEnv).stdout.trim() || null;
  if (warmup) {
    // One unrecorded call, so the first recorded run does not alone pay the cold prompt-cache write.
    fs.mkdirSync(warmEnv.CLAUDE_CONFIG_DIR, { recursive: true });
    const warmArgs = ['-p', '--output-format', 'json', '--setting-sources', 'project', '--strict-mcp-config', ...(ctx.model ? ['--model', ctx.model] : [])];
    sh(`${claude} ${warmArgs.join(' ')}`, warmDir, warmEnv, 10 * 60_000, 'Reply with the single word OK.');
  }
  const steps = planRuns(spec, arms, seeds ? () => seeds : (arm) => ARM_SEEDS[arm]);
  writePlan(outDir, steps);
  const state = new Map();
  for (const [order, step] of steps.entries()) {
    // Every session is synchronous; yielding once a step keeps the host's event loop (signals, a test worker's RPC) alive.
    await new Promise((resolve) => setImmediate(resolve));
    const { seed, arm, sequence: s } = step;
    const key = `${s.id}|${arm}|${seed}`;
    if (!state.has(key)) state.set(key, startRun(ctx, s, arm, seed));
    await runTask(ctx, state.get(key), { ...step, order });
    progress.last = `step ${order}: ${s.id} ${step.taskId} ${arm} seed${seed}`;
  }
  return ctx.records;
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

async function main() {
  const argv = process.argv;
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
  };
  const tasksFile = flag('--tasks', null);
  const outDir = flag('--out', null);
  if (!tasksFile || !outDir) {
    console.error('Usage: node scripts/token-eval/ab-run.mjs --tasks tasks.json --out DIR --model MODEL [--arms A0,A1,A2,A5] [--seeds N] [--pass-env NAME]... [--max-budget-usd N] [--dry-run | --check-homes]');
    process.exit(1);
  }
  const spec = validateTasks(JSON.parse(fs.readFileSync(tasksFile, 'utf8')), path.dirname(path.resolve(tasksFile)));
  const arms = flag('--arms', ARMS.join(',')).split(',').map((a) => a.trim());
  for (const a of arms) if (!ARMS.includes(a)) throw new Error(`unknown arm ${a}; known: ${ARMS.join(', ')}`);
  if (new Set(arms).size !== arms.length) throw new Error(`--arms names an arm twice (${arms.join(',')}); each arm runs once`);
  const seedsArg = flag('--seeds', null);
  if (seedsArg !== null && !/^[1-9]\d*$/.test(seedsArg)) throw new Error(`--seeds must be a positive integer, got ${seedsArg}`);
  const seeds = seedsArg === null ? null : Number(seedsArg);
  const passEnv = argv.flatMap((a, i) => (a === '--pass-env' && i + 1 < argv.length ? [argv[i + 1]] : []));
  const steps = planRuns(spec, arms, seeds ? () => seeds : (arm) => ARM_SEEDS[arm]);
  const out = path.resolve(outDir);
  const mode = argv.includes('--dry-run') ? 'dry' : (argv.includes('--check-homes') ? 'check' : 'real');
  // A run appends to runs.jsonl and both modes rewrite plan.json, so an earlier run's records would end up unplanned.
  if (mode !== 'check' && fs.existsSync(path.join(out, 'runs.jsonl'))) throw new Error(`${out} already holds runs.jsonl from an earlier run; this run would append to it and rewrite plan.json. Pick a new --out.`);
  const stopAt = process.env.Z0_ANCESTOR_STOP || null;
  // The stop is for tests under a temp dir; a stray export must never disable a real run's check.
  // A dev file may skip screen tasks, so it can never feed a real run.
  if (mode === 'real' && spec.dev === true) throw new Error('the tasks file sets "dev": true; it is for --dry-run and --check-homes only, never a real run');
  if (mode === 'real' && stopAt) throw new Error('Z0_ANCESTOR_STOP is set; it is only honoured for --dry-run and --check-homes. Unset it for a real run.');
  if (mode === 'real' && !process.env[TOKEN_KEY]) throw new Error('run `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN');
  // Outside the try below: a task the runner refuses is not a run abandoned partway, so it must not leave ABANDONED.
  preflight(spec, out, mode, stopAt);
  console.log(`${steps.length} steps (Claude Code sessions) in lockstep; seeds ${arms.map((a) => `${a}:${seeds ?? ARM_SEEDS[a]}`).join(' ')}.`);
  if (mode === 'dry') {
    writePlan(out, steps);
    for (const [i, r] of steps.entries()) console.log(`  ${i} seed${r.seed} pos${r.position} ${r.arm} ${r.sequence.id}/${r.taskId}`);
    for (const line of orderReport(steps)) console.log(line);
    return;
  }
  const runs = [...new Map(steps.map((st) => [`${st.sequence.id}|${st.arm}|${st.seed}`, { seq: st.sequence.id, arm: st.arm, seed: st.seed }])).values()];
  checkHomes({ outDir: out, runs, passEnv });
  console.log(`Homes check passed for ${runs.length} runs.`);
  if (mode === 'check') return;
  const progress = { last: 'none' };
  try {
    await runAll({
      spec, arms, seeds, outDir: out, passEnv, progress,
      model: flag('--model', null),
      claudeBin: flag('--claude-bin', 'claude'),
      maxBudgetUsd: flag('--max-budget-usd', null),
      settleMs: Number(flag('--settle-ms', '5000')),
      warmup: !argv.includes('--no-warmup'),
      permissionMode: flag('--permission-mode', 'bypassPermissions'),
    });
  } catch (err) {
    // Under lockstep a mid-run throw leaves every run partial, so the out dir says so.
    fs.writeFileSync(path.join(out, 'ABANDONED'), `${err.message}\nlast completed: ${progress.last}\n`);
    throw err;
  }
  // ab-analyze averages unequal seed counts unpaired, so Z0 records go to the Z0 analyzer, which pairs shared seeds.
  console.log(`\nRecords: ${path.join(out, 'runs.jsonl')}\nAnalyze with scripts/token-eval/z0-analyze.mjs (pairs shared seeds; it lands with PR #357), never ab-analyze.mjs.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
