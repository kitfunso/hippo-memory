// Runs `hippo <args>` through runCli in this process with the cwd, env and stdin a spawned child would get,
// so a test that checks rows and bytes skips the node start-up and module load each spawn pays.
import { runCli } from '../../src/cli.js';
import { _resetAblationCacheForTests } from '../../src/core/ablation.js';
import { _resetSharedStoreCacheForTests } from '../../src/core/config.js';
import { _resetLossAversionRatioCacheForTests } from '../../src/core/memory.js';
import { _resetLogOnceForTests } from '../../src/util/log.js';
import { withHookStdin } from './hook-stdin.js';
import { runInProcess, type InProcessResult } from './run-in-process.js';

export interface CliAsOptions {
  readonly cwd?: string;
  /** The whole env the verb sees, as a spawned child's would be; omitted keeps this process's env. */
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
}

function replaceEnv(next: NodeJS.ProcessEnv): void {
  // Mutated in place: a module that kept a reference to process.env must see the swap too.
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(next)) if (value !== undefined) process.env[key] = value;
}

function resetProcessCaches(): void {
  _resetAblationCacheForTests();
  _resetLossAversionRatioCacheForTests();
  _resetSharedStoreCacheForTests();
  _resetLogOnceForTests();
}

/** A verb that sets process.exitCode and returns exits with it, as a spawned hippo would; this reads it and puts the prior one back. */
export async function runCliAs(args: readonly string[], opts: CliAsOptions = {}): Promise<InProcessResult> {
  const savedCwd = process.cwd();
  const savedEnv = { ...process.env };
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  if (opts.cwd) process.chdir(opts.cwd);
  if (opts.env) replaceEnv(opts.env);
  // A spawned hippo reads its env afresh and starts with nothing cached, so one run cannot leak into the next.
  resetProcessCaches();
  try {
    const r = await withHookStdin(opts.input, () => runInProcess(() => runCli(['node', 'hippo', ...args])));
    return { ...r, status: r.status || Number(process.exitCode ?? 0) };
  } finally {
    process.exitCode = priorExitCode;
    process.chdir(savedCwd);
    if (opts.env) replaceEnv(savedEnv);
    resetProcessCaches();
  }
}
