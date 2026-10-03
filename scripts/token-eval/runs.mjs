// One (sequence, arm, seed) run: its dirs, env, settings and hippo store, plus the record writer every task shares.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HIPPO_JS, sh } from './exec.mjs';
import { HIPPO_ARMS, armSettings, armEnv, childEnv, writeHippoShim } from './arms.mjs';
import { runDirs, freshRunDirs } from './homes.mjs';

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

export function storeLeaks(hippoRoot, lines) {
  if (!hippoLib.isInitialized(hippoRoot) || lines.length === 0) return false;
  const text = hippoLib.loadAllEntries(hippoRoot).map((e) => e.content).join('\n');
  return lines.some((l) => text.includes(l));
}

export function hippoSentFor(hippoRoot, sessionId) {
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

/** A run's first step: fresh dirs, its env, settings and shim; checkoutBase makes the work repo. */
export function startRun(ctx, s, arm, seed) {
  const dirs = runDirs(ctx.outDir, s.id, arm, seed);
  freshRunDirs(dirs);
  const env = armEnv(arm, dirs, process.env, { passEnv: ctx.passEnv });
  if (HIPPO_ARMS.has(arm)) writeHippoShim(dirs.bin, ctx.fakeHome, arm === 'A5' ? 'sham' : 'real');
  const settingsFile = path.join(ctx.outDir, 'settings', `${s.id}-${arm}-seed${seed}.json`);
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(armSettings(arm, HIPPO_ARMS.has(arm) ? hippoHookSettings(ctx.hookHome) : null), null, 2));
  return {
    s, arm, seed, dirs, env, settingsFile, cached: path.join(ctx.cacheDir, s.id), seenErrors: new Set(), changes: new Map(), taught: [],
    rawDir: path.join(ctx.outDir, 'raw', s.id, arm, `seed${seed}`),
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

const SKIPPED = { setup: 'setup failed, skipped', leak: 'a gold line is already in the store, skipped', 'ancestor-instructions': 'an instruction file sits above work/, skipped' };

export function writeRecord(ctx, record) {
  ctx.records.push(record);
  fs.appendFileSync(path.join(ctx.outDir, 'runs.jsonl'), `${JSON.stringify(record)}\n`);
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
