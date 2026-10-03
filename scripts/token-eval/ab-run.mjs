#!/usr/bin/env node
// Z0 Claude Code runner: arms A0, A1, A2 and A5 in lockstep, one record per (task, arm, seed) for ab-analyze.mjs.
// Protocol: docs/evals/2026-09-29-z0-built-in-memory-prereg.md. Usage, tasks file and fairness: benchmarks/token-eval/README.md.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HIPPO_JS, sh, git } from './exec.mjs';
import { ARMS, ARM_SEEDS, HIPPO_ARMS, CARRY_ARMS, armSettings, armEnv, childEnv, writeHippoShim, startupTools } from './arms.mjs';
import { runDirs, freshRunDirs, homeFiles } from './homes.mjs';
import { checkoutBase, instructionSnapshot, instructionDelta, applyInstructions, restoreInstructions, writeHiddenTests, goldLines } from './workspace.mjs';

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

const LIMIT_RE = /usage limit|hit your (usage )?limit|limit reached|rate_limit_error|overloaded_error/i;

/** A plan usage limit or an overload: not a task failure, so the session is rerun. */
export function isUsageLimit(result, output) {
  // The run's own --max-budget-usd or turn cap is a real outcome, never retried.
  if (String(result?.subtype ?? '').startsWith('error_max')) return false;
  return (result === null || Boolean(result.is_error)) && LIMIT_RE.test(output);
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

function findTranscript(projectsDir, sessionId) {
  if (!sessionId || !fs.existsSync(projectsDir)) return null;
  for (const p of fs.readdirSync(projectsDir)) {
    const f = path.join(projectsDir, p, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const BASH_READ = /^(?:cat|head|tail|less|more|grep|rg)(?=\s|$)|^sed\s+-n(?=\s|$)/;
// `type` reads a file only in PowerShell; in Git Bash it is a builtin that names a command.
const PS_READ = /^(?:get-content|select-string|type|gc)(?=\s|$)/i;

/** Whether a shell command has a read command word at its start or after `|`, `;`, `&&`, `||` or `(`. */
function isShellRead(tool, command) {
  return String(command ?? '').split(/\|\||&&|[|;(]/).some((part) => {
    const word = part.trim();
    return BASH_READ.test(word) || (tool === 'PowerShell' && PS_READ.test(word));
  });
}

/** Tool calls, file reads (Read, Grep and shell reads; `shellReads` is the shell share) and repeated error signatures. */
export function transcriptWork(file, seenErrors) {
  const work = { toolCalls: 0, fileReads: 0, shellReads: 0, repeatedErrors: 0 };
  if (!file) return null;
  const seenTools = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const block of content) {
      if (block.type === 'tool_use' && !seenTools.has(block.id)) {
        seenTools.add(block.id);
        work.toolCalls++;
        if (block.name === 'Read' || block.name === 'Grep') work.fileReads++;
        else if (SHELL_TOOLS.has(block.name) && isShellRead(block.name, block.input?.command)) {
          work.fileReads++;
          work.shellReads++;
        }
      } else if (block.type === 'tool_result' && block.is_error) {
        const text = Array.isArray(block.content) ? block.content.map((c) => c.text ?? '').join(' ') : String(block.content ?? '');
        const sig = text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);
        if (!sig) continue;
        if (seenErrors.has(sig)) work.repeatedErrors++;
        else seenErrors.add(sig);
      }
    }
  }
  return work;
}

/** Sum Claude Code's per-model usage; the top-level `usage` can read zero when a run stops on its budget cap, so it is only a fallback. */
export function usageFromResult(result) {
  const usage = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
  const models = result.modelUsage ?? {};
  for (const m of Object.values(models)) {
    usage.inputTokens += Number(m.inputTokens) || 0;
    usage.cacheWriteTokens += Number(m.cacheCreationInputTokens) || 0;
    usage.cacheReadTokens += Number(m.cacheReadInputTokens) || 0;
    usage.outputTokens += Number(m.outputTokens) || 0;
  }
  if (Object.keys(models).length === 0 && result.usage) {
    usage.inputTokens = Number(result.usage.input_tokens) || 0;
    usage.cacheWriteTokens = Number(result.usage.cache_creation_input_tokens) || 0;
    usage.cacheReadTokens = Number(result.usage.cache_read_input_tokens) || 0;
    usage.outputTokens = Number(result.usage.output_tokens) || 0;
  }
  return usage;
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

function writeRecord(ctx, record) {
  ctx.records.push(record);
  fs.appendFileSync(path.join(ctx.outDir, 'runs.jsonl'), `${JSON.stringify(record)}\n`);
  ctx.log(`${record.sequence} ${record.taskId} ${record.arm} seed${record.seed}: ${record.invalid === 'setup' ? 'setup failed, skipped' : (record.resolved ? 'resolved' : 'not resolved')}${record.costUsd ? `, $${record.costUsd.toFixed(4)}` : ''}${record.invalid ? ` (invalid: ${record.invalid})` : ''}`);
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
    if (!isUsageLimit(result, `${cc.stdout}\n${cc.stderr}`) || attempt > ctx.limitMaxWaits) return { cc, result, limitRetries: attempt - 1 };
    fs.writeFileSync(path.join(run.rawDir, `${t.id}.limit${attempt}.txt`), `${cc.stdout}\n${cc.stderr}`.slice(-20000));
    ctx.log(`${run.s.id} ${t.id} ${run.arm} seed${run.seed}: plan limit hit, waiting ${Math.round(ctx.limitWaitMs / 60_000)} min (attempt ${attempt})`);
    sleep(ctx.limitWaitMs);
    reset();
  }
}

/** One step: prepare the checkout, run the session, grade, record. */
function runTask(ctx, run, position, order) {
  const { s, arm, seed, dirs, env, rawDir } = run;
  const t = s.tasks[position];
  const work = dirs.work;
  const base = { taskId: t.id, cluster: s.cluster, sequence: s.id, position, order, scored: position > 0, arm, seed, model: ctx.model, claudeVersion: ctx.claudeVersion, startedAt: new Date().toISOString() };
  const prepare = () => ({ commit: checkoutBase(run.cached, work, s.id, t), setup: t.setup ? sh(t.setup, work, childEnv(env)) : null });
  const { commit, setup } = prepare();
  fs.mkdirSync(rawDir, { recursive: true });
  if (setup && setup.status !== 0) {
    // No claude session, no hidden-test run: a failed setup is not a genuine "not resolved".
    fs.writeFileSync(path.join(rawDir, `${t.id}.setup.txt`), `${setup.stdout}\n${setup.stderr}`.slice(-20000));
    writeRecord(ctx, { ...base, baseCommit: commit, resolved: false, usage: null, costUsd: null, turns: null, sessionId: null, transcriptFound: false, agentError: `setup failed (exit ${setup.status})`, hippo: null, leak: false, invalid: 'setup' });
    return;
  }
  const hippoRoot = path.join(work, '.hippo');
  // Setup's own writes are part of the baseline, so they are never counted as the agent's and never carried.
  const baseline = instructionSnapshot(work);
  if (position === 0 && HIPPO_ARMS.has(arm)) hippoInit(run, ctx.fakeHome);
  const carry = CARRY_ARMS.has(arm) && position > 0 ? applyInstructions(work, run.changes, baseline, path.join(ctx.outDir, 'tmp')) : { carryMerges: 0, carryUnionMerges: 0, carryDeleteKept: 0 };
  const preSession = instructionSnapshot(work);
  const leak = HIPPO_ARMS.has(arm) ? storeLeaks(hippoRoot, goldLines(run.cached, t)) : false;
  const homesAtStart = position === 0 ? homeFiles(dirs) : null;
  const { cc, result, limitRetries } = runSession(ctx, run, t, () => {
    prepare();
    restoreInstructions(work, preSession);
  });
  fs.writeFileSync(path.join(rawDir, `${t.id}.json`), cc.stdout || JSON.stringify({ error: cc.stderr.slice(0, 4000), status: cc.status }));
  // SessionEnd runs capture and sleep in a background worker; let it finish.
  if (HIPPO_ARMS.has(arm)) sleep(ctx.settleMs);
  if (CARRY_ARMS.has(arm)) run.changes = instructionDelta(baseline, instructionSnapshot(work));

  writeHiddenTests(run.cached, work, t);
  const test = sh(t.test, work, childEnv(env));
  fs.writeFileSync(path.join(rawDir, `${t.id}.test.txt`), `${test.stdout}\n${test.stderr}`.slice(-20000));
  const sessionId = result?.session_id ?? null;
  const transcript = findTranscript(path.join(dirs.claudeConfig, 'projects'), sessionId);
  writeRecord(ctx, {
    ...base, baseCommit: commit,
    resolved: result !== null && test.status === 0,
    usage: result ? usageFromResult(result) : null, costUsd: result?.total_cost_usd ?? null, turns: result?.num_turns ?? null,
    ...transcriptWork(transcript, run.seenErrors),
    sessionId, transcriptFound: transcript !== null,
    agentError: result === null ? `claude exited ${cc.status}: ${cc.stderr.slice(0, 300)}` : (result.is_error ? result.subtype ?? 'error' : null),
    hippo: HIPPO_ARMS.has(arm) ? hippoSentFor(hippoRoot, sessionId) : null,
    leak, invalid: result === null ? 'no-result' : (leak ? 'leak' : null),
    limitRetries, ...carry, homesAtStart, envKeys: Object.keys(env).sort(), passEnv: ctx.passEnv,
  });
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
  const warmDir = path.join(outDir, 'warmup');
  const warmEnv = armEnv('A0', { ...runDirs(warmDir, '', '', 0), claudeConfig: path.join(warmDir, 'claude-config') }, process.env, { passEnv });
  ctx.claudeVersion = sh(`${claude} --version`, outDir, warmEnv).stdout.trim() || null;
  if (warmup) {
    // One unrecorded call, so the first recorded run does not alone pay the cold prompt-cache write.
    fs.mkdirSync(warmEnv.CLAUDE_CONFIG_DIR, { recursive: true });
    const warmArgs = ['-p', '--output-format', 'json', '--setting-sources', 'project', '--strict-mcp-config', ...(ctx.model ? ['--model', ctx.model] : [])];
    sh(`${claude} ${warmArgs.join(' ')}`, warmDir, warmEnv, 10 * 60_000, 'Reply with the single word OK.');
  }
  const state = new Map();
  for (const [order, step] of planRuns(spec, arms, seeds ? () => seeds : (arm) => ARM_SEEDS[arm]).entries()) {
    const { seed, position, arm, sequence: s } = step;
    const cached = path.join(ctx.cacheDir, s.id);
    if (!fs.existsSync(cached)) {
      fs.mkdirSync(ctx.cacheDir, { recursive: true });
      execFileSync('git', ['clone', '--quiet', s.repo, cached], { stdio: 'ignore' });
    }
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
  const seeds = flag('--seeds', null) === null ? null : Number(flag('--seeds', null));
  const passEnv = argv.flatMap((a, i) => (a === '--pass-env' && i + 1 < argv.length ? [argv[i + 1]] : []));
  const steps = planRuns(spec, arms, seeds ? () => seeds : (arm) => ARM_SEEDS[arm]);
  console.log(`${steps.length} steps (Claude Code sessions) in lockstep; seeds ${arms.map((a) => `${a}:${seeds ?? ARM_SEEDS[a]}`).join(' ')}.`);
  if (argv.includes('--dry-run')) {
    for (const [i, r] of steps.entries()) console.log(`  ${i} seed${r.seed} pos${r.position} ${r.arm} ${r.sequence.id}/${r.sequence.tasks[r.position].id}`);
    return;
  }
  const out = path.resolve(outDir);
  await runAll({
    spec, arms, seeds, outDir: out, passEnv,
    model: flag('--model', null),
    claudeBin: flag('--claude-bin', 'claude'),
    maxBudgetUsd: flag('--max-budget-usd', null),
    settleMs: Number(flag('--settle-ms', '5000')),
    warmup: !argv.includes('--no-warmup'),
    permissionMode: flag('--permission-mode', 'bypassPermissions'),
  });
  console.log(`\nRecords: ${path.join(out, 'runs.jsonl')}\nAnalyze: node scripts/token-eval/ab-analyze.mjs --runs ${path.join(out, 'runs.jsonl')} --control A0 --prices prices.json`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
