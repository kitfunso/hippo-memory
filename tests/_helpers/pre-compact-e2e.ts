// Scratch env and verb runners the pre-compact e2e tests share.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expect } from 'vitest';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { hippoRun } from '../_helpers/spawn-hippo.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import type { InProcessResult } from '../_helpers/run-in-process.js';

// Verbs run through runCli in this process; the first case of each verb spawns the local built CLI, never a global install.

/**
 * Scratch $HOME + $HIPPO_HOME + tmp cwd for every test — never a repo
 * checkout (PROBATION: feedback_hippo_probe_scratch_stores). HOME/USERPROFILE
 * are overridden too so `resolveLastSessionTranscript`'s auto-discovery under
 * ~/.claude/projects/ and `defaultSleepLogPath()` can never see the real
 * developer machine.
 */
export function withScratchEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-precompact-e2e-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HIPPO_HOME: dir,
    HOME: dir,
    USERPROFILE: dir,
  };
  return { dir, env };
}

export function transcriptJsonl(entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** Backdates the active snapshot's updated_at directly in sqlite, to test compact-resume's age gate without waiting real minutes. */
export function backdateActiveSnapshot(hippoRoot: string, tenantId: string, minutesAgo: number): void {
  const db = openHippoDb(hippoRoot);
  try {
    const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    db.prepare(`UPDATE task_snapshots SET updated_at = ? WHERE tenant_id = ? AND status = 'active'`).run(at, tenantId);
  } finally {
    closeHippoDb(db);
  }
}

export function runHippo(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<InProcessResult> {
  return runCliAs(args, { cwd, env, input });
}

export async function spawnHippo(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<InProcessResult> {
  const r = hippoRun(args, { cwd, env, input });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

export async function initHippo(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runHippo(['init', '--no-hooks', '--no-schedule', '--no-learn'], cwd, env);
  expect(result.status).toBe(0);
}
