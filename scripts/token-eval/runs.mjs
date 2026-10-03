// One (sequence, arm, seed) run: its dirs, env, settings and hippo store, plus the shared context and record writer.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HIPPO_JS, sh, git } from './exec.mjs';
import { HIPPO_ARMS, armSettings, armEnv, childEnv, writeHippoShim, startupTools } from './arms.mjs';
import { runDirs, freshRunDirs } from './homes.mjs';
import { stubBaseCommit, assertNoInstructionLinks } from './workspace.mjs';
import { lessonIndex } from './lessons.mjs';
import { assertNoPhraseInStub } from './leaks.mjs';

// Loading or validating a tasks file never needs dist/; only a real run does.
let hippoLib = null;
export async function loadHippo() {
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

/** A hippo store's entries; none when it was never initialised. */
export const storeEntries = (hippoRoot) => (hippoLib.isInitialized(hippoRoot) ? hippoLib.loadAllEntries(hippoRoot) : []);

export function storeLeaks(hippoRoot, lines) {
  if (lines.length === 0) return false;
  const text = storeEntries(hippoRoot).map((e) => e.content).join('\n');
  return lines.some((l) => text.includes(l));
}

/** Hippo's sent tokens summed over every session id of the cell, the resume's own id included; keyed by session 1's id. */
export function hippoSentFor(hippoRoot, sessionIds) {
  if (!sessionIds.length || !hippoLib.isInitialized(hippoRoot)) return null;
  const db = hippoLib.openHippoDb(hippoRoot);
  try {
    const rows = hippoLib.tokensBySession(db, 'default', '1970-01-01T00:00:00.000Z').filter((r) => sessionIds.includes(r.sessionId));
    const total = (k) => rows.reduce((n, r) => n + r[k], 0);
    return { sessionId: sessionIds[0], sent: total('sent'), skipped: total('skipped'), injections: total('injections') };
  } catch {
    return null;
  } finally {
    hippoLib.closeHippoDb(db);
  }
}

/** Clone each sequence's repo into the cache, then refuse any task to be run (a screen's screen tasks too) whose stub tree checkoutBase would refuse or that holds a key phrase. */
export function cacheTaskRepos(spec, cacheDir, { screen = false } = {}) {
  // Finding a symlinked instruction file here saves abandoning a lockstep run midway.
  for (const s of spec.sequences) {
    const cached = path.join(cacheDir, s.id);
    if (!fs.existsSync(cached)) {
      fs.mkdirSync(cacheDir, { recursive: true });
      git(['clone', '--quiet', s.repo, cached]);
    }
    const screens = screen ? (spec.families ?? []).filter((f) => f.sequence === s.id && f.screen).map((f) => f.screen) : [];
    for (const t of [...s.tasks, ...screens]) {
      const stub = stubBaseCommit(cached, t.baseRef);
      assertNoInstructionLinks(cached, s.id, t, stub);
      assertNoPhraseInStub(spec, cached, s.id, t, stub);
    }
  }
}

/** The shared context of a run or a screen: tools, limits, the lesson index, the cached repos, the Claude version, one warm-up call. */
export async function openContext(opts) {
  await loadHippo();
  const { spec, outDir, claudeBin = 'claude', warmup = true, passEnv = [] } = opts;
  const { claude } = startupTools(claudeBin, process.env);
  fs.mkdirSync(outDir, { recursive: true });
  // outDir as HOME: hippo's store walk stops at HOME, so it must be an ancestor of every workspace.
  const ctx = {
    outDir, passEnv, claude, records: [], fakeHome: outDir, hookHome: path.join(outDir, 'hook-home'), cacheDir: path.join(outDir, 'repo-cache'),
    model: opts.model ?? null, maxBudgetUsd: opts.maxBudgetUsd ?? null, settleMs: opts.settleMs ?? 5000, permissionMode: opts.permissionMode ?? 'bypassPermissions',
    limitWaitMs: opts.limitWaitMs ?? 15 * 60_000, sessionTimeoutMs: opts.sessionTimeoutMs ?? 60 * 60_000, limitMaxWaits: opts.limitMaxWaits ?? 96, log: opts.log ?? console.log,
    lessons: lessonIndex(spec.families ?? []), recordsFile: opts.recordsFile ?? 'runs.jsonl', progress: opts.progress ?? {},
    ledgerFile: path.join(outDir, 'ledger.jsonl'), snapDir: path.join(outDir, 'snap'), canaries: opts.canaries ?? [], foreignDirs: [], leakedRuns: new Map(),
  };
  cacheTaskRepos(spec, ctx.cacheDir, { screen: opts.screen === true });
  const warmDir = path.join(outDir, 'warmup');
  const warmEnv = armEnv('A0', { ...runDirs(warmDir, '', '', 0), claudeConfig: path.join(warmDir, 'claude-config') }, process.env, { passEnv });
  ctx.claudeVersion = sh(`${claude} --version`, outDir, warmEnv).stdout.trim() || null;
  if (warmup) {
    // One unrecorded call, so the first recorded run does not alone pay the cold prompt-cache write.
    fs.mkdirSync(warmEnv.CLAUDE_CONFIG_DIR, { recursive: true });
    const warmArgs = ['-p', '--output-format', 'json', '--setting-sources', 'project', '--strict-mcp-config', ...(ctx.model ? ['--model', ctx.model] : [])];
    sh(`${claude} ${warmArgs.join(' ')}`, warmDir, warmEnv, 10 * 60_000, 'Reply with the single word OK.');
  }
  return ctx;
}

/** A run's first step: fresh dirs under `name` (the sequence id unless a screen names its own), env, settings, shim; checkoutBase makes the work repo. */
export function startRun(ctx, s, arm, seed, name = s.id) {
  const dirs = runDirs(ctx.outDir, name, arm, seed);
  freshRunDirs(dirs);
  const env = armEnv(arm, dirs, process.env, { passEnv: ctx.passEnv });
  if (HIPPO_ARMS.has(arm)) writeHippoShim(dirs.bin, ctx.fakeHome, arm === 'A5' ? 'sham' : 'real');
  const settingsFile = path.join(ctx.outDir, 'settings', `${name}-${arm}-seed${seed}.json`);
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(armSettings(arm, HIPPO_ARMS.has(arm) ? hippoHookSettings(ctx.hookHome) : null), null, 2));
  return {
    s, arm, seed, dirs, env, settingsFile, cached: path.join(ctx.cacheDir, s.id), seenErrors: new Set(), changes: new Map(), taught: [], teachSeen: new Set(), captured: new Map(),
    rawDir: path.join(ctx.outDir, 'raw', name, arm, `seed${seed}`), runName: name,
  };
}

/** hippo init on the stub base (A2/A5, first task that runs), through the child env, with LLM extraction off. */
export function hippoInit(run, fakeHome) {
  const env = { ...childEnv(run.env), HOME: fakeHome, USERPROFILE: fakeHome };
  // --no-schedule: init would otherwise register a machine-wide Task Scheduler job.
  const r = sh(`"${process.execPath}" "${HIPPO_JS}" init --no-schedule`, run.dirs.work, env);
  if (r.status !== 0) throw new Error(`hippo init failed in ${run.dirs.work}: ${r.stderr.slice(-500)}`);
  const cfgPath = path.join(run.dirs.work, '.hippo', 'config.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, extraction: { enabled: false } }, null, 2));
}

const SKIPPED = { setup: 'setup failed, skipped', leak: 'a leak voids this sequence and seed, skipped', 'ancestor-instructions': 'an instruction file sits above work/, skipped' };

export function writeRecord(ctx, record) {
  ctx.records.push(record);
  fs.appendFileSync(path.join(ctx.outDir, ctx.recordsFile),`${JSON.stringify(record)}\n`);
  const outcome = SKIPPED[record.invalid] ?? (record.resolved ? 'resolved' : 'not resolved');
  ctx.log(`${record.sequence} ${record.taskId} ${record.arm} seed${record.seed}: ${outcome}${record.costUsd ? `, $${record.costUsd.toFixed(4)}` : ''}${record.invalid ? ` (invalid: ${record.invalid})` : ''}`);
}

// Async, so a run inside a test worker never blocks the worker's RPC with its parent.
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Hippo arms only: SessionEnd runs capture and sleep in a background worker, so let it finish before the next turn reads the store. */
export async function settle(ctx, run, cell, when) {
  if (!HIPPO_ARMS.has(run.arm)) return;
  await sleep(ctx.settleMs);
  fs.appendFileSync(path.join(run.dirs.root, 'settle.log'), `${cell} ${when}\n`);
}
