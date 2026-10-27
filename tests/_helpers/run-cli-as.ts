// Runs `hippo <args>` through runCli in this process with the cwd, env and stdin a spawned child would get,
// so a test that checks rows and bytes skips the node start-up and module load each spawn pays.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { vi } from 'vitest';
import { runCli } from '../../src/cli.js';
import { defaultBusyWaitMs, setDefaultBusyWaitMs } from '../../src/db/busy.js';
import { withHookStdin } from './hook-stdin.js';
import { runInProcess, type InProcessResult } from './run-in-process.js';
import { HIPPO_BIN } from './hippo-bin.js';

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

/** A hook that writes fd 1 or 2 with writeSync, past the stream buffer, lands in the streams runInProcess reads. */
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
  // runCli sets the process lock wait as a root; a spawned hippo would keep it to itself.
  const savedBusyWait = defaultBusyWaitMs();
  // A verb that starts a worker re-runs process.argv[1], which must be the bin a spawned hippo was started from.
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
    setDefaultBusyWaitMs(savedBusyWait);
  }
}

/** `runCliAs` that returns stdout and throws on a non-zero exit, as execFileSync did for a spawned hippo. */
export async function runCliOut(args: readonly string[], opts: CliAsOptions = {}): Promise<string> {
  const r = await runCliAs(args, opts);
  if (r.status !== 0) throw new Error(`hippo ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}
