import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { vi } from 'vitest';
import { runCli } from '../../src/cli.js';
import { withHookStdin } from './hook-stdin.js';
import { runInProcess, type InProcessResult } from './run-in-process.js';
import { HIPPO_BIN } from './hippo-bin.js';

export interface CliAsOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
}

function replaceEnv(next: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(next)) if (value !== undefined) process.env[key] = value;
}

function routeStdFdWrites(): () => void {
  // SAFETY: one signature that covers both writeSync overloads, so a passed-through call keeps its arguments as given.
  const write = fs.writeSync.bind(fs) as (fd: number, ...rest: unknown[]) => number;
  const spy = vi.spyOn(fs, 'writeSync').mockImplementation((fd: number, ...rest: unknown[]) => {
    if (fd !== 1 && fd !== 2) return write(fd, ...rest);
    const text = String(rest[0]);
    (fd === 1 ? process.stdout : process.stderr).write(text);
    return Buffer.byteLength(text);
  });
  syncBuiltinESMExports();
  return () => {
    spy.mockRestore();
    syncBuiltinESMExports();
  };
}

/** `hippo <args>` in this process, with its exit code as a spawned hippo would have ended with it. */
export async function runCliAs(args: readonly string[], opts: CliAsOptions = {}): Promise<InProcessResult> {
  const savedArgv = process.argv;
  const savedCwd = process.cwd();
  const savedEnv = { ...process.env };
  const argv = [process.execPath, HIPPO_BIN, ...args];
  process.argv = argv;
  if (opts.cwd) process.chdir(opts.cwd);
  if (opts.env) replaceEnv(opts.env);
  const unrouteFdWrites = routeStdFdWrites();
  try {
    return await withHookStdin(opts.input, () => runInProcess(() => runCli(argv)));
  } finally {
    unrouteFdWrites();
    process.argv = savedArgv;
    process.chdir(savedCwd);
    if (opts.env) replaceEnv(savedEnv);
  }
}

/** `runCliAs` that returns stdout and throws on a non-zero exit, as execFileSync did for a spawned hippo. */
export async function runCliOut(args: readonly string[], opts: CliAsOptions = {}): Promise<string> {
  const r = await runCliAs(args, opts);
  if (r.status !== 0) throw new Error(`hippo ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}
