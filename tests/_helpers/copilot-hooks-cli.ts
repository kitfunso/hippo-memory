// Scratch folders, pins, config patches and log waits the Copilot hook CLI tests share.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, beforeEach, vi } from 'vitest';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { readDeliveryEvents, type DeliveryEventRow } from '../_helpers/delivery-events.js';
import type { JsonValue } from '../../src/util/json.js';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { hippoRun } from '../_helpers/spawn-hippo.js';
import { waitFor } from '../_helpers/wait-for.js';
import { copilotScratch, type CopilotScratch } from '../_helpers/copilot-hooks.js';
import { initStore } from '../../src/store/sqlite/handles.js';

export const runHippo = (args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string) =>
  hippoRun(args, { cwd, env, input });
export const CONTEXT_ARGS = ['context', '--pinned-only', '--include-recent', '5', '--format', 'copilot'];
export const PROJ_PIN = 'The proj auth client keeps its retry budget in src/auth/retry.ts';
export const GLOBAL_PIN = 'Global pin: prefer small pull requests over large ones';
export const SESSION = 'copilot-sess-1';
export const WORKER_DONE = `active snapshot(s) for session ${SESSION}`;
// Forward slashes, since NODE_OPTIONS reads a backslash as an escape.
export const RECORD_SPAWN = path.resolve(__dirname, '..', '_helpers', 'record-spawn.cjs').split(path.sep).join('/');
export const CURSOR_SAVE_FAULT = path
  .resolve(__dirname, '..', '_helpers', 'cursor-save-fault.cjs')
  .split(path.sep)
  .join('/');

export let s: CopilotScratch;
export const hippo = (args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string) =>
  runCliAs(args, { cwd, env, input });

// Seeding runs the CLI entry in process: remember is setup here, and only the hook runs need a real process.
export async function pin(text: string, global: boolean): Promise<void> {
  const { HIPPO_HOME, HOME, USERPROFILE, COPILOT_HOME, APPDATA, XDG_CONFIG_HOME } = s.env;
  for (const [k, v] of Object.entries({ HIPPO_HOME, HOME, USERPROFILE, COPILOT_HOME, APPDATA, XDG_CONFIG_HOME })) {
    vi.stubEnv(k, v);
  }
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'HIPPO_SESSION_ID']) vi.stubEnv(k, undefined);
  const cwd = process.cwd();
  process.chdir(s.proj);
  try {
    const r = await runInProcess(() =>
      runCli(['node', 'hippo', 'remember', text, '--pin', ...(global ? ['--global'] : [])]),
    );
    expect(r.status, r.stderr).toBe(0);
  } finally {
    process.chdir(cwd);
    vi.unstubAllEnvs();
  }
}

export function patchConfig(hippoRoot: string, patch: { [key: string]: JsonValue }): void {
  const file = path.join(hippoRoot, 'config.json');
  // SAFETY: config.json is a JSON object hippo init wrote, or absent.
  const config = (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}) as { [key: string]: JsonValue };
  fs.writeFileSync(file, JSON.stringify({ ...config, ...patch }));
}

export function enableLedger(hippoRoot: string): void {
  patchConfig(hippoRoot, { deliveryLedger: { enabled: true } });
}

export function deliveryEvents(sessionId: string): DeliveryEventRow[] {
  const db = openHippoDb(s.hippoRoot);
  try {
    return readDeliveryEvents(db, 'default', sessionId);
  } finally {
    closeHippoDb(db);
  }
}

export interface LedgerRow {
  session_id: string | null;
  event: string;
}
export interface FailureRow {
  session_id: string | null;
  tool: string | null;
  outcome: string;
  skip_rule: string | null;
}

export function rows<T>(sql: string, hippoRoot = s.hippoRoot): T[] {
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: every caller names the columns its row type declares.
    return db.prepare(sql).all() as T[];
  } finally {
    closeHippoDb(db);
  }
}

/** A git-marked folder with its own project store, as a second project the hook may run from. */
export function initStoreIn(dir: string): string {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  initStore(path.join(dir, '.hippo'));
  return path.join(dir, '.hippo');
}

// The detached workers are real processes, so a wait gets a generous bound under load.
export const WORKER_WAIT_MS = 25_000;

export const readLog = (logFile: string): string => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');

export async function waitForLog(logFile: string, marker: string, timeoutMs = WORKER_WAIT_MS): Promise<string> {
  await waitFor(() => readLog(logFile).includes(marker), { what: `log line ${marker}`, timeoutMs });
  return readLog(logFile);
}

export function useCopilotScratch() {
  beforeEach(() => {
    s = copilotScratch();
    initStore(s.hippoRoot);
    initStore(s.globalRoot);
  });
}

export function removeScratch() {
  try {
    fs.rmSync(s.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // The detached session-end worker can still hold a Windows lock; a leftover scratch dir is harmless.
  }
}
