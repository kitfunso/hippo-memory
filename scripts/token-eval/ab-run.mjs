#!/usr/bin/env node
// Z0 Claude Code runner: arms A0, A1, A2 and A5 in lockstep, one record per (task, arm, seed) for z0-analyze.mjs.
// Protocol: docs/evals/2026-09-29-z0-built-in-memory-prereg.md. Usage, tasks file and fairness: benchmarks/token-eval/README.md.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HIPPO_JS, sh, git } from './exec.mjs';
import { ARMS, ARM_SEEDS, HIPPO_ARMS, CARRY_ARMS, TOKEN_KEY, armSettings, armEnv, childEnv, writeHippoShim, startupTools } from './arms.mjs';
import { runDirs, freshRunDirs, homeFiles, assertNoAncestorInstructions, checkHomes } from './homes.mjs';
import { checkoutBase, assertNoInstructionLinks, instructionSnapshot, instructionDelta, applyInstructions, restoreInstructions, writeHiddenTests, goldLines } from './workspace.mjs';
import { isUsageLimit, findTranscript, transcriptWork, usageFromResult, skippedRecord } from './records.mjs';

export { prependPath } from './exec.mjs';

// Loading or validating a tasks file never needs dist/; only a real run does.
let hippoLib = null;
async function loadHippo() {
  if (hippoLib) return hippoLib;
  try {
    const [{ installJsonHooks }, { openHippoDb, closeHippoDb }, { tokensBySession }, { loadAllEntries, isInitialized }] = await Promise.all([
      import('../../dist/hooks.js'), import('../../dist/db.js'), import('../../dist/token-ledger.js'), import('../../dist/store.js'),
    ]);
    hippoLib = { installJsonHooks, openHippoDb, closeHippoDb, tokensBySession, loadAllEntries, isInitialized };
  } catch (err) {
    throw new Error(`run npm run build first (ab-run needs dist/): ${err.message}`);
  }
  return hippoLib;
}

/** Validate a tasks file. Throws on the first problem. */
export function validateTasks(spec) {
  if (!spec || !Array.isArray(spec.sequences) || spec.sequences.length === 0) throw new Error('tasks file needs a non-empty "sequences" array');
  const ids = new Set();
  for (const s of spec.sequences) {
    for (const f of ['id', 'cluster', 'repo']) if (!s[f]) throw new Error(`sequence missing "${f}"`);
    if (ids.has(s.id)) throw new Error(`duplicate sequence id ${s.id}`);
    ids.add(s.id);
    if (!Array.isArray(s.tasks) || s.tasks.length < 2) throw new Error(`sequence ${s.id} needs at least 2 tasks (the first is not scored)`);
    for (const t of s.tasks) {
      for (const f of ['id', 'baseRef', 'fixRef', 'prompt', 'test']) if (!t[f]) throw new Error(`task in ${s.id} missing "${f}"`);
      if (!Array.isArray(t.testFiles)) throw new Error(`task ${t.id} needs a "testFiles" array`);
      if (t.needsReview) throw new Error(`task ${t.id} still has needsReview: rewrite its prompt as the problem (not the fix), then delete needsReview`);
    }
  }
  return spec;
}

/** The settings hippo's installer writes for Claude Code, generated under a throwaway HOME. */
function hippoHookSettings(tmpHome) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  try {
    hippoLib.installJsonHooks('claude-code');
    return JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude', 'settings.json'), 'utf8'));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function storeLeaks(hippoRoot, lines) {
  if (!hippoLib.isInitialized(hippoRoot) || lines.length === 0) return false;
  const text = hippoLib.loadAllEntries(hippoRoot).map((e) => e.content).join('\n');
  return lines.some((l) => text.includes(l));
}

function hippoSentFor(hippoRoot, sessionId) {
  if (!sessionId || !hippoLib.isInitialized(hippoRoot)) return null;
  const db = hippoLib.openHippoDb(hippoRoot);
  try {
    const row = hippoLib.tokensBySession(db, 'default', '1970-01-01T00:00:00.000Z').find((r) => r.sessionId === sessionId);
    return row ?? { sessionId, sent: 0, skipped: 0, injections: 0 };
  } catch {
    return null;
  } finally {
    hippoLib.closeHippoDb(db);
  }
}

const rotate = (list, k) => list.map((_, i) => list[(i + k) % list.length]);

/** Every session in execution order, `{ seed, position, arm, sequence }`: position-major, arm order rotated by position + seed. */
export function planRuns(spec, arms, seedsFor = (arm) => ARM_SEEDS[arm]) {
  const steps = [];
  const maxSeed = Math.max(...arms.map(seedsFor));
  const maxTasks = Math.max(...spec.sequences.map((s) => s.tasks.length));
  for (let seed = 1; seed <= maxSeed; seed++) {
    const active = arms.filter((a) => seed <= seedsFor(a));
    for (let position = 0; position < maxTasks; position++) {
      for (const arm of rotate(active, position + seed)) {
        for (const sequence of spec.sequences) if (position < sequence.tasks.length) steps.push({ seed, position, arm, sequence });
      }
    }
  }
  return steps;
}

/** A run's first step: fresh dirs, an empty work repo, its env, settings and shim. */
function startRun(ctx, s, arm, seed) {
  const dirs = runDirs(ctx.outDir, s.id, arm, seed);
  freshRunDirs(dirs);
  git(['init', '--quiet'], dirs.work);
  for (const [k, v] of [['user.email', 'eval@localhost'], ['user.name', 'eval'], ['core.autocrlf', 'false'], ['core.eol', 'lf']]) git(['config', k, v], dirs.work);
  fs.appendFileSync(path.join(dirs.work, '.git', 'info', 'exclude'), '\n.hippo/\n');
  const env = armEnv(arm, dirs, process.env, { passEnv: ctx.passEnv });
  if (HIPPO_ARMS.has(arm)) writeHippoShim(dirs.bin, ctx.fakeHome, arm === 'A5' ? 'sham' : 'real');
  const settingsFile = path.join(ctx.outDir, 'settings', `${s.id}-${arm}-seed${seed}.json`);
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(armSettings(arm, HIPPO_ARMS.has(arm) ? hippoHookSettings(ctx.hookHome) : null), null, 2));
  return { s, arm, seed, dirs, env, settingsFile, cached: path.join(ctx.cacheDir, s.id), seenErrors: new Set(), changes: new Map(), rawDir: path.join(ctx.outDir, 'raw', s.id, arm, `seed${seed}`) };
}

/** hippo init on the stub base (A2/A5, position 0), through the child env, with LLM extraction off. */
function hippoInit(run, fakeHome) {
  const env = { ...childEnv(run.env), HOME: fakeHome, USERPROFILE: fakeHome };
  // --no-schedule: init would otherwise register a machine-wide Task Scheduler job.
  const r = sh(`"${process.execPath}" "${HIPPO_JS}" init --no-schedule`, run.dirs.work, env);
  if (r.status !== 0) throw new Error(`hippo init failed in ${run.dirs.work}: ${r.stderr.slice(-500)}`);
  const cfgPath = path.join(run.dirs.work, '.hippo', 'config.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, extraction: { enabled: false } }, null, 2));
}

const SKIPPED = { setup: 'setup failed, skipped', leak: 'a gold line is already in the store, skipped' };

function writeRecord(ctx, record) {
  ctx.records.push(record);
  fs.appendFileSync(path.join(ctx.outDir, 'runs.jsonl'), `${JSON.stringify(record)}\n`);
  const outcome = SKIPPED[record.invalid] ?? (record.resolved ? 'resolved' : 'not resolved');
  ctx.log(`${record.sequence} ${record.taskId} ${record.arm} seed${record.seed}: ${outcome}${record.costUsd ? `, $${record.costUsd.toFixed(4)}` : ''}${record.invalid ? ` (invalid: ${record.invalid})` : ''}`);
}

const sleep = (ms) => ms > 0 && Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run claude, rerunning after a plan limit once `reset` has put the checkout back. */
function runSession(ctx, run, t, reset) {
  const args = ['-p', '--output-format', 'json', '--setting-sources', 'project', '--settings', JSON.stringify(run.settingsFile), '--strict-mcp-config', '--permission-mode', ctx.permissionMode];
  if (ctx.model) args.push('--model', ctx.model);
  if (ctx.maxBudgetUsd) args.push('--max-budget-usd', String(ctx.maxBudgetUsd));
  // SHORTCUT: 15-minute polls up to 24h; parse the reset time if waits get long.
  for (let attempt = 1; ; attempt++) {
    const cc = sh(`${ctx.claude} ${args.join(' ')}`, run.dirs.work, run.env, 60 * 60_000, t.prompt);
    let result = null;
    try {
      result = JSON.parse(cc.stdout.trim().split('\n').filter(Boolean).pop() ?? '');
    } catch {
      result = null;
    }
    if (!isUsageLimit(result, `${cc.stdout}\n${cc.stderr}`)) return { cc, result, limitRetries: attempt - 1 };
    fs.writeFileSync(path.join(run.rawDir, `${t.id}.limit${attempt}.txt`), `${cc.stdout}\n${cc.stderr}`.slice(-20000));
    // Prereg: a run that stops partway is abandoned and never analysed, so a limit that outlasts every wait ends the run.
    if (attempt > ctx.limitMaxWaits) throw new Error(`${run.s.id} ${t.id} ${run.arm} seed${run.seed}: still at the plan limit after ${ctx.limitMaxWaits} waits`);
    ctx.log(`${run.s.id} ${t.id} ${run.arm} seed${run.seed}: plan limit hit, waiting ${Math.round(ctx.limitWaitMs / 60_000)} min (attempt ${attempt})`);
    sleep(ctx.limitWaitMs);
    reset();
  }
}

/** One step: prepare the checkout, skip the session if the step is void before it starts, else run, grade and record it. */
function runTask(ctx, run, position, order) {
  const { s, arm, seed, dirs, env, rawDir } = run;
  const t = s.tasks[position];
  const work = dirs.work;
  const prepare = () => ({ commit: checkoutBase(run.cached, work, s.id, t), setup: t.setup ? sh(t.setup, work, childEnv(env)) : null });
  const { commit, setup } = prepare();
  const base = { taskId: t.id, cluster: s.cluster, sequence: s.id, position, order, scored: position > 0, arm, seed, model: ctx.model, claudeVersion: ctx.claudeVersion, startedAt: new Date().toISOString(), baseCommit: commit };
  const meta = { envKeys: Object.keys(env).sort(), passEnv: ctx.passEnv };
  fs.mkdirSync(rawDir, { recursive: true });
  if (setup && setup.status !== 0) {
    // No claude session, no hidden-test run: a failed setup is not a genuine "not resolved". Carry never ran, so its counts are null.
    fs.writeFileSync(path.join(rawDir, `${t.id}.setup.txt`), `${setup.stdout}\n${setup.stderr}`.slice(-20000));
    writeRecord(ctx, skippedRecord(base, { agentError: `setup failed (exit ${setup.status})`, leak: false, invalid: 'setup', carryMerges: null, carryUnionMerges: null, carryDeleteKept: null, homesAtStart: null, ...meta }));
    return;
  }
  const hippoRoot = path.join(work, '.hippo');
  // Setup's own writes are part of the baseline, so they are never counted as the agent's and never carried.
  const baseline = instructionSnapshot(work);
  // Init waits for the first step whose setup passed, so a skipped first task cannot leave A2/A5 without hippo.
  if (HIPPO_ARMS.has(arm) && !run.initDone) {
    hippoInit(run, ctx.fakeHome);
    run.initDone = true;
  }
  const carry = CARRY_ARMS.has(arm) ? applyInstructions(work, run.changes, baseline, path.join(ctx.outDir, 'tmp')) : { carryMerges: 0, carryUnionMerges: 0, carryDeleteKept: 0 };
  const homesAtStart = run.sessionRan ? null : homeFiles(dirs);
  if (HIPPO_ARMS.has(arm) && storeLeaks(hippoRoot, goldLines(run.cached, t))) {
    // The leak is known before the session, so a session the analysis voids is never run and costs no plan usage.
    run.changes = instructionDelta(baseline, instructionSnapshot(work));
    writeRecord(ctx, skippedRecord(base, { agentError: null, leak: true, invalid: 'leak', ...carry, homesAtStart, ...meta }));
    return;
  }
  const preSession = instructionSnapshot(work);
  const session = runSession(ctx, run, t, () => {
    // SHORTCUT: restores instruction files only; store and auto memory wait for the E3 surface restore, so the analyzer voids limitRetries > 0 in A1/A2/A5
    const again = prepare().setup;
    if (again && again.status !== 0) throw new Error(`${s.id} ${t.id} ${arm} seed${seed}: setup failed on the usage-limit rerun (exit ${again.status})`);
    restoreInstructions(work, preSession);
  });
  run.sessionRan = true;
  const graded = gradeSession(ctx, run, t, baseline, session);
  writeRecord(ctx, { ...base, ...graded, ...carry, homesAtStart, ...meta });
}

/** After a session: let hippo's capture settle, take the carry delta, run the hidden tests and read the result into record fields. */
function gradeSession(ctx, run, t, baseline, { cc, result, limitRetries }) {
  const { arm, dirs, env, rawDir } = run;
  const work = dirs.work;
  fs.writeFileSync(path.join(rawDir, `${t.id}.json`), cc.stdout || JSON.stringify({ error: cc.stderr.slice(0, 4000), status: cc.status }));
  // SessionEnd runs capture and sleep in a background worker; let it finish.
  if (HIPPO_ARMS.has(arm)) sleep(ctx.settleMs);
  if (CARRY_ARMS.has(arm)) run.changes = instructionDelta(baseline, instructionSnapshot(work));
  writeHiddenTests(run.cached, work, t);
  const test = sh(t.test, work, childEnv(env));
  fs.writeFileSync(path.join(rawDir, `${t.id}.test.txt`), `${test.stdout}\n${test.stderr}`.slice(-20000));
  const sessionId = result?.session_id ?? null;
  const transcript = findTranscript(path.join(dirs.claudeConfig, 'projects'), sessionId);
  // A valid record always has integer work counts, so a session without its transcript is void like one without a result.
  const invalid = result === null ? 'no-result' : (transcript === null ? 'no-transcript' : null);
  const counted = invalid === null;
  return {
    resolved: counted && test.status === 0,
    usage: counted ? usageFromResult(result) : null, costUsd: counted ? result.total_cost_usd ?? null : null, turns: counted ? result.num_turns ?? null : null,
    ...transcriptWork(transcript, run.seenErrors),
    sessionId, transcriptFound: transcript !== null,
    agentError: result === null ? `claude exited ${cc.status}: ${cc.stderr.slice(0, 300)}` : (result.is_error ? result.subtype ?? 'error' : null),
    hippo: HIPPO_ARMS.has(arm) ? hippoSentFor(path.join(work, '.hippo'), sessionId) : null,
    leak: false, invalid, limitRetries,
  };
}

/** The expected cells, written before any session so the analysis can tell a run cut off in lockstep. */
function writePlan(outDir, steps) {
  fs.mkdirSync(outDir, { recursive: true });
  const cells = steps.map((st) => ({ seed: st.seed, position: st.position, arm: st.arm, sequence: st.sequence.id, taskId: st.sequence.tasks[st.position].id, repo: st.sequence.repo }));
  fs.writeFileSync(path.join(outDir, 'plan.json'), `${JSON.stringify(cells, null, 2)}\n`);
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
  };
  // checkoutBase refuses a symlinked instruction file; finding it here saves abandoning a lockstep run midway.
  for (const s of spec.sequences) {
    const cached = path.join(ctx.cacheDir, s.id);
    if (!fs.existsSync(cached)) {
      fs.mkdirSync(ctx.cacheDir, { recursive: true });
      execFileSync('git', ['clone', '--quiet', s.repo, cached], { stdio: 'ignore' });
    }
    for (const t of s.tasks) assertNoInstructionLinks(cached, s.id, t);
  }
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
    const { seed, position, arm, sequence: s } = step;
    const key = `${s.id}|${arm}|${seed}`;
    if (!state.has(key)) state.set(key, startRun(ctx, s, arm, seed));
    runTask(ctx, state.get(key), position, order);
    progress.last = `step ${order}: ${s.id} ${s.tasks[position].id} ${arm} seed${seed}`;
  }
  return ctx.records;
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
  const spec = validateTasks(JSON.parse(fs.readFileSync(tasksFile, 'utf8')));
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
  if (mode === 'real' && stopAt) throw new Error('Z0_ANCESTOR_STOP is set; it is only honoured for --dry-run and --check-homes. Unset it for a real run.');
  if (mode === 'real' && !process.env[TOKEN_KEY]) throw new Error('run `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN');
  assertNoAncestorInstructions(out, { stopAt });
  console.log(`${steps.length} steps (Claude Code sessions) in lockstep; seeds ${arms.map((a) => `${a}:${seeds ?? ARM_SEEDS[a]}`).join(' ')}.`);
  if (mode === 'dry') {
    writePlan(out, steps);
    for (const [i, r] of steps.entries()) console.log(`  ${i} seed${r.seed} pos${r.position} ${r.arm} ${r.sequence.id}/${r.sequence.tasks[r.position].id}`);
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
